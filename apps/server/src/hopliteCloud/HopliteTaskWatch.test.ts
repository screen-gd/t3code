import { assert, it } from "@effect/vitest";
import {
  type HopliteCloudQuestion,
  type HopliteCloudTask,
  NodeId,
  type OrchestrationV2Run,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2Subagent,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
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

const activeRun = {
  id: RunId.make("run:parent"),
  ordinal: 1,
  status: "running",
  rootNodeId: NodeId.make("node:parent"),
} as unknown as OrchestrationV2Run;

// Hoplite's run-state for thr_1 is whatever `run` holds when the sweep reads it.
const makeHarness = (stored = new Map<string, Uint8Array>()) => {
  const state: {
    run: HopliteCloud.HopliteRun | null;
    reply: string | null;
    /** The caller thread's runs; an active one gets a card. */
    runs: ReadonlyArray<OrchestrationV2Run>;
    cards: ReadonlyArray<OrchestrationV2Subagent>;
    stops: number;
    questions: ReadonlyArray<HopliteCloudQuestion>;
    answers: Array<string>;
  } = { run: null, reply: null, runs: [], cards: [], stops: 0, questions: [], answers: [] };
  const dispatched: Array<OrchestrationV2ServerCommand> = [];
  const layer = HopliteTaskWatch.layer.pipe(
    Layer.provide(
      Layer.mock(HopliteCloud.HopliteCloud)({
        startTask: () => Effect.succeed({ task: { ...task, status: "queued" }, runId: "run_1" }),
        readTask: () =>
          Effect.sync(() => ({ task: { ...task, latestReply: state.reply }, run: state.run })),
        sendMessage: () => Effect.succeed({ runId: null }),
        stopTask: () => Effect.sync(() => (state.stops++, task)),
        listQuestions: () => Effect.sync(() => state.questions),
        answerQuestion: (input) =>
          Effect.sync(() => (state.answers.push(input.answer), { runId: null })),
      }),
    ),
    Layer.provide(
      Layer.mock(Orchestrator.OrchestratorV2)({
        dispatch: (command) =>
          Effect.sync(() => {
            dispatched.push(command);
            const storedEvents =
              command.type === "delegated_task.remote.request"
                ? [{ event: { type: "subagent.updated", payload: { id: "node:card" } } }]
                : [];
            return { sequence: dispatched.length, storedEvents } as never;
          }),
        getThreadRecords: () =>
          Effect.sync(() => ({ runs: state.runs, subagents: state.cards }) as never),
      }),
    ),
    Layer.provide(
      Layer.succeed(
        SecureRandom.SecureRandom,
        SecureRandom.make((size) => new Uint8Array(size).fill(dispatched.length)),
      ),
    ),
    Layer.provide(
      Layer.mock(ProjectionStore.ProjectionStoreV2)({
        getOpenRemoteDelegatedTasks: Effect.sync(() =>
          state.cards.map((card) => ({ parentThreadId: card.threadId, taskId: card.id })),
        ),
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

it.effect(
  "a task started in a running turn is a card there, completed when its run settles",
  () => {
    const harness = makeHarness();
    harness.state.runs = [activeRun];
    return Effect.gen(function* () {
      const watch = yield* HopliteTaskWatch.HopliteTaskWatch;
      yield* watch.startTask({ prompt: "Fix login" }, "t3-thread");
      const [request] = harness.dispatched;
      assert.strictEqual(request?.type, "delegated_task.remote.request");
      if (request?.type !== "delegated_task.remote.request") return;
      assert.deepStrictEqual(request.remoteChild, {
        environmentId: request.remoteChild.environmentId,
        threadId: ThreadId.make("thr_1"),
        label: "Hoplite",
        service: "hoplite",
        runId: RunId.make("run_1"),
      });
      assert.strictEqual(request.parentRunId, activeRun.id);

      harness.state.run = { id: "run_1", status: "failed" };
      yield* watch.sweep;
      yield* watch.sweep;
      assert.deepStrictEqual(wakes(harness.dispatched), []);
      assert.deepStrictEqual(
        harness.dispatched.flatMap((command) =>
          command.type === "delegated_task.remote.complete"
            ? [[command.taskId, command.status, command.stoppedThere]]
            : [],
        ),
        [[NodeId.make("node:card"), "failed", "ran-out"]],
      );
    }).pipe(Effect.provide(harness.layer));
  },
);

it.effect("a card cancelled in T3 stops its Hoplite task", () => {
  const harness = makeHarness();
  harness.state.cards = [
    {
      id: NodeId.make("node:card"),
      threadId: ThreadId.make("t3-thread"),
      status: "cancelled",
      result: "Cancelled.",
      remoteChild: { threadId: ThreadId.make("thr_1"), service: "hoplite" },
    } as unknown as OrchestrationV2Subagent,
  ];
  return Effect.gen(function* () {
    const watch = yield* HopliteTaskWatch.HopliteTaskWatch;
    yield* watch.sweep;
    assert.strictEqual(harness.state.stops, 1);
    const [complete] = harness.dispatched;
    assert.strictEqual(complete?.type, "delegated_task.remote.complete");
    if (complete?.type !== "delegated_task.remote.complete") return;
    assert.deepStrictEqual(
      [complete.status, complete.result, complete.stoppedThere],
      ["cancelled", "Cancelled.", "stopped"],
    );
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

it.effect("a task's question wakes its caller once, and an answer waits for the next one", () => {
  const harness = makeHarness();
  const question = (questionId: string, text: string): HopliteCloudQuestion => ({
    questionId,
    parts: [{ question: text, options: [{ label: "Yes", description: "Safer rollout" }] }],
  });
  return Effect.gen(function* () {
    const watch = yield* HopliteTaskWatch.HopliteTaskWatch;
    yield* watch.startTask({ prompt: "Fix login" }, "t3-thread");
    harness.state.run = { id: "run_1", status: "waiting" };
    harness.state.questions = [question("q_1", "Keep the old session cookie?")];
    yield* watch.sweep;
    const [asked] = wakes(harness.dispatched);
    assert.strictEqual(asked?.outcome, "updated");
    assert.include(
      asked?.text,
      "Question q_1:\nKeep the old session cookie?\n- Yes: Safer rollout",
    );

    const answered = yield* watch.answerQuestion(
      { threadId: "thr_1", questionId: "q_1", answer: "Yes" },
      "t3-thread",
    );
    assert.deepStrictEqual(harness.state.answers, ["Yes"]);
    assert.equal(answered.next, HopliteTaskWatch.HOPLITE_TASK_WAKES_NEXT);

    // Hoplite has not taken the answer yet, so the same question is still pending.
    yield* watch.sweep;
    assert.equal(wakes(harness.dispatched).length, 1);

    harness.state.questions = [question("q_2", "Also drop the legacy route?")];
    yield* watch.sweep;
    assert.include(wakes(harness.dispatched)[1]?.text, "Question q_2:");
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
