import {
  CommandId,
  EnvironmentId,
  type HopliteCloudError,
  type HopliteCloudGetTaskInput,
  type HopliteCloudSendMessageInput,
  type HopliteCloudStartTaskInput,
  type HopliteCloudTask,
  type HopliteCloudTaskResult,
  MessageId,
  NodeId,
  type OrchestrationV2Notification,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import { forkParked } from "../serverActivation.ts";
import * as HopliteCloud from "./HopliteCloudService.ts";

// Survives restarts with the key it belongs to; holds thread ids only.
const WATCHES_SECRET = "hoplite-cloud-task-watches";
const SWEEP_INTERVAL = "30 seconds";
const MAX_WATCHES = 50;
/** About five minutes of failed reads before the agent is told to check itself. */
const READ_FAILURE_LIMIT = 10;

export const HOPLITE_TASK_WAKES_NEXT =
  "Completion wakes this thread, so end your turn. Do not wait on it or poll it.";

const Watch = Schema.Struct({
  /** The T3 thread whose agent is woken. */
  callerThreadId: Schema.String,
  hopliteThreadId: Schema.String,
  /** The run to wait for. Null waits for the first run that is not `afterRunId`. */
  runId: Schema.NullOr(Schema.String),
  afterRunId: Schema.NullOr(Schema.String),
  /** Whether run-state has shown `runId`, so a different run there replaced it. */
  seen: Schema.Boolean,
  failures: Schema.Number,
  /** The delegated-task card in the caller thread; without one the thread gets a message. */
  taskId: Schema.optional(Schema.String),
});
type HopliteTaskWatchEntry = typeof Watch.Type;
const WatchesJson = Schema.fromJsonString(Schema.Array(Watch));
const decodeWatches = Schema.decodeOption(WatchesJson);
const encodeWatches = Schema.encodeSync(WatchesJson);

const SETTLED: ReadonlyArray<HopliteCloud.HopliteRunStatus> = [
  "waiting",
  "completed",
  "failed",
  "cancelled",
];

type HopliteWatchStep =
  | { readonly type: "wait"; readonly watch: HopliteTaskWatchEntry }
  | {
      readonly type: "settled";
      readonly runId: string;
      readonly status: HopliteCloud.HopliteRunStatus;
    };

/**
 * Right after a message, run-state can still report the run before it, so a watch settles
 * only on the run it started, or on whatever run replaced that one once it was seen.
 */
function stepWatch(
  watch: HopliteTaskWatchEntry,
  run: HopliteCloud.HopliteRun | null,
): HopliteWatchStep {
  const waiting = { type: "wait", watch } as const;
  if (run === null) return waiting;
  const ours =
    watch.runId === null ? run.id !== watch.afterRunId : run.id === watch.runId || watch.seen;
  if (!ours) return waiting;
  if (SETTLED.includes(run.status)) return { type: "settled", runId: run.id, status: run.status };
  return { type: "wait", watch: { ...watch, runId: run.id, seen: true } };
}

const GIVE_UP_CODES: ReadonlyArray<HopliteCloudError["code"]> = [
  "not_connected",
  "invalid_key",
  "forbidden",
  "not_found",
];

const describe = (task: HopliteCloudTask) =>
  `Hoplite task ${task.threadId}${task.title === null ? "" : ` ("${task.title}")`}`;

function settledWake(
  task: HopliteCloudTask,
  status: HopliteCloud.HopliteRunStatus,
): { readonly text: string; readonly notification: OrchestrationV2Notification } {
  const name = describe(task);
  const [what, outcome] =
    status === "waiting"
      ? (["is waiting for an answer. Reply with hoplite_task_message.", "updated"] as const)
      : status === "failed"
        ? (["failed.", "failed"] as const)
        : status === "cancelled"
          ? (["was stopped.", "cancelled"] as const)
          : (["finished.", "completed"] as const);
  const details = [
    task.latestReply === null ? null : `Latest reply:\n${task.latestReply}`,
    task.pullRequestUrl === null ? null : `Pull request: ${task.pullRequestUrl}`,
  ].filter((line) => line !== null);
  return {
    text: [`${name} ${what}`, ...details].join("\n\n"),
    notification: {
      source: { kind: "monitor" },
      outcome,
      summary: `${task.title ?? "Hoplite task"} ${what.split(".")[0]}`,
    },
  };
}

type CardStatus = "completed" | "failed" | "cancelled";

/** A run waiting for an answer has finished its turn; the card's result says what it asks. */
const cardStatus = (status: HopliteCloud.HopliteRunStatus): CardStatus =>
  status === "failed" ? "failed" : status === "cancelled" ? "cancelled" : "completed";

const HOPLITE_ENVIRONMENT = EnvironmentId.make("hoplite");
const HOPLITE_MODEL = { instanceId: ProviderInstanceId.make("hoplite"), model: "hoplite" };

export class HopliteTaskWatch extends Context.Service<
  HopliteTaskWatch,
  {
    /**
     * Starts a task. Called from an agent's thread, it shows as a delegated-task card there
     * that completes, waking the agent, when the run settles.
     */
    readonly startTask: (
      input: HopliteCloudStartTaskInput,
      callerThreadId: string | undefined,
    ) => Effect.Effect<HopliteCloudTaskResult, HopliteCloudError>;
    readonly sendMessage: (
      input: HopliteCloudSendMessageInput,
      callerThreadId: string | undefined,
    ) => Effect.Effect<HopliteCloudTaskResult, HopliteCloudError>;
    /** The caller asked for the stop, so it is not woken for it. */
    readonly stopTask: (
      input: HopliteCloudGetTaskInput,
    ) => Effect.Effect<HopliteCloudTask, HopliteCloudError>;
    readonly sweep: Effect.Effect<void>;
  }
>()("t3/hopliteCloud/HopliteTaskWatch") {}

const make = Effect.gen(function* () {
  const hoplite = yield* HopliteCloud.HopliteCloud;
  const engine = yield* Orchestrator.OrchestratorV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const random = yield* SecureRandom.SecureRandom;

  const stored = yield* secrets.get(WATCHES_SECRET).pipe(
    Effect.map(Option.flatMap((bytes) => decodeWatches(new TextDecoder().decode(bytes)))),
    Effect.orElseSucceed(() => Option.none()),
  );
  const watches = yield* Ref.make<ReadonlyArray<HopliteTaskWatchEntry>>(
    Option.getOrElse(stored, () => []),
  );

  const persist = Ref.get(watches).pipe(
    Effect.flatMap((current) =>
      secrets.set(WATCHES_SECRET, new TextEncoder().encode(encodeWatches(current))),
    ),
    Effect.catchCause((cause) => Effect.logWarning("hoplite-cloud.watch-save-failed", { cause })),
  );
  const sameTask = (a: HopliteTaskWatchEntry, b: HopliteTaskWatchEntry) =>
    a.callerThreadId === b.callerThreadId && a.hopliteThreadId === b.hopliteThreadId;

  /** Replaces any watch on the same task by the same caller; false when full. */
  const add = (watch: HopliteTaskWatchEntry) =>
    Ref.modify(watches, (current) => {
      const others = current.filter((entry) => !sameTask(entry, watch));
      return others.length >= MAX_WATCHES ? [false, current] : [true, [...others, watch]];
    }).pipe(Effect.tap(persist));
  // Only the exact entry a sweep read is replaced, so a newer watch from a message wins.
  const replace = (from: HopliteTaskWatchEntry, to: HopliteTaskWatchEntry | null) =>
    Ref.update(watches, (current) =>
      current.flatMap((entry) => (entry !== from ? [entry] : to === null ? [] : [to])),
    ).pipe(Effect.andThen(persist));

  const resultFor = (task: HopliteCloudTask, watched: boolean): HopliteCloudTaskResult =>
    watched ? { ...task, next: HOPLITE_TASK_WAKES_NEXT } : task;

  /**
   * Shows the run as a delegated-task card under the caller's active run, as a task in a
   * linked environment is shown. Without an active run there is nothing to hang it on.
   */
  const recordCard = Effect.fnUntraced(
    function* (input: {
      readonly callerThreadId: string;
      readonly hopliteThreadId: string;
      readonly runId: string | null;
      readonly prompt: string;
      readonly title: string | undefined;
      readonly key: string;
    }) {
      const parentThreadId = ThreadId.make(input.callerThreadId);
      const { runs } = yield* engine.getThreadRecords(parentThreadId, ["runs"]);
      const parentRun = runs
        .filter(ThreadManagement.isActiveRun)
        .toSorted((left, right) => right.ordinal - left.ordinal)[0];
      if (parentRun === undefined || parentRun.rootNodeId === null) return undefined;
      const recorded = yield* engine.dispatch({
        type: "delegated_task.remote.request",
        commandId: CommandId.make(`server:hoplite-task:${input.hopliteThreadId}:card:${input.key}`),
        parentThreadId,
        parentRunId: parentRun.id,
        parentNodeId: parentRun.rootNodeId,
        task: input.prompt,
        ...(input.title === undefined ? {} : { title: input.title }),
        driver: ProviderDriverKind.make("remote"),
        modelSelection: HOPLITE_MODEL,
        remoteChild: {
          environmentId: HOPLITE_ENVIRONMENT,
          threadId: ThreadId.make(input.hopliteThreadId),
          label: "Hoplite",
          service: "hoplite",
          ...(input.runId === null ? {} : { runId: RunId.make(input.runId) }),
        },
        completionWake: "always",
      });
      const event = recorded.storedEvents.find(
        (stored) => stored.event.type === "subagent.updated",
      );
      return event?.event.type === "subagent.updated" ? event.event.payload.id : undefined;
    },
    // The task still runs; its caller is woken by a message instead.
    (effect) =>
      effect.pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("hoplite-cloud.card-failed", { cause }).pipe(Effect.as(undefined)),
        ),
      ),
  );

  /**
   * Completing a card wakes its parent; a card that already has its result keeps it. Each
   * attempt is its own command, so a refused one never blocks the next.
   */
  const completeCard = (
    callerThreadId: string,
    taskId: string,
    status: CardStatus,
    result: string,
    stoppedThere: "ran-out" | "stopped",
    stopCount?: number,
  ) =>
    random.uuidV4().pipe(
      Effect.flatMap((attempt) =>
        engine.dispatch({
          type: "delegated_task.remote.complete",
          commandId: CommandId.make(`server:hoplite-task-complete:${taskId}:${attempt}`),
          parentThreadId: ThreadId.make(callerThreadId),
          taskId: NodeId.make(taskId),
          status,
          result,
          stoppedThere,
          ...(stopCount === undefined ? {} : { stopCount }),
        }),
      ),
      Effect.catchCause((cause) =>
        Effect.logWarning("hoplite-cloud.card-complete-failed", { cause }),
      ),
    );

  const startTask = Effect.fn("HopliteTaskWatch.startTask")(function* (
    input: HopliteCloudStartTaskInput,
    callerThreadId: string | undefined,
  ) {
    const started = yield* hoplite.startTask(input);
    if (callerThreadId === undefined) return started.task;
    const taskId = yield* recordCard({
      callerThreadId,
      hopliteThreadId: started.task.threadId,
      runId: started.runId,
      prompt: input.prompt,
      title: input.title ?? started.task.title ?? undefined,
      key: started.runId ?? "start",
    });
    const watched = yield* add({
      callerThreadId,
      hopliteThreadId: started.task.threadId,
      runId: started.runId,
      afterRunId: null,
      seen: false,
      failures: 0,
      ...(taskId === undefined ? {} : { taskId }),
    });
    return resultFor(started.task, watched);
  });

  const sendMessage = Effect.fn("HopliteTaskWatch.sendMessage")(function* (
    input: HopliteCloudSendMessageInput,
    callerThreadId: string | undefined,
  ) {
    // A message queued behind the active run gets no run id; the run before it is the baseline.
    const before = yield* hoplite.readTask({ threadId: input.threadId });
    const { runId } = yield* hoplite.sendMessage(input);
    if (callerThreadId === undefined) return before.task;
    const taskId = yield* recordCard({
      callerThreadId,
      hopliteThreadId: input.threadId,
      runId,
      prompt: input.message,
      title: before.task.title ?? undefined,
      key: runId ?? input.clientRequestId ?? (yield* random.uuidV4()),
    });
    const watched = yield* add({
      callerThreadId,
      hopliteThreadId: input.threadId,
      runId,
      afterRunId: runId === null ? (before.run?.id ?? null) : null,
      seen: false,
      failures: 0,
      ...(taskId === undefined ? {} : { taskId }),
    });
    return resultFor(before.task, watched);
  });

  const stopTask = Effect.fn("HopliteTaskWatch.stopTask")(function* (
    input: HopliteCloudGetTaskInput,
  ) {
    const dropped = yield* Ref.modify(
      watches,
      (current) =>
        [
          current.filter((entry) => entry.hopliteThreadId === input.threadId),
          current.filter((entry) => entry.hopliteThreadId !== input.threadId),
        ] as const,
    ).pipe(Effect.tap(persist));
    const task = yield* hoplite.stopTask(input);
    yield* Effect.forEach(
      dropped,
      (watch) =>
        watch.taskId === undefined
          ? Effect.void
          : completeCard(watch.callerThreadId, watch.taskId, "cancelled", "Stopped.", "stopped"),
      { discard: true },
    );
    return task;
  });

  const wake = (
    watch: HopliteTaskWatchEntry,
    key: string,
    message: { readonly text: string; readonly notification: OrchestrationV2Notification },
  ) =>
    engine
      .dispatch({
        type: "message.dispatch",
        commandId: CommandId.make(`server:hoplite-task:${watch.hopliteThreadId}:${key}`),
        threadId: ThreadId.make(watch.callerThreadId),
        messageId: MessageId.make(`message:hoplite-task:${watch.hopliteThreadId}:${key}`),
        text: message.text,
        notification: message.notification,
        attachments: [],
        dispatchMode: { type: "queue_after_active" },
        createdBy: "agent",
        creationSource: "server",
      })
      .pipe(
        // An archived or deleted thread has no agent left to wake.
        Effect.catchCause((cause) => Effect.logWarning("hoplite-cloud.wake-failed", { cause })),
      );

  const settle = (
    watch: HopliteTaskWatchEntry,
    key: string,
    message: { readonly text: string; readonly notification: OrchestrationV2Notification },
    status: CardStatus,
  ) =>
    watch.taskId === undefined
      ? wake(watch, key, message)
      : completeCard(watch.callerThreadId, watch.taskId, status, message.text, "ran-out");

  const check = Effect.fnUntraced(function* (watch: HopliteTaskWatchEntry) {
    const read = yield* Effect.result(hoplite.readTask({ threadId: watch.hopliteThreadId }));
    if (read._tag === "Failure") {
      const failures = watch.failures + 1;
      if (!GIVE_UP_CODES.includes(read.failure.code) && failures < READ_FAILURE_LIMIT) {
        return yield* replace(watch, { ...watch, failures });
      }
      yield* settle(
        watch,
        `unread:${watch.runId ?? watch.afterRunId ?? "none"}`,
        {
          text: `T3 Code stopped following Hoplite task ${watch.hopliteThreadId}: ${read.failure.message} Check it with hoplite_task_status.`,
          notification: {
            source: { kind: "monitor" },
            outcome: "failed",
            summary: "Stopped following a Hoplite task",
          },
        },
        "failed",
      );
      return yield* replace(watch, null);
    }
    const step = stepWatch(watch, read.success.run);
    if (step.type === "wait") {
      if (step.watch === watch && watch.failures === 0) return;
      return yield* replace(watch, { ...step.watch, failures: 0 });
    }
    yield* settle(
      watch,
      step.runId,
      settledWake(read.success.task, step.status),
      cardStatus(step.status),
    );
    yield* replace(watch, null);
  });

  /**
   * A card cancelled here, or whose parent was stopped, still owes a stop in Hoplite. It is
   * found from the card, as a linked environment's is, so the stop survives restarts.
   */
  const stopOwed = Effect.fnUntraced(function* (parentThreadId: ThreadId, taskId: NodeId) {
    const { subagents } = yield* engine.getThreadRecords(parentThreadId, ["subagents"]);
    const task = subagents.find((candidate) => candidate.id === taskId);
    const remote = task?.remoteChild;
    if (task?.result == null || remote?.service !== "hoplite") return;
    yield* Ref.update(watches, (current) =>
      current.filter((entry) => entry.taskId !== taskId),
    ).pipe(Effect.andThen(persist));
    const stopped = yield* Effect.result(hoplite.stopTask({ threadId: remote.threadId }));
    // A thread gone there leaves nothing to stop; anything else is tried on the next sweep.
    if (stopped._tag === "Failure" && !GIVE_UP_CODES.includes(stopped.failure.code)) return;
    yield* completeCard(
      parentThreadId,
      taskId,
      task.status === "failed" || task.status === "completed" ? task.status : "cancelled",
      task.result,
      "stopped",
      remote.stopCount,
    );
  });

  const sweepCards = projections.getOpenRemoteDelegatedTasks.pipe(
    Effect.flatMap((open) =>
      Effect.forEach(
        open,
        ({ parentThreadId, taskId }) =>
          stopOwed(parentThreadId, taskId).pipe(
            Effect.catchCause((cause) => Effect.logWarning("hoplite-cloud.stop-failed", { cause })),
          ),
        { concurrency: 4, discard: true },
      ),
    ),
  );

  const sweep = Ref.get(watches).pipe(
    Effect.flatMap((current) => Effect.forEach(current, check, { concurrency: 4, discard: true })),
    Effect.andThen(sweepCards),
    Effect.catchCause((cause) => Effect.logWarning("hoplite-cloud.watch-sweep-failed", { cause })),
    Effect.withSpan("HopliteTaskWatch.sweep"),
  );

  yield* forkParked(sweep.pipe(Effect.repeat(Schedule.spaced(SWEEP_INTERVAL))));

  return HopliteTaskWatch.of({ startTask, sendMessage, stopTask, sweep });
});

export const layer = Layer.effect(HopliteTaskWatch, make);
