import {
  CommandId,
  type HopliteCloudError,
  type HopliteCloudGetTaskInput,
  type HopliteCloudSendMessageInput,
  type HopliteCloudStartTaskInput,
  type HopliteCloudTask,
  type HopliteCloudTaskResult,
  MessageId,
  type OrchestrationV2Notification,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
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

export class HopliteTaskWatch extends Context.Service<
  HopliteTaskWatch,
  {
    /** Starts a task and, for an agent's thread, wakes that thread when its run settles. */
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
  const secrets = yield* ServerSecretStore.ServerSecretStore;

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

  const startTask = Effect.fn("HopliteTaskWatch.startTask")(function* (
    input: HopliteCloudStartTaskInput,
    callerThreadId: string | undefined,
  ) {
    const started = yield* hoplite.startTask(input);
    if (callerThreadId === undefined) return started.task;
    const watched = yield* add({
      callerThreadId,
      hopliteThreadId: started.task.threadId,
      runId: started.runId,
      afterRunId: null,
      seen: false,
      failures: 0,
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
    const watched = yield* add({
      callerThreadId,
      hopliteThreadId: input.threadId,
      runId,
      afterRunId: runId === null ? (before.run?.id ?? null) : null,
      seen: false,
      failures: 0,
    });
    return resultFor(before.task, watched);
  });

  const stopTask = Effect.fn("HopliteTaskWatch.stopTask")(function* (
    input: HopliteCloudGetTaskInput,
  ) {
    yield* Ref.update(watches, (current) =>
      current.filter((entry) => entry.hopliteThreadId !== input.threadId),
    ).pipe(Effect.andThen(persist));
    return yield* hoplite.stopTask(input);
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

  const check = Effect.fnUntraced(function* (watch: HopliteTaskWatchEntry) {
    const read = yield* Effect.result(hoplite.readTask({ threadId: watch.hopliteThreadId }));
    if (read._tag === "Failure") {
      const failures = watch.failures + 1;
      if (!GIVE_UP_CODES.includes(read.failure.code) && failures < READ_FAILURE_LIMIT) {
        return yield* replace(watch, { ...watch, failures });
      }
      yield* wake(watch, `unread:${watch.runId ?? watch.afterRunId ?? "none"}`, {
        text: `T3 Code stopped following Hoplite task ${watch.hopliteThreadId}: ${read.failure.message} Check it with hoplite_task_status.`,
        notification: {
          source: { kind: "monitor" },
          outcome: "failed",
          summary: "Stopped following a Hoplite task",
        },
      });
      return yield* replace(watch, null);
    }
    const step = stepWatch(watch, read.success.run);
    if (step.type === "wait") {
      if (step.watch === watch && watch.failures === 0) return;
      return yield* replace(watch, { ...step.watch, failures: 0 });
    }
    yield* wake(watch, step.runId, settledWake(read.success.task, step.status));
    yield* replace(watch, null);
  });

  const sweep = Ref.get(watches).pipe(
    Effect.flatMap((current) => Effect.forEach(current, check, { concurrency: 4, discard: true })),
    Effect.catchCause((cause) => Effect.logWarning("hoplite-cloud.watch-sweep-failed", { cause })),
    Effect.withSpan("HopliteTaskWatch.sweep"),
  );

  yield* forkParked(sweep.pipe(Effect.repeat(Schedule.spaced(SWEEP_INTERVAL))));

  return HopliteTaskWatch.of({ startTask, sendMessage, stopTask, sweep });
});

export const layer = Layer.effect(HopliteTaskWatch, make);
