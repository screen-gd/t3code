import { assert, it } from "@effect/vitest";
import { EnvironmentId, NodeId, type OrchestrationV2Subagent, ThreadId } from "@t3tools/contracts";
import type * as AcpProtocol from "effect-acp/protocol";
import type * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Sink from "effect/Sink";
import * as Stdio from "effect/Stdio";
import * as Stream from "effect/Stream";

import {
  makeChatReducer,
  watchAcpThreadChat,
  watchTaskChat,
  withRunning,
} from "./HopliteTaskChat.ts";

const text = (value: string) => ({ type: "text" as const, text: value });

it("folds replayed and streamed ACP updates into chat changes", () => {
  const reduce = makeChatReducer();
  const events = [
    reduce({ sessionUpdate: "user_message_chunk", content: text("Fix login"), messageId: "m1" }),
    reduce({ sessionUpdate: "agent_message_chunk", content: text("Looking") }),
    reduce({ sessionUpdate: "agent_message_chunk", content: text(" now") }),
    reduce({ sessionUpdate: "tool_call", toolCallId: "t1", title: "Read auth.ts" }),
    reduce({ sessionUpdate: "tool_call_update", toolCallId: "t1", status: "cancelled" }),
    reduce({ sessionUpdate: "agent_message_chunk", content: text("Done") }),
  ].flat();
  assert.deepStrictEqual(events, [
    { _tag: "upsert", entry: { _tag: "message", id: "m1", role: "user", text: "Fix login" } },
    {
      _tag: "upsert",
      entry: { _tag: "message", id: "assistant-1", role: "assistant", text: "Looking" },
    },
    { _tag: "append", id: "assistant-1", text: " now" },
    { _tag: "upsert", entry: { _tag: "tool", id: "t1", title: "Read auth.ts", status: "pending" } },
    // An update without a title keeps the call's title.
    { _tag: "upsert", entry: { _tag: "tool", id: "t1", title: "Read auth.ts", status: "failed" } },
    // A tool call ends the message, so later text starts a new one.
    {
      _tag: "upsert",
      entry: { _tag: "message", id: "assistant-2", role: "assistant", text: "Done" },
    },
  ]);
});

/** An ACP v1 agent that, like Hoplite, refuses session methods until the connection logs in. */
const fakeHopliteAgent = Effect.gen(function* () {
  const input = yield* Queue.unbounded<Uint8Array, Cause.Done>();
  const methods: Array<string> = [];
  const encoder = new TextEncoder();
  const send = (message: unknown) =>
    Queue.offer(input, encoder.encode(`${JSON.stringify(message)}\n`));
  let authenticated = false;
  let loads = 0;
  let pending = "";
  const handle = (message: { id?: number; method?: string; params?: unknown }) => {
    if (message.method === undefined || message.id === undefined) return Effect.void;
    methods.push(message.method);
    switch (message.method) {
      case "initialize":
        return send({
          jsonrpc: "2.0",
          id: message.id,
          result: {
            protocolVersion: 1,
            agentCapabilities: { loadSession: true },
            authMethods: [{ id: "hoplite-api-key", name: "API key" }],
          },
        });
      case "authenticate":
        authenticated =
          (message.params as { methodId?: string } | undefined)?.methodId === "hoplite-api-key";
        return send({ jsonrpc: "2.0", id: message.id, result: {} });
      case "session/load": {
        if (!authenticated)
          return send({
            jsonrpc: "2.0",
            id: message.id,
            error: { code: -32000, message: "Authentication required" },
          });
        loads += 1;
        // Each load replays the history; a message sent meanwhile appears from the second load.
        const updates = [
          { sessionUpdate: "agent_message_chunk", content: text("Hi") },
          ...(loads > 1
            ? [{ sessionUpdate: "user_message_chunk", content: text("Follow up"), messageId: "m2" }]
            : []),
        ];
        return Effect.forEach(
          updates,
          (update) =>
            send({
              jsonrpc: "2.0",
              method: "session/update",
              params: { sessionId: "thr_remote", update },
            }),
          { discard: true },
        ).pipe(Effect.andThen(send({ jsonrpc: "2.0", id: message.id, result: {} })));
      }
      default:
        return send({
          jsonrpc: "2.0",
          id: message.id,
          error: { code: -32601, message: "Method not found" },
        });
    }
  };
  const decoder = new TextDecoder();
  const stdio: AcpProtocol.AcpStdio = Stdio.make({
    args: Effect.succeed([]),
    stdin: Stream.fromQueue(input),
    stdout: () =>
      Sink.forEach((chunk: string | Uint8Array) => {
        pending += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
        const lines = pending.split("\n");
        pending = lines.pop() ?? "";
        return Effect.forEach(
          lines.filter((line) => line.length > 0),
          (line) => handle(JSON.parse(line)),
          { discard: true },
        );
      }),
    stderr: () => Sink.drain,
  });
  return { stdio, methods };
});

