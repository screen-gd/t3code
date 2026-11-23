import { assert, it } from "@effect/vitest";
import {
  HopliteCloudError,
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
    taskStatus: HopliteCloudTask["status"];
    /** The caller thread's runs; an active one gets a card. */
    runs: ReadonlyArray<OrchestrationV2Run>;
    cards: ReadonlyArray<OrchestrationV2Subagent>;
    stops: number;
    questions: ReadonlyArray<HopliteCloudQuestion>;
    questionErrors: Record<string, HopliteCloudError>;
    answers: Array<string>;
    /** Every read fails with this while set. */
    readError: HopliteCloudError | null;
    /** Run-state per run id, for reads that name one; others fall back to `run`. */
    byRun: Record<string, HopliteCloud.HopliteRun | null>;
    /** Run ids sendMessage hands back, in order; the default is none. */
    sendRunIds: Array<string | null>;
    /** Card ids recordCard returns, in order; the default is "node:card". */
    cardIds: Array<string>;
    connected: boolean;
    /** Writes of the saved watch list. */
    saves: number;
  } = {
    run: null,
    reply: null,
    taskStatus: "running",
    runs: [],
    cards: [],
    stops: 0,
    questions: [],
    questionErrors: {},
    answers: [],
    readError: null,
    byRun: {},
    sendRunIds: [],
    cardIds: [],
    connected: true,
    saves: 0,
  };
  const dispatched: Array<OrchestrationV2ServerCommand> = [];
  const layer = HopliteTaskWatch.layer.pipe(
    Layer.provide(
      Layer.mock(HopliteCloud.HopliteCloud)({
        startTask: () => Effect.succeed({ task: { ...task, status: "queued" }, runId: "run_1" }),
        connected: Effect.sync(() => state.connected),
        readTask: (input) =>
          Effect.suspend(() =>
            state.readError === null
              ? Effect.succeed({
                  task: { ...task, status: state.taskStatus, latestReply: state.reply },
                  run:
                    input?.runId !== undefined && input.runId in state.byRun
                      ? state.byRun[input.runId]!
                      : state.run,
                })
              : Effect.fail(state.readError),
          ),
        sendMessage: () => Effect.sync(() => ({ runId: state.sendRunIds.shift() ?? null })),
        stopTask: () => Effect.sync(() => (state.stops++, task)),
        listQuestions: (input) =>
          Effect.suspend(() => {
            const error = state.questionErrors[input.threadId];
            return error === undefined ? Effect.succeed(state.questions) : Effect.fail(error);
          }),
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
                ? [
                    {
                      event: {
                        type: "subagent.updated",
                        payload: { id: state.cardIds.shift() ?? "node:card" },
                      },
                    },
                  ]
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
          set: (name, value) => Effect.sync(() => (state.saves++, void stored.set(name, value))),
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

    // A sweep that changes nothing, or only counts a failed read, saves nothing.
    const saves = harness.state.saves;
    yield* watch.sweep;
    harness.state.readError = new HopliteCloudError({ code: "unavailable", message: "Down." });
    yield* watch.sweep;
    assert.strictEqual(harness.state.saves, saves);

    // Rate limiting never counts toward giving up on the task.
    harness.state.readError = new HopliteCloudError({
      code: "rate_limited",
      message: "Slow down.",
    });
    for (let sweep = 0; sweep < 10; sweep++) yield* watch.sweep;
    assert.deepStrictEqual(wakes(harness.dispatched), []);
    harness.state.readError = null;

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
    // Without a stored key there is no stop to send, so the cards are not scanned.
    harness.state.connected = false;
    yield* watch.sweep;
    assert.strictEqual(harness.state.stops, 0);

    harness.state.connected = true;
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
    // Hoplite ends the run that asked; its question stays pending behind a completed run.
    harness.state.run = { id: "run_1", status: "completed" };
    harness.state.questions = [question("q_1", "Keep the old session cookie?")];
    yield* watch.sweep;
    const [asked] = wakes(harness.dispatched);
    assert.isTrue(yield* watch.watching("thr_1"));
    yield* watch.sweep;
    assert.equal(wakes(harness.dispatched).length, 1);
    const restored = makeHarness(harness.stored);
    restored.state.run = harness.state.run;
    restored.state.questions = harness.state.questions;
    yield* Effect.gen(function* () {
      const watcher = yield* HopliteTaskWatch.HopliteTaskWatch;
      yield* watcher.sweep;
      assert.isTrue(yield* watcher.watching("thr_1"));
      assert.deepStrictEqual(wakes(restored.dispatched), []);
    }).pipe(Effect.provide(restored.layer));
    assert.strictEqual(asked?.outcome, "updated");
    assert.include(
      asked?.text,
      "Question q_1:\nKeep the old session cookie?\n- Yes: Safer rollout",
    );

    harness.state.taskStatus = "failed";
    const answered = yield* watch.answerQuestion(
      { threadId: "thr_1", questionId: "q_1", answer: "Yes" },
      "t3-thread",
    );
    assert.deepStrictEqual(harness.state.answers, ["Yes"]);
    assert.equal(answered.next, HopliteTaskWatch.HOPLITE_TASK_WAKES_NEXT);
    assert.equal(answered.status, "running");

    // The answer's run has not started, so the asking run is still the latest.
    yield* watch.sweep;
    assert.equal(wakes(harness.dispatched).length, 1);

    harness.state.run = { id: "run_2", status: "completed" };
    harness.state.questions = [question("q_2", "Also drop the legacy route?")];
    yield* watch.sweep;
    assert.include(wakes(harness.dispatched)[1]?.text, "Question q_2:");
  }).pipe(Effect.provide(harness.layer));
});

