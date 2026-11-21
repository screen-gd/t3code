import { expect, it } from "vite-plus/test";

import { applyCloudTaskChatEvent, EMPTY_CLOUD_TASK_CHAT } from "./hopliteCloud.ts";

it("builds a cloud task's chat from its change stream", () => {
  const chat = [
    {
      _tag: "upsert" as const,
      entry: { _tag: "message" as const, id: "a", role: "assistant" as const, text: "Hel" },
    },
    {
      _tag: "upsert" as const,
      entry: { _tag: "tool" as const, id: "t", title: "Read", status: "pending" as const },
    },
    { _tag: "append" as const, id: "a", text: "lo" },
    {
      _tag: "upsert" as const,
      entry: { _tag: "tool" as const, id: "t", title: "Read", status: "completed" as const },
    },
    // An append for an entry that is not a message is ignored.
    { _tag: "append" as const, id: "t", text: "x" },
    { _tag: "live" as const },
  ].reduce(applyCloudTaskChatEvent, EMPTY_CLOUD_TASK_CHAT);
  expect(chat).toEqual({
    live: true,
    running: null,
    entries: [
      { _tag: "message", id: "a", role: "assistant", text: "Hello" },
      { _tag: "tool", id: "t", title: "Read", status: "completed" },
    ],
  });
  const replaced = { _tag: "message" as const, id: "b", role: "user" as const, text: "Hi" };
  expect(applyCloudTaskChatEvent(chat, { _tag: "replace", entries: [replaced] })).toEqual({
    live: true,
    running: null,
    entries: [replaced],
  });
});

it("follows whether the task runs from live events that say so", () => {
  const running = applyCloudTaskChatEvent(EMPTY_CLOUD_TASK_CHAT, { _tag: "live", running: true });
  expect(running).toEqual({ entries: [], live: true, running: true });
  expect(applyCloudTaskChatEvent(running, { _tag: "live", running: true })).toBe(running);
  // An older server's live event says nothing about the run.
  expect(applyCloudTaskChatEvent(running, { _tag: "live" })).toBe(running);
  expect(applyCloudTaskChatEvent(running, { _tag: "live", running: false })).toEqual({
    entries: [],
    live: true,
    running: false,
  });
});
