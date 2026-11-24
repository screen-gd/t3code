import {
  CommandId,
  EnvironmentId,
  type HopliteCloudAnswerInput,
  HopliteCloudError,
  type HopliteCloudGetTaskInput,
  type HopliteCloudQuestion,
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
import * as DateTime from "effect/DateTime";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import { forkParked } from "../serverActivation.ts";
import { PROVIDER_NAMES, providerOfTask } from "./CloudSandboxProviders.ts";
import * as HopliteCloud from "./HopliteCloudService.ts";
import * as DevinCloud from "./DevinCloud.ts";
import { replyNeedsInput } from "./CloudSandboxTasks.ts";

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
  /** Until Hoplite takes this answer, its run still reads as waiting on the question. */
  answeredQuestionId: Schema.optional(Schema.String),
  notifiedQuestionIds: Schema.optional(Schema.Array(Schema.String)),
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
  // A run seen moving again has taken any answer, so its next wait is a new one.
  const { answeredQuestionId: _taken, ...moving } = watch;
  return { type: "wait", watch: { ...moving, runId: run.id, seen: true } };
}

const GIVE_UP_CODES: ReadonlyArray<HopliteCloudError["code"]> = [
  "not_connected",
  "invalid_key",
  "forbidden",
  "not_found",
  "unsupported",
];

const providerName = (taskId: string) => PROVIDER_NAMES[providerOfTask(taskId).provider];

const describe = (task: HopliteCloudTask) =>
  `${providerName(task.threadId)} task ${task.threadId}${task.title === null ? "" : ` ("${task.title}")`}`;

const formatQuestion = (question: HopliteCloudQuestion) =>
  [
    `Question ${question.questionId}:`,
    ...question.parts.flatMap((part) => [
      part.question,
      ...part.options.map(
        (option) =>
          `- ${option.label}${option.description === "" ? "" : `: ${option.description}`}`,
      ),
    ]),
  ].join("\n");

function settledWake(
  task: HopliteCloudTask,
  status: HopliteCloud.HopliteRunStatus,
  questions: ReadonlyArray<HopliteCloudQuestion>,
): { readonly text: string; readonly notification: OrchestrationV2Notification } {
  const name = describe(task);
  const [what, outcome] =
    status === "waiting"
      ? ([
          `is waiting for an answer. ${
            questions.length === 0
              ? "Reply with cloud_task and its threadId."
              : "Answer with cloud_task, its threadId and the questionId."
          } Answer from existing context when possible. Otherwise ask the user through your interactive picker with these options, then relay the answer to this exact task and question. Only pass dismiss:true for an explicit user dismissal. Navigation, disconnects and ending a turn leave it pending.`,
          "updated",
        ] as const)
      : status === "failed"
        ? (["failed.", "failed"] as const)
        : status === "cancelled"
          ? (["was stopped.", "cancelled"] as const)
          : (["finished.", "completed"] as const);
  const details = [
    ...(status === "waiting" ? questions.map(formatQuestion) : []),
    task.latestReply === null ? null : `Latest reply:\n${task.latestReply}`,
    task.pullRequestUrl === null ? null : `Pull request: ${task.pullRequestUrl}`,
  ].filter((line) => line !== null);
  return {
    text: [`${name} ${what}`, ...details].join("\n\n"),
    notification: {
      source: { kind: "monitor" },
      outcome,
      summary: `${task.title ?? `${providerName(task.threadId)} task`} ${what.split(".")[0]}`,
    },
  };
}

type CardStatus = "completed" | "failed" | "cancelled";

/** A run waiting for an answer has finished its turn; the card's result says what it asks. */
const cardStatus = (status: HopliteCloud.HopliteRunStatus): CardStatus =>
  status === "failed" ? "failed" : status === "cancelled" ? "cancelled" : "completed";