it.effect("a later run's question does not keep an earlier card waiting", () => {
  const harness = makeHarness();
  harness.state.runs = [activeRun];
  harness.state.cardIds = ["node:first", "node:second"];
  harness.state.sendRunIds = ["run_1", "run_2"];
  return Effect.gen(function* () {
    const watch = yield* HopliteTaskWatch.HopliteTaskWatch;
    yield* watch.sendMessage({ threadId: "thr_1", message: "First" }, "t3-thread");
    yield* watch.sendMessage({ threadId: "thr_1", message: "Second" }, "t3-thread");
    harness.state.byRun = {
      run_1: { id: "run_1", status: "completed" },
      run_2: { id: "run_2", status: "running" },
    };
    harness.state.questions = [
      {
        questionId: "q_2",
        runId: "run_2",
        parts: [{ question: "Which colour?", options: [{ label: "Blue", description: "" }] }],
      },
    ];
    yield* watch.sweep;
    const waiting = harness.dispatched.filter(
      (command) =>
        command.type === "delegated_task.remote.progress" && command.status === "waiting",
    );
    assert.deepStrictEqual(
      waiting.map((command) => ("taskId" in command ? command.taskId : null)),
      [NodeId.make("node:second")],
    );
    const completed = harness.dispatched.filter(
      (command) => command.type === "delegated_task.remote.complete",
    );
    assert.deepStrictEqual(
      completed.map((command) => ("taskId" in command ? command.taskId : null)),
      [NodeId.make("node:first")],
    );
    assert.equal(wakes(harness.dispatched).length, 1);
  }).pipe(Effect.provide(harness.layer));
});

it.effect("a failed question read preserves its watch and does not block other tasks", () => {
  const harness = makeHarness();
  harness.state.sendRunIds = ["run_1", "run_2"];
  return Effect.gen(function* () {
    const watch = yield* HopliteTaskWatch.HopliteTaskWatch;
    yield* watch.sendMessage({ threadId: "thr_failure", message: "First" }, "t3-thread");
    yield* watch.sendMessage({ threadId: "thr_1", message: "Second" }, "t3-thread");
    harness.state.run = { id: "run_2", status: "running" };
    harness.state.questions = [
      {
        questionId: "q_1",
        parts: [{ question: "Which colour?", options: [{ label: "Blue", description: "" }] }],
      },
    ];
    harness.state.questionErrors.thr_failure = new HopliteCloudError({
      code: "unavailable",
      message: "Offline",
    });
    yield* watch.sweep;
    assert.equal(wakes(harness.dispatched).length, 1);
    assert.isTrue(yield* watch.watching("thr_failure"));
    delete harness.state.questionErrors.thr_failure;
    yield* watch.sweep;
    assert.equal(wakes(harness.dispatched).length, 2);
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

it.effect("two cards on one task keep their own watch and settle from their own run", () => {
  const harness = makeHarness();
  harness.state.runs = [activeRun];
  harness.state.sendRunIds = ["run_1", "run_2"];
  harness.state.cardIds = ["node:card1", "node:card2"];
  return Effect.gen(function* () {
    const watch = yield* HopliteTaskWatch.HopliteTaskWatch;
    yield* watch.sendMessage({ threadId: "thr_1", message: "First part" }, "t3-thread");
    yield* watch.sendMessage({ threadId: "thr_1", message: "Second part" }, "t3-thread");

    harness.state.byRun = { run_1: { id: "run_1", status: "completed" } };
    yield* watch.sweep;
    // Only the first card's run settled; the follow-up's card is still watched.
    assert.deepStrictEqual(
      harness.dispatched.flatMap((command) =>
        command.type === "delegated_task.remote.complete" ? [command.taskId] : [],
      ),
      [NodeId.make("node:card1")],
    );
    assert.isTrue(yield* watch.watching("thr_1"));

    harness.state.byRun = {
      run_1: { id: "run_1", status: "completed" },
      run_2: { id: "run_2", status: "failed" },
    };
    yield* watch.sweep;
    assert.deepStrictEqual(
      harness.dispatched.flatMap((command) =>
        command.type === "delegated_task.remote.complete" ? [[command.taskId, command.status]] : [],
      ),
      [
        [NodeId.make("node:card1"), "completed"],
        [NodeId.make("node:card2"), "failed"],
      ],
    );
    assert.isFalse(yield* watch.watching("thr_1"));
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

it.effect(
  "a full watch list closes an unwatched follow-up card without evicting its first run",
  () => {
    const harness = makeHarness();
    harness.state.runs = [activeRun];
    harness.state.cardIds = Array.from({ length: 51 }, (_, i) => `node:card${i}`);
    harness.state.sendRunIds = Array.from({ length: 51 }, (_, i) => `run_${i}`);
    return Effect.gen(function* () {
      const watch = yield* HopliteTaskWatch.HopliteTaskWatch;
      for (let i = 0; i < 50; i++) {
        yield* watch.sendMessage({ threadId: `thr_${i}`, message: "Work" }, "t3-thread");
      }
      const overflow = yield* watch.sendMessage(
        { threadId: "thr_0", message: "Follow up" },
        "t3-thread",
      );
      assert.isUndefined(overflow.next);
      const completed = harness.dispatched.filter(
        (command) => command.type === "delegated_task.remote.complete",
      );
      assert.equal(completed.length, 1);
      assert.equal(completed[0]?.taskId, NodeId.make("node:card50"));
      assert.include(completed[0]?.result, "not being watched");
      assert.isTrue(yield* watch.watching("thr_0"));
    }).pipe(Effect.provide(harness.layer));
  },
);
