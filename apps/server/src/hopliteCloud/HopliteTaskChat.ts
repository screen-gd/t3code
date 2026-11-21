import {
  type CloudTaskChatEntry,
  type CloudTaskChatEvent,
  HopliteCloudError,
  type HopliteCloudWatchTaskChatInput,
  type OrchestrationV2Subagent,
} from "@t3tools/contracts";
import * as AcpClient from "effect-acp/client";
import * as AcpError from "effect-acp/errors";
import type * as AcpSchema from "effect-acp/compat";
import type * as AcpProtocol from "effect-acp/protocol";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import type * as Scope from "effect/Scope";
import * as Sink from "effect/Sink";
import * as Stdio from "effect/Stdio";
import * as Stream from "effect/Stream";
import * as Socket from "effect/socket/Socket";

export const HOPLITE_ACP_URL = "wss://api.hoplite.sh/acp";
/** Hoplite's cap on messages `session/load` replays; older ones stay in Hoplite. */
const REPLAY_LIMIT = 100;

type ToolEntry = Extract<CloudTaskChatEntry, { readonly _tag: "tool" }>;
type SessionUpdate = AcpSchema.SessionNotification["update"];

const toolStatus = (status: string | null | undefined, fallback: ToolEntry["status"]) => {
  switch (status) {
    case "pending":
    case "in_progress":
    case "completed":
    case "failed":
      return status;
    case "cancelled":
      return "failed";
    default:
      return fallback;
  }
};

/**
 * Folds ACP session updates into chat changes. Message chunks without a
 * `messageId` continue the previous message of the same role, until a tool
 * call or the other role interrupts it.
 */
export const makeChatReducer = () => {
  const messages = new Set<string>();
  const tools = new Map<string, ToolEntry>();
  let last: { readonly id: string; readonly role: "user" | "assistant" } | null = null;
  let generated = 0;

  const chunk = (
    role: "user" | "assistant",
    content: AcpSchema.ContentBlock,
    messageId: string | null | undefined,
  ): ReadonlyArray<CloudTaskChatEvent> => {
    if (content.type !== "text" || content.text.length === 0) return [];
    const id =
      messageId ?? (last?.role === role ? last.id : `${role}-${(generated += 1).toString()}`);
    last = { id, role };
    if (messages.has(id)) return [{ _tag: "append", id, text: content.text }];
    messages.add(id);
    return [{ _tag: "upsert", entry: { _tag: "message", id, role, text: content.text } }];
  };

  return (update: SessionUpdate): ReadonlyArray<CloudTaskChatEvent> => {
    switch (update.sessionUpdate) {
      case "user_message_chunk":
        return chunk("user", update.content, update.messageId);
      case "agent_message_chunk":
        return chunk("assistant", update.content, update.messageId);
      case "user_message":
      case "agent_message": {
        last = null;
        const role = update.sessionUpdate === "user_message" ? "user" : "assistant";
        const text = (update.content ?? [])
          .flatMap((block) => (block.type === "text" ? [block.text] : []))
          .join("");
        if (text.length === 0) return [];
        messages.add(update.messageId);
        return [{ _tag: "upsert", entry: { _tag: "message", id: update.messageId, role, text } }];
      }
      case "tool_call":
      case "tool_call_update": {
        last = null;
        const previous = tools.get(update.toolCallId);
        const entry: ToolEntry = {
          _tag: "tool",
          id: update.toolCallId,
          title: update.title ?? previous?.title ?? "Tool",
          status: toolStatus(update.status, previous?.status ?? "pending"),
        };
        tools.set(entry.id, entry);
        return [{ _tag: "upsert", entry }];
      }
      default:
        return [];
    }
  };
};

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const NEWLINE = encoder.encode("\n");

/** The ACP client speaks newline-delimited JSON; Hoplite's socket sends one message per frame. */
const socketStdio = Effect.fn("HopliteTaskChat.socketStdio")(function* (socket: Socket.Socket) {
  const writer = yield* socket.writer;
  let pending = "";
  const stdin: AcpProtocol.AcpStdio["stdin"] = Socket.toStream(socket).pipe(
    Stream.map((frame) => {
      const line = new Uint8Array(frame.length + 1);
      line.set(frame);
      line.set(NEWLINE, frame.length);
      return line;
    }),
    Stream.mapError(
      (cause) =>
        new AcpError.AcpTransportError({
          operation: "read-input-stream",
          detail: "Hoplite's ACP connection closed",
          cause,
        }),
    ),
  );
  const stdio: AcpProtocol.AcpStdio = {
    ...Stdio.make({
      args: Effect.succeed([]),
      stdin: Stream.empty,
      stdout: () =>
        Sink.forEach((chunk: string | Uint8Array) => {
          pending += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
          const lines = pending.split("\n");
          pending = lines.pop() ?? "";
          return Effect.forEach(
            lines.filter((line) => line.length > 0),
            (line) => writer.write(line).pipe(Effect.orDie),
            { discard: true },
          );
        }),
      stderr: () => Sink.drain,
    }),
    stdin,
  };
  return stdio;
});

/**
 * Streams a Hoplite thread's chat over ACP v1: `session/load` replays the latest
 * messages. Runs T3 starts through the REST API never reach the open session, so
 * the session is loaded again on the same connection after each `activity`; the
 * client never sees a half-loaded chat because a reload arrives as one `replace`.
 */