it.effect("logs in to Hoplite's ACP connection before loading the thread", () =>
  Effect.gen(function* () {
    const agent = yield* fakeHopliteAgent;
    const events = yield* watchAcpThreadChat({
      stdio: Effect.succeed(agent.stdio),
      hopliteThreadId: "thr_remote",
      activity: Stream.empty,
    }).pipe(Stream.take(2), Stream.runCollect);
    assert.deepStrictEqual(agent.methods, ["initialize", "authenticate", "session/load"]);
    assert.deepStrictEqual(events, [
      {
        _tag: "upsert",
        entry: { _tag: "message", id: "assistant-1", role: "assistant", text: "Hi" },
      },
      { _tag: "live" },
    ]);
  }),
);

const subagent = (service: "hoplite" | "daytona" | undefined, threadId = "thr_remote") =>
  ({
    id: NodeId.make("task-1"),
    threadId: ThreadId.make("parent"),
    remoteChild:
      service === undefined
        ? undefined
        : {
            environmentId: EnvironmentId.make(service),
            threadId: ThreadId.make(threadId),
            label: service,
            service,
          },
  }) as unknown as OrchestrationV2Subagent;

it.effect("streams only tasks delegated to a cloud sandbox from this thread", () =>
  Effect.gen(function* () {
    const watched: Array<string> = [];
    const watch = (task: OrchestrationV2Subagent | undefined) =>
      watchTaskChat(
        {
          readTask: () => Effect.succeed(task),
          watchThreadChat: (taskId) => {
            watched.push(taskId);
            return Stream.make({ _tag: "live" as const });
          },
        },
        { threadId: ThreadId.make("parent"), taskId: NodeId.make("task-1") },
      ).pipe(
        Stream.runCollect,
        Effect.flip,
        Effect.map((error) => error.code),
      );

    assert.strictEqual(yield* watch(undefined), "not_found");
    assert.strictEqual(yield* watch(subagent(undefined)), "unsupported");
    assert.deepStrictEqual(watched, []);

    const events = yield* watchTaskChat(
      {
        readTask: () => Effect.succeed(subagent("hoplite")),
        watchThreadChat: (taskId) => {
          watched.push(taskId);
          return Stream.make({ _tag: "live" as const });
        },
      },
      { threadId: ThreadId.make("parent"), taskId: NodeId.make("task-1") },
    ).pipe(Stream.runCollect);
    assert.deepStrictEqual(events, [{ _tag: "live" }]);
    // A sandbox task resolves to its provider:id thread the same way.
    yield* watchTaskChat(
      {
        readTask: () => Effect.succeed(subagent("daytona", "daytona:dsb-1")),
        watchThreadChat: (taskId) => {
          watched.push(taskId);
          return Stream.make({ _tag: "live" as const });
        },
      },
      { threadId: ThreadId.make("parent"), taskId: NodeId.make("task-1") },
    ).pipe(Stream.runCollect);
    assert.deepStrictEqual(watched, ["thr_remote", "daytona:dsb-1"]);
  }),
);

it.effect("reloads the chat on the same connection when the task has activity", () =>
  Effect.gen(function* () {
    const agent = yield* fakeHopliteAgent;
    const activity = yield* Queue.unbounded<void>();
    let acquired = 0;
    const collected = yield* watchAcpThreadChat({
      stdio: Effect.sync(() => {
        acquired += 1;
        return agent.stdio;
      }),
      hopliteThreadId: "thr_remote",
      activity: Stream.fromQueue(activity),
    }).pipe(Stream.take(4), Stream.runCollect, Effect.forkChild);
    yield* Queue.offer(activity, undefined);
    const events = yield* Fiber.join(collected);
    assert.strictEqual(acquired, 1);
    assert.deepStrictEqual(agent.methods, [
      "initialize",
      "authenticate",
      "session/load",
      "session/load",
    ]);
    assert.deepStrictEqual(events, [
      {
        _tag: "upsert",
        entry: { _tag: "message", id: "assistant-1", role: "assistant", text: "Hi" },
      },
      { _tag: "live" },
      {
        _tag: "replace",
        entries: [
          { _tag: "message", id: "assistant-1", role: "assistant", text: "Hi" },
          { _tag: "message", id: "m2", role: "user", text: "Follow up" },
        ],
      },
      { _tag: "live" },
    ]);
  }),
);

it.effect("marks each live event with whether the run is going when it passes", () =>
  Effect.gen(function* () {
    const states = [true, false];
    const upsert = {
      _tag: "upsert" as const,
      entry: { _tag: "message" as const, id: "m1", role: "user" as const, text: "Fix login" },
    };
    const events = yield* withRunning(
      Stream.make(upsert, { _tag: "live" as const }, { _tag: "live" as const }),
      Effect.sync(() => states.shift() ?? false),
    ).pipe(Stream.runCollect);
    assert.deepStrictEqual(events, [
      upsert,
      { _tag: "live", running: true },
      { _tag: "live", running: false },
    ]);
  }),
);
