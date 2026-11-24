import {
  CloudTaskChatEntry,
  type CloudTaskChatEvent,
  HopliteCloudError,
  type HopliteCloudQuestion,
  type HopliteCloudStartTaskInput,
  ProviderUserInputAnswers,
} from "@t3tools/contracts";
import { parseElicitationForm } from "@t3tools/provider-acp/server/elicitationForm";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as AcpClient from "effect-acp/client";
import type * as AcpSchema from "effect-acp/compat";
import * as AcpError from "effect-acp/errors";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as SecureRandom from "effect/crypto/SecureRandom";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import type {
  HopliteStartedTask,
  HopliteTaskRead,
  HopliteRunStatus,
} from "./HopliteCloudService.ts";
import { makeChatReducer } from "./HopliteTaskChat.ts";

const Run = Schema.Struct({
  id: Schema.String,
  status: Schema.Literals(["queued", "running", "waiting", "completed", "failed", "cancelled"]),
  reply: Schema.NullOr(Schema.String),
});
const SavedTask = Schema.Struct({
  sessionId: Schema.String,
  title: Schema.String,
  repo: Schema.String,
  runs: Schema.Array(Run),
});
const SavedTaskJson = Schema.fromJsonString(SavedTask);
const encodeTask = Schema.encodeEffect(SavedTaskJson);
const decodeTask = Schema.decodeEffect(SavedTaskJson);
const decodeAnswers = Schema.decodeOption(Schema.fromJsonString(ProviderUserInputAnswers));
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const failure = (code: HopliteCloudError["code"], message: string) =>
  new HopliteCloudError({ code, message });
const unavailable = () =>
  failure(
    "unavailable",
    "Devin Cloud could not be reached. Check the Devin CLI login on this environment.",
  );
const MAX_CONNECTIONS = 50;
const MAX_ENTRIES = 200;
const MAX_TEXT = 20_000;

const latestReply = (entries: ReadonlyArray<CloudTaskChatEntry>) => {
  const user = entries.findLastIndex((entry) => entry._tag === "message" && entry.role === "user");
  const assistant = entries.findLastIndex(
    (entry) => entry._tag === "message" && entry.role === "assistant",
  );
  const entry = entries[assistant];
  return assistant > user && entry?._tag === "message" ? entry.text.slice(-MAX_TEXT) : null;
};

interface PendingQuestion {
  readonly question: HopliteCloudQuestion;
  readonly answer: (answer: string | null) => Effect.Effect<void, HopliteCloudError>;
}

interface Session {
  saved: typeof SavedTask.Type;
  readonly client: AcpClient.AcpClient["Service"];
  readonly scope: Scope.Closeable;
  entries: ReadonlyArray<CloudTaskChatEntry>;
  readonly pending: Map<string, PendingQuestion>;
  readonly lock: Semaphore.Semaphore;
  readonly turns: Semaphore.Semaphore;
  readonly events: PubSub.PubSub<CloudTaskChatEvent>;
  readonly isAlive: () => boolean;
  replaying: boolean;
  activeRunId: string | undefined;
}

export class DevinCloud extends Context.Service<
  DevinCloud,
  {
    readonly verify: Effect.Effect<void, HopliteCloudError>;
    readonly start: (
      input: HopliteCloudStartTaskInput,
    ) => Effect.Effect<HopliteStartedTask, HopliteCloudError>;
    readonly read: (
      id: string,
      runId?: string,
    ) => Effect.Effect<HopliteTaskRead, HopliteCloudError>;
    readonly send: (
      id: string,
      message: string,
    ) => Effect.Effect<{ readonly runId: string }, HopliteCloudError>;
    readonly stop: (id: string) => Effect.Effect<HopliteTaskRead, HopliteCloudError>;
    readonly questions: (
      id: string,
    ) => Effect.Effect<ReadonlyArray<HopliteCloudQuestion>, HopliteCloudError>;
    readonly answer: (
      id: string,
      questionId: string,
      answer: string | null,
    ) => Effect.Effect<{ readonly runId: string | null }, HopliteCloudError>;
    readonly watch: (id: string) => Stream.Stream<CloudTaskChatEvent, HopliteCloudError>;
    readonly disconnect: Effect.Effect<void>;
  }
>()("t3/hopliteCloud/DevinCloud") {}

