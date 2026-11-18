import { assert, it } from "@effect/vitest";
import {
  type HopliteCloudTask,
  type OrchestrationV2ServerCommand,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as HopliteCloud from "./HopliteCloudService.ts";
import * as HopliteTaskWatch from "./HopliteTaskWatch.ts";

const task: HopliteCloudTask = {
  threadId: "thr_1",
  projectId: "prj_1",
  title: "Fix login",
  status: "running",
  latestReply: null,
  pullRequestUrl: null,
};

// Hoplite's run-state for thr_1 is whatever `run` holds when the sweep reads it.
const makeHarness = (stored = new Map<string, Uint8Array>()) => {
  const state: { run: HopliteCloud.HopliteRun | null; reply: string | null } = {
    run: null,
    reply: null,
  };
  const dispatched: Array<OrchestrationV2ServerCommand> = [];
  const layer = HopliteTaskWatch.layer.pipe(
    Layer.provide(
      Layer.mock(HopliteCloud.HopliteCloud)({
        startTask: () => Effect.succeed({ task: { ...task, status: "queued" }, runId: "run_1" }),
        readTask: () =>
          Effect.sync(() => ({ task: { ...task, latestReply: state.reply }, run: state.run })),
        sendMessage: () => Effect.succeed({ runId: null }),
        stopTask: () => Effect.succeed(task),
      }),
    ),
    Layer.provide(
      Layer.mock(Orchestrator.OrchestratorV2)({
        dispatch: (command) =>
          Effect.sync(() => {
            dispatched.push(command);
            return { sequence: dispatched.length, storedEvents: [] };
          }),
      }),
    ),
    Layer.provide(
      Layer.succeed(
        ServerSecretStore.ServerSecretStore,
        ServerSecretStore.ServerSecretStore.of({
          get: (name) => Effect.sync(() => Option.fromNullishOr(stored.get(name))),
          set: (name, value) => Effect.sync(() => void stored.set(name, value)),
          create: (name, value) => Effect.sync(() => void stored.set(name, value)),
          getOrCreateRandom: () => Effect.die("unused"),
          remove: (name) => Effect.sync(() => void stored.delete(name)),
        }),
      ),
    ),
  );
  return { state, dispatched, stored, layer };
};

const wakes = (dispatched: ReadonlyArray<OrchestrationV2ServerCommand>) =>
  dispatched.flatMap((command) =>
    command.type === "message.dispatch"
      ? [{ threadId: command.threadId, text: command.text, outcome: command.notification?.outcome }]
      : [],
  );

it.effect("an agent's task wakes its thread once, when the run it started settles", () => {
  const harness = makeHarness();
  return Effect.gen(function* () {
    const watch = yield* HopliteTaskWatch.HopliteTaskWatch;
    const started = yield* watch.startTask({ prompt: "Fix login" }, "t3-thread");
    assert.equal(started.next, HopliteTaskWatch.HOPLITE_TASK_WAKES_NEXT);

    harness.state.run = { id: "run_1", status: "running" };
    yield* watch.sweep;
    assert.deepStrictEqual(wakes(harness.dispatched), []);

    harness.state.run = { id: "run_1", status: "completed" };
    harness.state.reply = "Tests pass.";
    yield* watch.sweep;
    yield* watch.sweep;
    assert.deepStrictEqual(wakes(harness.dispatched), [
      {
        threadId: ThreadId.make("t3-thread"),
        text: 'Hoplite task thr_1 ("Fix login") finished.\n\nLatest reply:\nTests pass.',
        outcome: "completed",
      },
    ]);
  }).pipe(Effect.provide(harness.layer));
});

it.effect("a queued follow-up waits past the finished run before it", () => {
  const harness = makeHarness();
  return Effect.gen(function* () {
    const watch = yield* HopliteTaskWatch.HopliteTaskWatch;
    harness.state.run = { id: "run_1", status: "completed" };
    yield* watch.sendMessage({ threadId: "thr_1", message: "Also fix signup" }, "t3-thread");

    // run-state still shows the earlier run until Hoplite starts the queued one.
    yield* watch.sweep;
    assert.deepStrictEqual(wakes(harness.dispatched), []);

    harness.state.run = { id: "run_2", status: "waiting" };
    yield* watch.sweep;
    assert.deepStrictEqual(
      wakes(harness.dispatched).map(({ outcome }) => outcome),
      ["updated"],
    );
  }).pipe(Effect.provide(harness.layer));
});

it.effect("stopping a task, or starting one outside an agent thread, wakes nothing", () => {
  const harness = makeHarness();
  return Effect.gen(function* () {
    const watch = yield* HopliteTaskWatch.HopliteTaskWatch;
    const unwatched = yield* watch.startTask({ prompt: "Fix login" }, undefined);
    assert.isUndefined(unwatched.next);
    yield* watch.startTask({ prompt: "Fix login" }, "t3-thread");
    yield* watch.stopTask({ threadId: "thr_1" });

    harness.state.run = { id: "run_1", status: "cancelled" };
    yield* watch.sweep;
    assert.deepStrictEqual(wakes(harness.dispatched), []);
  }).pipe(Effect.provide(harness.layer));
});

it.effect("a watch survives a server restart", () => {
  const before = makeHarness();
  return Effect.gen(function* () {
    yield* HopliteTaskWatch.HopliteTaskWatch.pipe(
      Effect.flatMap((watch) => watch.startTask({ prompt: "Fix login" }, "t3-thread")),
      Effect.provide(before.layer),
    );
    const after = makeHarness(before.stored);
    after.state.run = { id: "run_1", status: "failed" };
    yield* HopliteTaskWatch.HopliteTaskWatch.pipe(
      Effect.flatMap((watch) => watch.sweep),
      Effect.provide(after.layer),
    );
    assert.deepStrictEqual(
      wakes(after.dispatched).map(({ outcome }) => outcome),
      ["failed"],
    );
  });
});
