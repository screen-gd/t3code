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
 * messages, then the session keeps receiving activity from other clients, such as
 * the runs T3 starts through the REST API. v2 does not forward that activity yet.
 */
export const watchHopliteThreadChat = (input: {
  readonly socket: Socket.Socket;
  readonly hopliteThreadId: string;
}): Stream.Stream<CloudTaskChatEvent, AcpError.AcpError> =>
  watchAcpThreadChat({
    stdio: socketStdio(input.socket),
    hopliteThreadId: input.hopliteThreadId,
  });

export const watchAcpThreadChat = (input: {
  readonly stdio: Effect.Effect<AcpProtocol.AcpStdio, never, Scope.Scope>;
  readonly hopliteThreadId: string;
}): Stream.Stream<CloudTaskChatEvent, AcpError.AcpError> =>
  Stream.callback<CloudTaskChatEvent, AcpError.AcpError>((queue) =>
    Effect.gen(function* () {
      const acp = yield* AcpClient.make(yield* input.stdio);
      const reduce = makeChatReducer();
      yield* acp.handleSessionUpdate((notification) =>
        notification.sessionId === input.hopliteThreadId
          ? Queue.offerAll(queue, reduce(notification.update)).pipe(Effect.asVoid)
          : Effect.void,
      );
      yield* acp.agent.initialize({ protocolVersion: 1, clientCapabilities: {} });
      // The key on the socket identifies the caller, but Hoplite still requires protocol login.
      yield* acp.agent.authenticate({ methodId: "hoplite-api-key" });
      yield* acp.agent.loadSession({
        sessionId: input.hopliteThreadId,
        cwd: "/",
        mcpServers: [],
        _meta: { hoplite: { replayLimit: REPLAY_LIMIT } },
      });
      yield* Queue.offer(queue, { _tag: "live" });
    }).pipe(
      Effect.catch((error) => Queue.fail(queue, error)),
      Effect.andThen(Effect.never),
    ),
  );

/** Resolves a delegated task to its Hoplite thread, so clients can only read tasks they can see here. */
export const watchTaskChat = <E>(
  deps: {
    readonly readTask: (
      input: HopliteCloudWatchTaskChatInput,
    ) => Effect.Effect<OrchestrationV2Subagent | undefined, E>;
    readonly watchThreadChat: (
      hopliteThreadId: string,
    ) => Stream.Stream<CloudTaskChatEvent, HopliteCloudError>;
  },
  input: HopliteCloudWatchTaskChatInput,
): Stream.Stream<CloudTaskChatEvent, HopliteCloudError> =>
  Stream.unwrap(
    deps.readTask(input).pipe(
      Effect.orElseSucceed(() => undefined),
      Effect.map((task) =>
        task?.remoteChild?.service === "hoplite"
          ? deps.watchThreadChat(task.remoteChild.threadId)
          : Stream.fail(
              new HopliteCloudError({
                code: task === undefined ? "not_found" : "unsupported",
                message:
                  task === undefined
                    ? "This thread has no such task."
                    : "Only tasks delegated to Hoplite show their chat here.",
              }),
            ),
      ),
    ),
  );
