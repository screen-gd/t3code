import { assert, it } from "@effect/vitest";
import { EnvironmentId, NodeId, type OrchestrationV2Subagent, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import { makeChatReducer, watchTaskChat } from "./HopliteTaskChat.ts";

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

const subagent = (service: "hoplite" | "devin" | undefined) =>
  ({
    id: NodeId.make("task-1"),
    threadId: ThreadId.make("parent"),
    remoteChild:
      service === undefined
        ? undefined
        : {
            environmentId: EnvironmentId.make("hoplite"),
            threadId: ThreadId.make("thr_remote"),
            label: "Hoplite",
            service,
          },
  }) as unknown as OrchestrationV2Subagent;

it.effect("streams only tasks delegated to Hoplite from this thread", () =>
  Effect.gen(function* () {
    const watched: Array<string> = [];
    const watch = (task: OrchestrationV2Subagent | undefined) =>
      watchTaskChat(
        {
          readTask: () => Effect.succeed(task),
          watchThreadChat: (hopliteThreadId) => {
            watched.push(hopliteThreadId);
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
    assert.strictEqual(yield* watch(subagent("devin")), "unsupported");
    assert.strictEqual(yield* watch(subagent(undefined)), "unsupported");
    assert.deepStrictEqual(watched, []);

    const events = yield* watchTaskChat(
      {
        readTask: () => Effect.succeed(subagent("hoplite")),
        watchThreadChat: (hopliteThreadId) => {
          watched.push(hopliteThreadId);
          return Stream.make({ _tag: "live" as const });
        },
      },
      { threadId: ThreadId.make("parent"), taskId: NodeId.make("task-1") },
    ).pipe(Stream.runCollect);
    assert.deepStrictEqual(events, [{ _tag: "live" }]);
    assert.deepStrictEqual(watched, ["thr_remote"]);
  }),
);
