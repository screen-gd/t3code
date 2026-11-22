import { expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import { AuthSettingsWriteScope, EnvironmentId, type AuthSessionState } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import { Atom, AtomRegistry, AsyncResult } from "effect/reactivity";
import { EnvironmentRegistry } from "../connection/registry.ts";

import {
  applyCloudTaskChatEvent,
  EMPTY_CLOUD_TASK_CHAT,
  createHopliteCloudEnvironmentAtoms,
} from "./hopliteCloud.ts";

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

vi.mock("./session.ts", () => ({
  createEnvironmentSessionAtoms: () => ({ sessionStateAtom: sessions }),
}));
vi.mock("../rpc/client.ts", async (importOriginal) => {
  const original = await importOriginal<typeof import("../rpc/client.ts")>();
  return {
    ...original,
    requestGuarded: (_tag: unknown, input: unknown) =>
      Effect.sync(() => {
        response.calls.push(input);
      }).pipe(Effect.andThen(Effect.suspend(() => response.wait))),
  };
});
const response: { calls: Array<unknown>; wait: Effect.Effect<void> } = {
  calls: [],
  wait: Effect.void,
};
const sessions = Atom.family((_id: EnvironmentId) =>
  Atom.make<AsyncResult.AsyncResult<AuthSessionState>>(AsyncResult.initial()),
);

it.effect("saves and clears credentials independently for each sandbox agent", () =>
  Effect.gen(function* () {
    const environmentId = EnvironmentId.make("test");
    const runtime = Atom.runtime(
      Layer.succeed(EnvironmentRegistry, {
        run: (_id, effect) => effect,
      } as EnvironmentRegistry["Service"]),
    );
    const commands = createHopliteCloudEnvironmentAtoms(runtime);
    const registry = AtomRegistry.make();
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        registry.dispose();
        response.wait = Effect.void;
        response.calls = [];
      }),
    );
    registry.set(
      sessions(environmentId),
      AsyncResult.success({
        authenticated: true,
        auth: {
          policy: "remote-reachable",
          bootstrapMethods: [],
          sessionMethods: [],
          sessionCookieName: "test",
        },
        scopes: [AuthSettingsWriteScope],
        permissions: [AuthSettingsWriteScope],
      }),
    );
    for (const kind of ["set", "clear"] as const) {
      const release = yield* Deferred.make<void>();
      response.calls = [];
      response.wait = Deferred.await(release);
      const run = (agent: "claude" | "codex") =>
        kind === "set"
          ? commands.setAgentCredential.run(registry, {
              environmentId,
              input: { agent, credential: "test-credential" },
            })
          : commands.clearAgentCredential.run(registry, { environmentId, input: { agent } });
      const claude = yield* Effect.forkChild(Effect.exit(run("claude")), {
        startImmediately: true,
      });
      const duplicate = yield* Effect.forkChild(Effect.exit(run("claude")), {
        startImmediately: true,
      });
      const codex = yield* Effect.forkChild(Effect.exit(run("codex")), { startImmediately: true });
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(claude);
      yield* Fiber.join(duplicate);
      yield* Fiber.join(codex);
      expect(response.calls).toEqual(
        kind === "set"
          ? [
              { agent: "claude", credential: "test-credential" },
              { agent: "codex", credential: "test-credential" },
            ]
          : [{ agent: "claude" }, { agent: "codex" }],
      );
    }
  }),
);