const make = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const random = yield* SecureRandom.SecureRandom;
  const cwd = yield* HostProcess.WorkingDirectory;
  const sessions = new Map<string, Session>();
  const opening = yield* Semaphore.make(1);
  const secretName = (id: string) => `cloud-task-devin-${id}`;

  const openClient = Effect.gen(function* () {
    const command = yield* resolveSpawnCommand("devin", ["acp", "--cloud"]);
    const child = yield* spawner
      .spawn(
        ChildProcess.make(command.command, command.args, {
          cwd,
          shell: command.shell,
          stdin: "pipe",
          stdout: "pipe",
          stderr: "pipe",
        }),
      )
      .pipe(
        Effect.mapError(() =>
          failure(
            "not_connected",
            "Install the Devin CLI and run `devin auth login` on this environment, then connect Devin Cloud again.",
          ),
        ),
      );
    yield* Effect.forkScoped(Stream.runDrain(child.stderr));
    let alive = true;
    const context = yield* Layer.build(
      AcpClient.layerChildProcess(child, {
        onTermination: () =>
          Effect.sync(() => {
            alive = false;
          }),
      }),
    );
    const client = Context.get(context, AcpClient.AcpClient);
    yield* client.agent
      .initialize({ protocolVersion: 1, clientCapabilities: {} })
      .pipe(
        Effect.mapError(unavailable),
        Effect.timeoutOrElse({ duration: "20 seconds", orElse: () => Effect.fail(unavailable()) }),
      );
    return { client, isAlive: () => alive };
  });

  const persist = (session: Session) =>
    session.lock.withPermit(
      Effect.gen(function* () {
        const json = yield* encodeTask(session.saved);
        yield* secrets.set(secretName(session.saved.sessionId), encoder.encode(json));
      }).pipe(Effect.mapError(unavailable)),
    );

  const changeRun = Effect.fn("DevinCloud.changeRun")(function* (
    session: Session,
    runId: string,
    status: HopliteRunStatus,
  ) {
    const reply = latestReply(session.entries);
    session.saved = {
      ...session.saved,
      runs: session.saved.runs.map((run) =>
        run.id === runId
          ? {
              ...run,
              status,
              reply: status === "running" ? null : (reply ?? run.reply),
            }
          : run,
      ),
    };
    yield* persist(session);
    yield* PubSub.publish(session.events, {
      _tag: "live",
      running: session.saved.runs.some((run) =>
        ["queued", "running", "waiting"].includes(run.status),
      ),
    });
  });

  const installHandlers = Effect.fn("DevinCloud.installHandlers")(function* (session: Session) {
    const reduce = makeChatReducer();
    yield* session.client.handleSessionUpdate((notification) =>
      Effect.gen(function* () {
        if (notification.sessionId !== session.saved.sessionId) return;
        for (const event of reduce(notification.update)) {
          if (event._tag === "upsert") {
            const previous = session.entries.filter((entry) => entry.id !== event.entry.id);
            const entry =
              event.entry._tag === "message"
                ? { ...event.entry, text: event.entry.text.slice(-MAX_TEXT) }
                : event.entry;
            session.entries = [...previous, entry].slice(-MAX_ENTRIES);
          } else if (event._tag === "append") {
            session.entries = session.entries.map((entry) =>
              entry.id === event.id && entry._tag === "message"
                ? { ...entry, text: (entry.text + event.text).slice(-MAX_TEXT) }
                : entry,
            );
          }
          yield* PubSub.publish(session.events, event);
        }
        // After reconnecting, no local prompt is waiting to return a stop reason.
        // Devin's status notices keep that recovered run visible until the next prompt.
        if (
          !session.replaying &&
          session.activeRunId === undefined &&
          notification.update.sessionUpdate === "session_info_update"
        ) {
          const run = session.saved.runs.find((candidate) =>
            ["running", "waiting"].includes(candidate.status),
          );
          const nativeStatus = notification.update._meta?.["cognition.ai/statusEnum"];
          if (run !== undefined && (nativeStatus === "blocked" || nativeStatus === "working")) {
            yield* changeRun(
              session,
              run.id,
              nativeStatus === "blocked" ? "waiting" : "running",
            ).pipe(
              Effect.mapError(
                (cause) =>
                  new AcpError.AcpTransportError({ operation: "read-input-stream", cause }),
              ),
            );
          }
        }
      }),
    );
    const ask = Effect.fn("DevinCloud.ask")(function* (
      parts: HopliteCloudQuestion["parts"],
      answer: PendingQuestion["answer"],
    ) {
      const questionId = yield* random.uuidV4();
      const runId =
        session.saved.runs.find((run) => run.status === "running" || run.status === "waiting")
          ?.id ?? session.saved.runs.at(-1)?.id;
      session.pending.set(questionId, { question: { questionId, runId, parts }, answer });
      if (runId !== undefined) yield* changeRun(session, runId, "waiting");
      return questionId;
    });
    yield* session.client.handleRequestPermission((params) =>
      Effect.gen(function* () {
        if (params.sessionId !== session.saved.sessionId)
          return { outcome: { outcome: "cancelled" } };
        const response = yield* Deferred.make<AcpSchema.RequestPermissionResponse>();
        const questionId = yield* ask(
          [
            {
              question: params.title ?? params.toolCall.title ?? "Devin requests permission",
              options: params.options.map((option) => ({
                label: option.name,
                description: option.kind,
              })),
            },
          ],
          (answer) => {
            const option = params.options.find(
              (item) => item.optionId === answer || item.name === answer,
            );
            if (answer !== null && option === undefined)
              return Effect.fail(
                failure("unsupported", "Choose one of Devin's permission options."),
              );
            return Deferred.succeed(response, {
              outcome:
                option === undefined
                  ? { outcome: "cancelled" }
                  : { outcome: "selected", optionId: option.optionId },
            }).pipe(Effect.asVoid);
          },
        );
        return yield* Deferred.await(response).pipe(
          Effect.ensuring(Effect.sync(() => session.pending.delete(questionId))),
        );
      }).pipe(
        Effect.mapError(
          (cause) =>
            new AcpError.AcpTransportError({
              operation: "call-rpc",
              method: "session/request_permission",
              cause,
            }),
        ),
      ),
    );
    yield* session.client.handleElicitation((params) =>
      Effect.gen(function* () {
        if (params.mode !== "form" || !("requestedSchema" in params)) return { action: "decline" };
        const form = parseElicitationForm(params.requestedSchema, params.message, {
          allowOther: params._meta?.["cognition.ai/allowOther"] === true,
        });
        if (form === undefined) return { action: "decline" };
        const response = yield* Deferred.make<AcpSchema.CreateElicitationResponse>();
        const questionId = yield* ask(
          form.questions.map((question) => ({
            question:
              form.questions.length > 1
                ? `${question.id}: ${question.question}`
                : question.question,
            options: question.options.map((option) => ({
              label: option.label,
              description: option.description,
            })),
          })),
          (answer) => {
            if (answer === null)
              return Deferred.succeed(response, { action: "cancel" }).pipe(Effect.asVoid);
            const first = form.questions[0];
            const parsed = decodeAnswers(answer);
            const selected =
              first?.options.find((option) => option.label === answer)?.value ?? answer;
            const answers =
              Option.getOrUndefined(parsed) ??
              (form.questions.length === 1 && first !== undefined
                ? { [first.id]: selected }
                : undefined);
            const content = answers === undefined ? undefined : form.content(answers);
            return content === undefined
              ? Effect.fail(
                  failure(
                    "unsupported",
                    "Answer each Devin question with its field id in a JSON object.",
                  ),
                )
              : Deferred.succeed(response, { action: "accept", content }).pipe(Effect.asVoid);
          },
        );
        return yield* Deferred.await(response).pipe(
          Effect.ensuring(Effect.sync(() => session.pending.delete(questionId))),
        );
      }).pipe(
        Effect.mapError(
          (cause) =>
            new AcpError.AcpTransportError({
              operation: "call-rpc",
              method: "elicitation/create",
              cause,
            }),
        ),
      ),
    );
  });

  const attach = Effect.fn("DevinCloud.attach")(function* (
    saved: typeof SavedTask.Type,
    connection: {
      readonly client: AcpClient.AcpClient["Service"];
      readonly isAlive: () => boolean;
    },
    scope: Scope.Closeable,
  ) {
    const session: Session = {
      saved,
      ...connection,
      scope,
      entries: [],
      pending: new Map(),
      lock: yield* Semaphore.make(1),
      turns: yield* Semaphore.make(1),
      events: yield* PubSub.bounded<CloudTaskChatEvent>(64),
      replaying: true,
      activeRunId: undefined,
    };
    yield* installHandlers(session);
    sessions.set(saved.sessionId, session);
    return session;
  });

  const close = Effect.fn("DevinCloud.close")(function* (id: string) {
    const session = sessions.get(id);
    if (session === undefined) return;
    sessions.delete(id);
    yield* PubSub.shutdown(session.events);
    yield* Scope.close(session.scope, Exit.void);
  });
  yield* Effect.addFinalizer(() => Effect.forEach([...sessions.keys()], close, { discard: true }));

  const room = Effect.gen(function* () {
    if (sessions.size < MAX_CONNECTIONS) return;
    for (const [id, session] of sessions) {
      if (
        session.pending.size === 0 &&
        session.saved.runs.every((run) => !["queued", "running", "waiting"].includes(run.status))
      ) {
        yield* close(id);
        return;
      }
    }
    return yield* failure(
      "unavailable",
      "Devin Cloud already has 50 open tasks. Stop an active task before starting another.",
    );
  });

  const sessionFor = (id: string) =>
    opening.withPermit(
      Effect.gen(function* () {
        const existing = sessions.get(id);
        if (existing?.isAlive()) return existing;
        if (existing !== undefined) yield* close(id);
        const stored = yield* secrets.get(secretName(id)).pipe(Effect.mapError(unavailable));
        if (Option.isNone(stored))
          return yield* failure("not_found", "This environment has no such Devin Cloud task.");
        const saved = yield* decodeTask(decoder.decode(stored.value)).pipe(
          Effect.mapError(unavailable),
        );
        yield* room;
        const scope = yield* Scope.make();
        return yield* Effect.gen(function* () {
          const connection = yield* openClient;
          const session = yield* attach(saved, connection, scope);
          const loaded = yield* connection.client.agent
            .loadSession({ sessionId: id, cwd, mcpServers: [] })
            .pipe(Effect.mapError(unavailable));
          session.replaying = false;
          // Queued prompts have not reached Devin; a restart must not report them as completed.
          session.saved = {
            ...session.saved,
            runs: session.saved.runs.map((run) =>
              run.status === "queued"
                ? {
                    ...run,
                    status: "failed",
                    reply:
                      "T3 restarted before this message was sent. Send it again to continue the Devin task.",
                  }
                : run,
            ),
          };
          yield* persist(session);
          const status = loaded._meta?.["cognition.ai/sessionStatus"];
          const reason = loaded._meta?.["cognition.ai/statusReason"];
          const run = session.saved.runs.at(-1);
          if (run !== undefined && ["queued", "running", "waiting"].includes(run.status)) {
            if (status === "error") yield* changeRun(session, run.id, "failed");
            else if (loaded._meta?.["cognition.ai/statusEnum"] === "blocked")
              yield* changeRun(session, run.id, "waiting");
            else if (status === "suspended" || status === "exit") {
              yield* changeRun(session, run.id, reason === "finished" ? "completed" : "cancelled");
            }
          }
          return session;
        }).pipe(
          Scope.provide(scope),
          Effect.onError(() => close(id).pipe(Effect.andThen(Scope.close(scope, Exit.void)))),
        );
      }),
    );

  const read = Effect.fn("DevinCloud.read")(function* (id: string, runId?: string) {
    const session = yield* sessionFor(id);
    const run =
      runId === undefined
        ? session.saved.runs.at(-1)
        : session.saved.runs.find((candidate) => candidate.id === runId);
    if (run === undefined) return yield* failure("not_found", "Devin Cloud has no such run.");
    const reply =
      run.id === session.activeRunId ||
      (session.activeRunId === undefined && ["running", "waiting"].includes(run.status))
        ? (latestReply(session.entries) ?? run.reply)
        : run.reply;
    const pullRequestUrl =
      reply?.match(/https:\/\/github\.com\/[^\s/]+\/[^\s/]+\/pull\/\d+/g)?.at(-1) ?? null;
    return {
      task: {
        threadId: `devin:${id}`,
        projectId: session.saved.repo,
        title: session.saved.title,
        status:
          run.status === "completed"
            ? "ready"
            : run.status === "cancelled"
              ? "blocked"
              : run.status,
        latestReply: reply,
        pullRequestUrl,
      },
      run: { id: run.id, status: run.status },
    } satisfies HopliteTaskRead;
  });

  const send = Effect.fn("DevinCloud.send")(function* (id: string, message: string) {
    const session = yield* sessionFor(id);
    if (
      session.saved.runs.filter((run) => ["running", "queued", "waiting"].includes(run.status))
        .length >= MAX_CONNECTIONS
    ) {
      return yield* failure(
        "unavailable",
        "Devin Cloud already has 50 queued messages for this task.",
      );
    }
    const runId = yield* random.uuidV4();
    session.saved = {
      ...session.saved,
      runs: [
        ...session.saved.runs,
        { id: runId, status: "queued", reply: null } satisfies typeof Run.Type,
      ].slice(-MAX_CONNECTIONS),
    };
    yield* persist(session);
    yield* session.turns
      .withPermit(
        Effect.gen(function* () {
          if (session.saved.runs.find((run) => run.id === runId)?.status === "cancelled") return;
          session.activeRunId = runId;
          yield* changeRun(session, runId, "running");
          const result = yield* session.client.agent
            .prompt({ sessionId: id, prompt: [{ type: "text", text: message }] })
            .pipe(Effect.result);
          if (session.saved.runs.find((run) => run.id === runId)?.status === "cancelled") return;
          yield* changeRun(
            session,
            runId,
            result._tag === "Failure"
              ? "failed"
              : result.success.stopReason === "cancelled"
                ? "cancelled"
                : result.success.stopReason === "end_turn"
                  ? "completed"
                  : "failed",
          );
        }).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              session.activeRunId = undefined;
            }),
          ),
        ),
      )
      .pipe(
        Effect.catch(() => Effect.logWarning("Devin Cloud task state could not be saved.")),
        Effect.forkIn(session.scope),
      );
    return { runId };
  });

  const start = Effect.fn("DevinCloud.start")(function* (input: HopliteCloudStartTaskInput) {
    if (input.agent !== undefined || input.template !== undefined || input.model !== undefined)
      return yield* failure(
        "unsupported",
        "Devin Cloud runs its own agent and account defaults; leave agent, template and model out.",
      );
    if (input.repo === undefined)
      return yield* failure("project_required", "Name the GitHub repo (owner/name) to work in.");
    const session = yield* opening.withPermit(
      Effect.gen(function* () {
        yield* room;
        const scope = yield* Scope.make();
        return yield* Effect.gen(function* () {
          const connection = yield* openClient;
          const created = yield* connection.client.agent
            .createSession({ cwd, mcpServers: [] })
            .pipe(Effect.mapError(unavailable));
          const saved = {
            sessionId: created.sessionId,
            title: input.title ?? input.prompt.slice(0, 80),
            repo: input.repo ?? "devin",
            runs: [],
          };
          const session = yield* attach(saved, connection, scope);
          session.replaying = false;
          yield* persist(session);
          return session;
        }).pipe(
          Scope.provide(scope),
          Effect.onError(() => Scope.close(scope, Exit.void)),
        );
      }),
    );
    const { runId } = yield* send(
      session.saved.sessionId,
      `Work in GitHub repository ${input.repo}.\n\n${input.prompt}`,
    );
    return {
      task: (yield* read(session.saved.sessionId)).task,
      runId,
    } satisfies HopliteStartedTask;
  });

  const stop = Effect.fn("DevinCloud.stop")(function* (id: string) {
    const session = yield* sessionFor(id);
    for (const pending of session.pending.values()) yield* pending.answer(null);
    yield* session.client.agent.cancel({ sessionId: id }).pipe(Effect.mapError(unavailable));
    for (const run of session.saved.runs)
      if (["running", "queued", "waiting"].includes(run.status))
        yield* changeRun(session, run.id, "cancelled");
    return yield* read(id);
  });

  return DevinCloud.of({
    verify: Effect.scoped(
      Effect.gen(function* () {
        const { client } = yield* openClient;
        yield* client.agent
          .listSessions({})
          .pipe(
            Effect.mapError(() =>
              failure(
                "not_connected",
                "Run `devin auth login` on this environment, then connect Devin Cloud again.",
              ),
            ),
          );
      }),
    ),
    start,
    read,
    send,
    stop,
    questions: Effect.fn("DevinCloud.questions")((id) =>
      Effect.map(sessionFor(id), (session) =>
        [...session.pending.values()].map((pending) => pending.question),
      ),
    ),
    answer: Effect.fn("DevinCloud.answer")(function* (id, questionId, answer) {
      const session = yield* sessionFor(id);
      const pending = session.pending.get(questionId);
      if (pending === undefined)
        return yield* failure("not_found", "Devin Cloud has no such pending question.");
      yield* pending.answer(answer);
      const runId = pending.question.runId ?? null;
      if (runId !== null) yield* changeRun(session, runId, "running");
      return { runId };
    }),
    watch: (id) =>
      Stream.unwrap(
        Effect.gen(function* () {
          const session = yield* sessionFor(id);
          const subscription = yield* PubSub.subscribe(session.events);
          return Stream.concat(
            Stream.fromArray([
              { _tag: "replace", entries: session.entries },
              {
                _tag: "live",
                running: session.saved.runs.some((run) =>
                  ["running", "queued", "waiting"].includes(run.status),
                ),
              },
            ] satisfies ReadonlyArray<CloudTaskChatEvent>),
            Stream.fromSubscription(subscription),
          );
        }),
      ),
    disconnect: Effect.suspend(() =>
      Effect.forEach([...sessions.keys()], close, { discard: true }),
    ),
  });
});

export const layer = Layer.effect(DevinCloud, make);