// Each provider stands in for the environment and model a linked task would name.
const serviceIdentity = (taskId: string) => {
  const { provider } = providerOfTask(taskId);
  return {
    service: provider,
    environmentId: EnvironmentId.make(provider),
    modelSelection: { instanceId: ProviderInstanceId.make(provider), model: provider },
  };
};

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
    readonly answerQuestion: (
      input: HopliteCloudAnswerInput,
      callerThreadId: string | undefined,
    ) => Effect.Effect<HopliteCloudTaskResult, HopliteCloudError>;
    /** The caller asked for the stop, so it is not woken for it. */
    readonly stopTask: (
      input: HopliteCloudGetTaskInput,
    ) => Effect.Effect<HopliteCloudTask, HopliteCloudError>;
    readonly sweep: Effect.Effect<void>;
    /** Fires when a Hoplite thread's chat may have changed: a message, answer or stop sent, or a run settled. */
    readonly threadActivity: (hopliteThreadId: string) => Stream.Stream<void>;
    /** Whether a run on this Hoplite thread is still being watched to settle. */
    readonly watching: (hopliteThreadId: string) => Effect.Effect<boolean>;
  }
>()("t3/hopliteCloud/HopliteTaskWatch") {}

const make = Effect.gen(function* () {
  const hoplite = yield* HopliteCloud.HopliteCloud;
  const engine = yield* Orchestrator.OrchestratorV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const random = yield* SecureRandom.SecureRandom;
  const activity = yield* PubSub.unbounded<string>();
  const touched = (hopliteThreadId: string) => PubSub.publish(activity, hopliteThreadId);
  const threadActivity = (hopliteThreadId: string) =>
    Stream.fromPubSub(activity).pipe(
      Stream.filter((id) => id === hopliteThreadId),
      Stream.map(() => undefined),
    );

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
  // Watches on one task differ by card, so a follow-up's card never replaces turn one's.
  const sameTask = (a: HopliteTaskWatchEntry, b: HopliteTaskWatchEntry) =>
    a.callerThreadId === b.callerThreadId &&
    a.hopliteThreadId === b.hopliteThreadId &&
    a.taskId === b.taskId;
  // The failure count is not worth a write; after a restart it starts again from zero.
  const sameButFailures = (a: HopliteTaskWatchEntry, b: HopliteTaskWatchEntry) => {
    const fields = new Set([...Object.keys(a), ...Object.keys(b)] as Array<keyof typeof a>);
    fields.delete("failures");
    return [...fields].every((field) => a[field] === b[field]);
  };

  /** Replaces only a watch for the same card on the same task by the same caller; false when full. */
  const add = (watch: HopliteTaskWatchEntry) =>
    Ref.modify(watches, (current) => {
      const others = current.filter((entry) => !sameTask(entry, watch));
      return others.length >= MAX_WATCHES ? [false, current] : [true, [...others, watch]];
    }).pipe(Effect.tap(persist));
  // Only the exact entry a sweep read is replaced, so a newer watch from a message wins.
  const replace = (from: HopliteTaskWatchEntry, to: HopliteTaskWatchEntry | null) =>
    Ref.modify(watches, (current) => {
      if (!current.includes(from)) return [false, current];
      const next = current.flatMap((entry) => (entry !== from ? [entry] : to === null ? [] : [to]));
      return [to === null || !sameButFailures(from, to), next];
    }).pipe(Effect.flatMap((changed) => (changed ? persist : Effect.void)));

  const resultFor = (task: HopliteCloudTask, watched: boolean): HopliteCloudTaskResult =>
    watched ? { ...task, next: HOPLITE_TASK_WAKES_NEXT } : task;

  const progress = (
    watch: HopliteTaskWatchEntry,
    status: "running" | "waiting",
    key: string,
    runId?: string | null,
  ) =>
    watch.taskId === undefined
      ? Effect.void
      : engine
          .dispatch({
            type: "delegated_task.remote.progress",
            commandId: CommandId.make(`server:cloud-progress:${watch.taskId}:${status}:${key}`),
            parentThreadId: ThreadId.make(watch.callerThreadId),
            taskId: NodeId.make(watch.taskId),
            status,
            ...(runId === undefined ? {} : { runId: runId === null ? null : RunId.make(runId) }),
          })
          .pipe(
            Effect.asVoid,
            Effect.mapError(
              () =>
                new HopliteCloudError({
                  code: "unavailable",
                  message:
                    "The cloud task is continuing, but its status could not be saved. Retry the request.",
                }),
            ),
          );

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
      const identity = serviceIdentity(input.hopliteThreadId);
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
        modelSelection: identity.modelSelection,
        remoteChild: {
          environmentId: identity.environmentId,
          threadId: ThreadId.make(input.hopliteThreadId),
          label: PROVIDER_NAMES[identity.service],
          service: identity.service,
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

  const addOrClose = Effect.fn("HopliteTaskWatch.addOrClose")(function* (
    watch: HopliteTaskWatchEntry,
  ) {
    const admitted = yield* add(watch);
    if (!admitted && watch.taskId !== undefined) {
      yield* completeCard(
        watch.callerThreadId,
        watch.taskId,
        "failed",
        "This run is not being watched because the 50-task watch limit was reached. The cloud task continues; check its status manually.",
        "ran-out",
      );
    }
    return admitted;
  });

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
    const watched = yield* addOrClose({
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

  // Older sandbox tasks kept their title only in the caller's durable card.
  const readForCaller = Effect.fn("HopliteTaskWatch.readForCaller")(function* (
    threadId: string,
    callerThreadId: string | undefined,
  ) {
    const title =
      callerThreadId === undefined
        ? undefined
        : (yield* engine.getThreadRecords(ThreadId.make(callerThreadId), ["subagents"]).pipe(
            Effect.mapError(
              () =>
                new HopliteCloudError({
                  code: "unavailable",
                  message: "The cloud task's saved title could not be read.",
                }),
            ),
          )).subagents
            .toSorted(
              (a, b) =>
                DateTime.toEpochMillis(a.startedAt ?? a.updatedAt) -
                DateTime.toEpochMillis(b.startedAt ?? b.updatedAt),
            )
            .find((task) => task.remoteChild?.threadId === threadId && task.title != null)?.title;
    return yield* hoplite.readTask({ threadId, ...(title == null ? {} : { title }) });
  });

  const sendMessage = Effect.fn("HopliteTaskWatch.sendMessage")(function* (
    input: HopliteCloudSendMessageInput,
    callerThreadId: string | undefined,
  ) {
    // A message queued behind the active run gets no run id; the run before it is the baseline.
    const before = yield* readForCaller(input.threadId, callerThreadId);
    const { runId } = yield* hoplite.sendMessage(input);
    const continuing = {
      ...before.task,
      status: "running",
      latestReply: null,
    } satisfies HopliteCloudTask;
    if (callerThreadId === undefined) {
      yield* touched(input.threadId);
      return continuing;
    }
    const taskId = yield* recordCard({
      callerThreadId,
      hopliteThreadId: input.threadId,
      runId,
      prompt: input.message,
      title: before.task.title ?? undefined,
      key: runId ?? input.clientRequestId ?? (yield* random.uuidV4()),
    });
    const watched = yield* addOrClose({
      callerThreadId,
      hopliteThreadId: input.threadId,
      runId,
      afterRunId: runId === null ? (before.run?.id ?? null) : null,
      seen: false,
      failures: 0,
      ...(taskId === undefined ? {} : { taskId }),
    });
    // After the watch is saved, so a chat reloading on this reads the new run as going.
    yield* touched(input.threadId);
    return resultFor(continuing, watched);
  });

  const answerQuestion = Effect.fn("HopliteTaskWatch.answerQuestion")(function* (
    input: HopliteCloudAnswerInput,
    callerThreadId: string | undefined,
  ) {
    const before = yield* readForCaller(input.threadId, callerThreadId);
    const answered = yield* hoplite.answerQuestion(input);
    const continuing = {
      ...before.task,
      status: "running",
      latestReply: null,
    } satisfies HopliteCloudTask;
    if (callerThreadId === undefined) {
      yield* touched(input.threadId);
      return continuing;
    }
    const runId = answered.runId;
    const previous = (yield* Ref.get(watches)).find(
      (watch) =>
        watch.hopliteThreadId === input.threadId && watch.callerThreadId === callerThreadId,
    );
    const taskId =
      previous?.taskId ??
      (yield* recordCard({
        callerThreadId,
        hopliteThreadId: input.threadId,
        runId,
        prompt: input.answer,
        title: before.task.title ?? undefined,
        key: `answer:${input.questionId}`,
      }));
    const watched = yield* addOrClose({
      callerThreadId,
      hopliteThreadId: input.threadId,
      runId,
      // The run that asked has usually ended, so without a run id the answer's is the next one.
      afterRunId: runId === null ? (before.run?.id ?? null) : null,
      seen: false,
      failures: 0,
      answeredQuestionId: input.questionId,
      ...(previous?.notifiedQuestionIds === undefined
        ? {}
        : { notifiedQuestionIds: previous.notifiedQuestionIds }),
      ...(taskId === undefined ? {} : { taskId }),
    });
    if (previous !== undefined) yield* progress(previous, "running", input.questionId, runId);
    yield* touched(input.threadId);
    return resultFor(continuing, watched);
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
    yield* touched(input.threadId);
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
        commandId: CommandId.make(
          `server:hoplite-task:${watch.callerThreadId}:${watch.hopliteThreadId}:${key}`,
        ),
        threadId: ThreadId.make(watch.callerThreadId),
        messageId: MessageId.make(
          `message:hoplite-task:${watch.callerThreadId}:${watch.hopliteThreadId}:${key}`,
        ),
        text: message.text,
        notification: message.notification,
        attachments: [],
        dispatchMode: { type: "queue_after_active" },
        createdBy: "agent",
        creationSource: "server",
      })
      .pipe(Effect.asVoid);

  const settle = (
    watch: HopliteTaskWatchEntry,
    key: string,
    message: { readonly text: string; readonly notification: OrchestrationV2Notification },
    status: CardStatus,
  ) =>
    (watch.taskId === undefined
      ? wake(watch, key, message)
      : completeCard(watch.callerThreadId, watch.taskId, status, message.text, "ran-out")
    ).pipe(
      // The watch goes before the chat is told, so a chat reloading on this reads the run as over.
      Effect.andThen(replace(watch, null)),
      Effect.andThen(touched(watch.hopliteThreadId)),
    );

  const check = Effect.fnUntraced(function* (watch: HopliteTaskWatchEntry) {
    const read = yield* Effect.result(
      hoplite.readTask({
        threadId: watch.hopliteThreadId,
        ...(watch.runId === null ? {} : { runId: watch.runId }),
      }),
    );
    if (read._tag === "Failure") {
      // Rate limiting says nothing about the task; the next sweep tries again.
      if (read.failure.code === "rate_limited") return;
      const failures = watch.failures + 1;
      if (!GIVE_UP_CODES.includes(read.failure.code) && failures < READ_FAILURE_LIMIT) {
        return yield* replace(watch, { ...watch, failures });
      }
      return yield* settle(
        watch,
        `unread:${watch.runId ?? watch.afterRunId ?? "none"}`,
        {
          text: `T3 Code stopped following ${providerName(watch.hopliteThreadId)} task ${watch.hopliteThreadId}: ${read.failure.message}`,
          notification: {
            source: { kind: "monitor" },
            outcome: "failed",
            summary: `Stopped following a ${providerName(watch.hopliteThreadId)} task`,
          },
        },
        "failed",
      );
    }
    const questionRunId = watch.runId?.startsWith("queued-")
      ? read.success.questionRunId
      : (watch.runId ?? read.success.run?.id);
    const questions = (yield* hoplite.listQuestions({ threadId: watch.hopliteThreadId })).filter(
      (question) => question.runId === undefined || question.runId === questionRunId,
    );
    const unanswered = questions.filter(
      (question) => question.questionId !== watch.answeredQuestionId,
    );
    if (unanswered.length > 0) {
      const fresh = unanswered.filter(
        (question) => !watch.notifiedQuestionIds?.includes(question.questionId),
      );
      for (const question of fresh) {
        yield* progress(watch, "waiting", question.questionId);
        yield* wake(
          watch,
          `question:${question.questionId}`,
          settledWake(read.success.task, "waiting", [question]),
        );
      }
      if (fresh.length > 0) {
        yield* replace(watch, {
          ...watch,
          notifiedQuestionIds: [
            ...(watch.notifiedQuestionIds ?? []),
            ...fresh.map((question) => question.questionId),
          ],
        });
        yield* touched(watch.hopliteThreadId);
      }
      return;
    }
    const step = stepWatch(watch, read.success.run);
    if (step.type === "wait") {
      if (step.watch === watch && watch.failures === 0) return;
      return yield* replace(watch, { ...step.watch, failures: 0 });
    }
    if (
      questions.length === 0 &&
      (step.status === "waiting" ||
        (step.status === "completed" && replyNeedsInput(read.success.task.latestReply)))
    ) {
      const key = `unstructured:${step.runId}`;
      if (watch.notifiedQuestionIds?.includes(key)) return;
      yield* progress(watch, "waiting", key);
      yield* wake(watch, key, settledWake(read.success.task, "waiting", []));
      yield* replace(watch, {
        ...watch,
        notifiedQuestionIds: [...(watch.notifiedQuestionIds ?? []), key],
      });
      return;
    }
    // Hoplite ends the run that asked, so a question can be pending behind a completed run.
    const status = questions.length > 0 ? "waiting" : step.status;
    if (
      watch.answeredQuestionId !== undefined &&
      status === "waiting" &&
      questions.every((question) => question.questionId === watch.answeredQuestionId)
    ) {
      return;
    }
    yield* settle(
      watch,
      // A run can wait again on a later question; each one wakes once.
      status === "waiting" && questions[0] !== undefined
        ? `${step.runId}:${questions[0].questionId}`
        : step.runId,
      settledWake(read.success.task, status, questions),
      cardStatus(status),
    );
  });

  /**
   * A card cancelled here, or whose parent was stopped, still owes a stop in Hoplite. It is
   * found from the card, as a linked environment's is, so the stop survives restarts.
   */
  const stopOwed = Effect.fnUntraced(function* (parentThreadId: ThreadId, taskId: NodeId) {
    const { subagents } = yield* engine.getThreadRecords(parentThreadId, ["subagents"]);
    const task = subagents.find((candidate) => candidate.id === taskId);
    const remote = task?.remoteChild;
    if (task?.result == null || remote?.service === undefined) return;
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
    Effect.flatMap((current) =>
      Effect.forEach(
        current,
        (watch) =>
          check(watch).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("cloud task question check failed", {
                threadId: watch.hopliteThreadId,
                cause,
              }),
            ),
          ),
        { concurrency: 4, discard: true },
      ),
    ),
    // Without a stored key no stop can be sent, so the cards are left for when one is.
    Effect.andThen(hoplite.connected),
    Effect.flatMap((connected) => (connected ? sweepCards : Effect.void)),
    Effect.catchCause((cause) => Effect.logWarning("hoplite-cloud.watch-sweep-failed", { cause })),
    Effect.withSpan("HopliteTaskWatch.sweep"),
  );

  yield* forkParked(sweep.pipe(Effect.repeat(Schedule.spaced(SWEEP_INTERVAL))));

  return HopliteTaskWatch.of({
    startTask,
    sendMessage,
    answerQuestion,
    stopTask,
    sweep,
    threadActivity,
    watching: Effect.fn("HopliteTaskWatch.watching")(function* (hopliteThreadId: string) {
      const current = yield* Ref.get(watches);
      return current.some((entry) => entry.hopliteThreadId === hopliteThreadId);
    }),
  });
});

export const layer = Layer.effect(HopliteTaskWatch, make);

/** One watcher per server: MCP tools and the task's chat pane share its watches. */
export const layerLive = layer.pipe(
  Layer.provideMerge(HopliteCloud.layer.pipe(Layer.provide(DevinCloud.layer))),
  Layer.provide(ProjectionStore.layer),
);