export const watchHopliteThreadChat = (input: {
  readonly socket: Socket.Socket;
  readonly hopliteThreadId: string;
  readonly activity: Stream.Stream<void>;
}): Stream.Stream<CloudTaskChatEvent, AcpError.AcpError> =>
  watchAcpThreadChat({
    stdio: socketStdio(input.socket),
    hopliteThreadId: input.hopliteThreadId,
    activity: input.activity,
  });

export const watchAcpThreadChat = (input: {
  readonly stdio: Effect.Effect<AcpProtocol.AcpStdio, never, Scope.Scope>;
  readonly hopliteThreadId: string;
  readonly activity: Stream.Stream<void>;
}): Stream.Stream<CloudTaskChatEvent, AcpError.AcpError> =>
  Stream.callback<CloudTaskChatEvent, AcpError.AcpError>((queue) =>
    Effect.gen(function* () {
      const acp = yield* AcpClient.make(yield* input.stdio);
      let reduce = makeChatReducer();
      // While a reload is in flight the replay folds here instead of reaching the
      // client, and leaves as one `replace` once `session/load` resolves.
      let replay: ReadonlyArray<CloudTaskChatEntry> | null = null;
      yield* acp.handleSessionUpdate((notification) => {
        if (notification.sessionId !== input.hopliteThreadId) return Effect.void;
        const events = reduce(notification.update);
        const buffer = replay;
        if (buffer === null) return Queue.offerAll(queue, events).pipe(Effect.asVoid);
        replay = events.reduce(foldReplay, buffer);
        return Effect.void;
      });
      yield* acp.agent.initialize({ protocolVersion: 1, clientCapabilities: {} });
      // The key on the socket identifies the caller, but Hoplite still requires protocol login.
      yield* acp.agent.authenticate({ methodId: "hoplite-api-key" });
      const session = {
        sessionId: input.hopliteThreadId,
        cwd: "/",
        mcpServers: [],
        _meta: { hoplite: { replayLimit: REPLAY_LIMIT } },
      };
      yield* acp.agent.loadSession(session);
      yield* Queue.offer(queue, { _tag: "live" });
      yield* input.activity.pipe(
        Stream.runForEach(() =>
          Effect.gen(function* () {
            reduce = makeChatReducer();
            replay = [];
            yield* acp.agent.loadSession(session);
            const entries = replay ?? [];
            replay = null;
            yield* Queue.offerAll(queue, [{ _tag: "replace", entries }, { _tag: "live" }]);
          }),
        ),
      );
    }).pipe(
      Effect.catch((error) => Queue.fail(queue, error)),
      Effect.andThen(Effect.never),
    ),
  );

const foldReplay = (
  entries: ReadonlyArray<CloudTaskChatEntry>,
  event: CloudTaskChatEvent,
): ReadonlyArray<CloudTaskChatEntry> => {
  switch (event._tag) {
    case "upsert": {
      const index = entries.findIndex((entry) => entry.id === event.entry.id);
      if (index === -1) return [...entries, event.entry];
      const next = entries.slice();
      next[index] = event.entry;
      return next;
    }
    case "append": {
      const index = entries.findLastIndex((entry) => entry.id === event.id);
      const entry = entries[index];
      if (entry?._tag !== "message") return entries;
      const next = entries.slice();
      next[index] = { ...entry, text: entry.text + event.text };
      return next;
    }
    case "replace":
      return event.entries;
    case "live":
      return entries;
  }
};

/** Marks each `live` event with whether the task's run is still going, read as it passes. */
export const withRunning = <E>(
  chat: Stream.Stream<CloudTaskChatEvent, E>,
  running: Effect.Effect<boolean>,
): Stream.Stream<CloudTaskChatEvent, E> =>
  Stream.mapEffect(chat, (event) =>
    event._tag === "live"
      ? Effect.map(running, (value): CloudTaskChatEvent => ({ _tag: "live", running: value }))
      : Effect.succeed(event),
  );

type ReadTask<E> = (
  input: HopliteCloudWatchTaskChatInput,
) => Effect.Effect<OrchestrationV2Subagent | undefined, E>;

/** A delegated task's cloud thread, so clients only reach tasks of threads they can see here. */
export const resolveCloudTask = <E>(
  readTask: ReadTask<E>,
  input: HopliteCloudWatchTaskChatInput,
): Effect.Effect<string, HopliteCloudError> =>
  readTask(input).pipe(
    Effect.orElseSucceed(() => undefined),
    Effect.flatMap((task) =>
      task?.remoteChild?.service !== undefined
        ? Effect.succeed(task.remoteChild.threadId)
        : Effect.fail(
            new HopliteCloudError({
              code: task === undefined ? "not_found" : "unsupported",
              message:
                task === undefined
                  ? "This thread has no such task."
                  : "Only tasks delegated to a cloud sandbox open here.",
            }),
          ),
    ),
  );

export const watchTaskChat = <E>(
  deps: {
    readonly readTask: ReadTask<E>;
    readonly watchThreadChat: (
      taskId: string,
    ) => Stream.Stream<CloudTaskChatEvent, HopliteCloudError>;
  },
  input: HopliteCloudWatchTaskChatInput,
): Stream.Stream<CloudTaskChatEvent, HopliteCloudError> =>
  Stream.unwrap(Effect.map(resolveCloudTask(deps.readTask, input), deps.watchThreadChat));
