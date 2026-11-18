import {
  type HopliteCloudAnswerInput,
  HopliteCloudError,
  type HopliteCloudErrorCode,
  type HopliteCloudGetTaskInput,
  HopliteCloudPreview,
  type HopliteCloudPreviewInput,
  type HopliteCloudQuestion,
  type HopliteCloudSendMessageInput,
  type HopliteCloudStartTaskInput,
  type HopliteCloudStatus,
  type HopliteCloudTask,
  HopliteCloudThreadStatus,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";

export const HOPLITE_API_BASE_URL = "https://api.hoplite.sh";
export const HOPLITE_API_KEY_SECRET = "hoplite-cloud-api-key";

const REQUEST_TIMEOUT = "20 seconds";
const MAX_PROJECT_PAGES = 10;
const MAX_REPLY_LENGTH = 4_000;

const ProjectRecord = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  repos: Schema.optional(Schema.Array(Schema.Struct({ repoFullName: Schema.String }))),
});
const ProjectsPage = Schema.Struct({
  projects: Schema.Array(ProjectRecord),
  nextCursor: Schema.optional(Schema.NullOr(Schema.String)),
});

const GitHubRepositories = Schema.Struct({
  repositories: Schema.Array(Schema.Struct({ id: Schema.String, fullName: Schema.String })),
});
const CreatedProject = Schema.Struct({ project: Schema.Struct({ id: Schema.String }) });

// Accepts `owner/name`, a GitHub URL, or a clone URL; GitHub names are case-insensitive.
const normalizeRepo = (repo: string) =>
  repo
    .trim()
    .replace(/^(?:https?:\/\/|git@)?github\.com[/:]/i, "")
    .replace(/\.git$/i, "")
    .replace(/\/+$/, "")
    .toLowerCase();

const ThreadRecord = Schema.Struct({
  id: Schema.String,
  projectId: Schema.String,
  title: Schema.optional(Schema.NullOr(Schema.String)),
  status: HopliteCloudThreadStatus,
  pullRequests: Schema.optional(Schema.Array(Schema.Struct({ url: Schema.String }))),
});
const ThreadResponse = Schema.Struct({ thread: ThreadRecord });
const StartedRun = Schema.optional(Schema.NullOr(Schema.Struct({ id: Schema.String })));
const CreateThreadResponse = Schema.Struct({ thread: ThreadRecord, run: StartedRun });
const AppendMessageResponse = Schema.Struct({ run: StartedRun });
const StopResponse = Schema.Struct({ ok: Schema.Boolean });

const RunStatus = Schema.Literals([
  "queued",
  "running",
  "waiting",
  "completed",
  "failed",
  "cancelled",
]);
export type HopliteRunStatus = typeof RunStatus.Type;

const RunStateResponse = Schema.Struct({
  run: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        runId: Schema.String,
        status: RunStatus,
        assistantMessage: Schema.optional(Schema.NullOr(Schema.Struct({ content: Schema.String }))),
      }),
    ),
  ),
});

const QuestionsResponse = Schema.Struct({
  questions: Schema.Array(
    Schema.Struct({
      questionId: Schema.String,
      request: Schema.Struct({
        questions: Schema.Array(
          Schema.Struct({
            question: Schema.String,
            options: Schema.Array(
              Schema.Struct({ label: Schema.String, description: Schema.optional(Schema.String) }),
            ),
          }),
        ),
      }),
    }),
  ),
});
const AnswerResponse = Schema.Struct({
  result: Schema.Struct({ runId: Schema.optional(Schema.String) }),
});

const ModelsResponse = Schema.Struct({
  models: Schema.optional(Schema.Array(Schema.Struct({ id: Schema.String, name: Schema.String }))),
});

// "GPT 6 Luna", "gpt-6 luna" and "gpt-6-luna" all name one model.
const modelKey = (name: string) => name.toLowerCase().replace(/[^a-z0-9.]+/g, "");

const ActiveRunResponse = Schema.Struct({
  activeRun: Schema.optional(Schema.NullOr(Schema.Struct({ runId: Schema.String }))),
});

const PreviewResponse = Schema.Struct({
  preview: Schema.Struct({
    status: HopliteCloudPreview.fields.status,
    url: Schema.optional(Schema.String),
    reason: Schema.optional(Schema.String),
  }),
});

/** The thread's latest run, which `run-state` reports and `stop` must name. */
export interface HopliteRun {
  readonly id: string;
  readonly status: HopliteRunStatus;
}

export interface HopliteTaskRead {
  readonly task: HopliteCloudTask;
  readonly run: HopliteRun | null;
}

export interface HopliteStartedTask {
  readonly task: HopliteCloudTask;
  /** Absent while Hoplite still prepares the thread. */
  readonly runId: string | null;
}

export class HopliteCloud extends Context.Service<
  HopliteCloud,
  {
    readonly status: Effect.Effect<HopliteCloudStatus, HopliteCloudError>;
    /** Whether a key is stored, without asking Hoplite. */
    readonly connected: Effect.Effect<boolean>;
    readonly connect: (apiKey: string) => Effect.Effect<HopliteCloudStatus, HopliteCloudError>;
    readonly disconnect: Effect.Effect<HopliteCloudStatus, HopliteCloudError>;
    readonly startTask: (
      input: HopliteCloudStartTaskInput,
    ) => Effect.Effect<HopliteStartedTask, HopliteCloudError>;
    readonly getTask: (
      input: HopliteCloudGetTaskInput,
    ) => Effect.Effect<HopliteCloudTask, HopliteCloudError>;
    readonly readTask: (
      input: HopliteCloudGetTaskInput,
    ) => Effect.Effect<HopliteTaskRead, HopliteCloudError>;
    /** Returns the run the message started, or null when it waits behind the active one. */
    readonly sendMessage: (
      input: HopliteCloudSendMessageInput,
    ) => Effect.Effect<{ readonly runId: string | null }, HopliteCloudError>;
    readonly stopTask: (
      input: HopliteCloudGetTaskInput,
    ) => Effect.Effect<HopliteCloudTask, HopliteCloudError>;
    readonly preview: (
      input: HopliteCloudPreviewInput,
    ) => Effect.Effect<HopliteCloudPreview, HopliteCloudError>;
    readonly listQuestions: (
      input: HopliteCloudGetTaskInput,
    ) => Effect.Effect<ReadonlyArray<HopliteCloudQuestion>, HopliteCloudError>;
    /** Returns the run that resumes with the answer, when Hoplite names one. */
    readonly answerQuestion: (
      input: HopliteCloudAnswerInput,
    ) => Effect.Effect<{ readonly runId: string | null }, HopliteCloudError>;
  }
>()("t3/hopliteCloud/HopliteCloudService/HopliteCloud") {}

const MESSAGES: Record<HopliteCloudErrorCode, string> = {
  not_connected: "Hoplite is not connected. Add a Hoplite API key in Settings > Environments.",
  invalid_key: "Hoplite rejected the API key. Create a new key and connect again.",
  forbidden: "The Hoplite API key lacks the permission for this action.",
  not_found: "Hoplite has no such project or thread for this key.",
  project_required: "Name the GitHub repo (owner/name) to work in.",
  repo_unavailable:
    "Hoplite's GitHub app cannot see that repository. Install it on the repository from Hoplite, then try again.",
  model_unavailable: "Hoplite has no such model for this key.",
  rate_limited: "Hoplite is rate limiting this key. Try again in a minute.",
  unavailable: "Hoplite could not be reached.",
};

const failure = (code: HopliteCloudErrorCode) =>
  new HopliteCloudError({ code, message: MESSAGES[code] });

const codeForStatus = (status: number): HopliteCloudErrorCode => {
  if (status === 401) return "invalid_key";
  if (status === 403) return "forbidden";
  if (status === 404) return "not_found";
  if (status === 429) return "rate_limited";
  return "unavailable";
};

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

const make = Effect.gen(function* () {
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const httpClient = yield* HttpClient.HttpClient;
  const random = yield* SecureRandom.SecureRandom;

  const readSecret = (name: string) =>
    secrets.get(name).pipe(
      Effect.map(Option.map((bytes) => textDecoder.decode(bytes))),
      Effect.mapError(() => failure("unavailable")),
    );
  const saveSecret = (name: string, value: string) =>
    secrets
      .set(name, textEncoder.encode(value))
      .pipe(Effect.mapError(() => failure("unavailable")));
  const removeSecret = (name: string) =>
    secrets.remove(name).pipe(Effect.mapError(() => failure("unavailable")));
  const requireKey = readSecret(HOPLITE_API_KEY_SECRET).pipe(
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.fail(failure("not_connected")),
        onSome: Effect.succeed,
      }),
    ),
  );

  // Errors keep only the status: an HttpClientError carries the request, and with it the key.
  const send = <A, I>(
    apiKey: string,
    request: HttpClientRequest.HttpClientRequest,
    schema: Schema.Codec<A, I>,
  ): Effect.Effect<A, HopliteCloudError> =>
    httpClient.execute(request.pipe(HttpClientRequest.bearerToken(apiKey))).pipe(
      Effect.mapError(() => failure("unavailable")),
      Effect.flatMap((response) =>
        response.status >= 200 && response.status < 300
          ? HttpClientResponse.schemaBodyJson(schema)(response).pipe(
              Effect.mapError(() => failure("unavailable")),
            )
          : Effect.fail(failure(codeForStatus(response.status))),
      ),
      Effect.timeoutOrElse({
        duration: REQUEST_TIMEOUT,
        orElse: () => Effect.fail(failure("unavailable")),
      }),
      Effect.tapError((error) => Effect.logWarning("hoplite-cloud.request-failed", error.code)),
      Effect.withTracerEnabled(false),
    );

  const listProjects = Effect.fn("HopliteCloud.listProjects")(function* (apiKey: string) {
    const projects: Array<typeof ProjectRecord.Type> = [];
    let cursor: string | null = null;
    for (let page = 0; page < MAX_PROJECT_PAGES; page++) {
      const request: HttpClientRequest.HttpClientRequest = HttpClientRequest.get(
        `${HOPLITE_API_BASE_URL}/api/projects`,
      ).pipe(
        HttpClientRequest.setUrlParams({
          pagination: "cursor",
          limit: "100",
          ...(cursor === null ? {} : { cursor }),
        }),
      );
      const result: typeof ProjectsPage.Type = yield* send(apiKey, request, ProjectsPage);
      projects.push(...result.projects);
      cursor = result.nextCursor ?? null;
      if (cursor === null) break;
    }
    return projects;
  });

  const statusFor = Effect.fn("HopliteCloud.statusFor")(function* (apiKey: string) {
    return yield* listProjects(apiKey).pipe(
      Effect.map((): HopliteCloudStatus => ({ connected: true, problem: null })),
      // A saved key that stops working stays connected so the user can see why and replace it.
      Effect.catch((error) =>
        Effect.succeed<HopliteCloudStatus>({ connected: true, problem: error.message }),
      ),
    );
  });

  const disconnectedStatus: HopliteCloudStatus = { connected: false, problem: null };

  const status = readSecret(HOPLITE_API_KEY_SECRET).pipe(
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.succeed(disconnectedStatus),
        onSome: statusFor,
      }),
    ),
    Effect.withSpan("HopliteCloud.status"),
  );

  const connect = Effect.fn("HopliteCloud.connect")(function* (apiKey: string) {
    // Check the key before saving it so a typo never replaces a working one.
    yield* listProjects(apiKey);
    yield* saveSecret(HOPLITE_API_KEY_SECRET, apiKey);
    return yield* statusFor(apiKey);
  });

  const disconnect = Effect.gen(function* () {
    yield* removeSecret(HOPLITE_API_KEY_SECRET);
    return disconnectedStatus;
  }).pipe(Effect.withSpan("HopliteCloud.disconnect"));

  const threadPath = (threadId: string) =>
    `${HOPLITE_API_BASE_URL}/api/threads/${encodeURIComponent(threadId)}`;
  const idempotent = (clientRequestId: string | undefined) =>
    Effect.map(
      clientRequestId === undefined ? random.uuidV4() : Effect.succeed(clientRequestId),
      (key) => HttpClientRequest.setHeader("Idempotency-Key", `t3code:${key}`),
    );
  // run-state without a runId reports the latest finished run, never one queued, running or
  // waiting on a question, so the active run is asked for by id. A thread still preparing has none.
  const readRunState = Effect.fn("HopliteCloud.readRunState")(function* (
    apiKey: string,
    threadId: string,
  ) {
    const active = yield* send(
      apiKey,
      HttpClientRequest.get(`${threadPath(threadId)}/active-run`),
      ActiveRunResponse,
    ).pipe(Effect.option);
    const activeRunId = Option.getOrUndefined(active)?.activeRun?.runId;
    const state = yield* send(
      apiKey,
      HttpClientRequest.get(`${threadPath(threadId)}/run-state`).pipe(
        HttpClientRequest.setUrlParams(activeRunId === undefined ? {} : { runId: activeRunId }),
      ),
      RunStateResponse,
    ).pipe(Effect.option);
    return Option.getOrUndefined(state)?.run ?? null;
  });

  const readTask = Effect.fn("HopliteCloud.readTask")(function* ({
    threadId,
  }: HopliteCloudGetTaskInput) {
    const apiKey = yield* requireKey;
    const { thread } = yield* send(
      apiKey,
      HttpClientRequest.get(threadPath(threadId)),
      ThreadResponse,
    );
    const run = yield* readRunState(apiKey, threadId);
    return {
      task: toTask(thread, run?.assistantMessage?.content ?? null),
      run: run === null ? null : { id: run.runId, status: run.status },
    } satisfies HopliteTaskRead;
  });

  const getTask = (input: HopliteCloudGetTaskInput) =>
    Effect.map(readTask(input), ({ task }) => task);

  // Hoplite would reject an unknown id; this also maps a name the user said to its id.
  const resolveModel = Effect.fn("HopliteCloud.resolveModel")(function* (
    apiKey: string,
    requested: string,
  ) {
    const { models = [] } = yield* send(
      apiKey,
      HttpClientRequest.get(`${HOPLITE_API_BASE_URL}/api/model-providers`),
      ModelsResponse,
    );
    const key = modelKey(requested);
    const match =
      models.find((model) => model.id === requested) ??
      models.find((model) => modelKey(model.id) === key || modelKey(model.name) === key);
    if (match !== undefined) return match.id;
    return yield* new HopliteCloudError({
      code: "model_unavailable",
      message: `Hoplite has no model "${requested}" for this key. Available: ${models.map((model) => model.id).join(", ") || "none"}.`,
    });
  });

  // Reuses the project that already has the repository, so its setup and secrets apply.
  const projectForRepo = Effect.fn("HopliteCloud.projectForRepo")(function* (
    apiKey: string,
    repo: string,
  ) {
    const fullName = normalizeRepo(repo);
    const projects = yield* listProjects(apiKey);
    const existing = projects.find((project) =>
      project.repos?.some((candidate) => normalizeRepo(candidate.repoFullName) === fullName),
    );
    if (existing !== undefined) return existing.id;
    const { repositories } = yield* send(
      apiKey,
      HttpClientRequest.get(`${HOPLITE_API_BASE_URL}/api/source-control/github/repositories`),
      GitHubRepositories,
    );
    const repository = repositories.find(
      (candidate) => normalizeRepo(candidate.fullName) === fullName,
    );
    if (repository === undefined) return yield* failure("repo_unavailable");
    const request = HttpClientRequest.post(`${HOPLITE_API_BASE_URL}/api/projects`).pipe(
      // Keyed by repository so two tasks starting at once create one project.
      HttpClientRequest.setHeader("Idempotency-Key", `t3code:project:${repository.id}`),
      HttpClientRequest.bodyJsonUnsafe({
        name: repository.fullName.split("/").at(-1) ?? repository.fullName,
        repositoryId: repository.id,
      }),
    );
    const { project } = yield* send(apiKey, request, CreatedProject);
    return project.id;
  });

  const startTask = Effect.fn("HopliteCloud.startTask")(function* (
    input: HopliteCloudStartTaskInput,
  ) {
    const apiKey = yield* requireKey;
    if (input.repo === undefined) return yield* failure("project_required");
    const model = input.model === undefined ? undefined : yield* resolveModel(apiKey, input.model);
    const projectId = yield* projectForRepo(apiKey, input.repo);
    const request = HttpClientRequest.post(`${HOPLITE_API_BASE_URL}/api/threads`).pipe(
      yield* idempotent(input.clientRequestId),
      HttpClientRequest.bodyJsonUnsafe({
        projectId,
        prompt: input.prompt,
        ...(input.title === undefined ? {} : { title: input.title }),
        ...(model === undefined ? {} : { model }),
      }),
    );
    const { thread, run } = yield* send(apiKey, request, CreateThreadResponse);
    return { task: toTask(thread, null), runId: run?.id ?? null } satisfies HopliteStartedTask;
  });

  const sendMessage = Effect.fn("HopliteCloud.sendMessage")(function* (
    input: HopliteCloudSendMessageInput,
  ) {
    const apiKey = yield* requireKey;
    const model = input.model === undefined ? undefined : yield* resolveModel(apiKey, input.model);
    const request = HttpClientRequest.post(`${threadPath(input.threadId)}/messages`).pipe(
      yield* idempotent(input.clientRequestId),
      HttpClientRequest.bodyJsonUnsafe({
        content: input.message,
        ...(model === undefined ? {} : { model }),
      }),
    );
    const { run } = yield* send(apiKey, request, AppendMessageResponse);
    return { runId: run?.id ?? null };
  });

  const stopTask = Effect.fn("HopliteCloud.stopTask")(function* ({
    threadId,
  }: HopliteCloudGetTaskInput) {
    const apiKey = yield* requireKey;
    // Hoplite stops only the run it is told to, so a run that finished meanwhile is never touched.
    const run = yield* readRunState(apiKey, threadId);
    if (run !== null && ["queued", "running", "waiting"].includes(run.status)) {
      const request = HttpClientRequest.post(`${threadPath(threadId)}/stop`).pipe(
        HttpClientRequest.bodyJsonUnsafe({ runId: run.runId }),
      );
      yield* send(apiKey, request, StopResponse);
    }
    return yield* getTask({ threadId });
  });

  const preview = Effect.fn("HopliteCloud.preview")(function* ({
    threadId,
    start,
  }: HopliteCloudPreviewInput) {
    const apiKey = yield* requireKey;
    const request =
      start === true
        ? HttpClientRequest.post(`${threadPath(threadId)}/preview/start`).pipe(
            yield* idempotent(undefined),
          )
        : HttpClientRequest.get(`${threadPath(threadId)}/preview`);
    const { preview } = yield* send(apiKey, request, PreviewResponse);
    return {
      status: preview.status,
      url: preview.url ?? null,
      reason: preview.reason ?? null,
    } satisfies HopliteCloudPreview;
  });

  const fetchQuestions = (apiKey: string, threadId: string) =>
    send(
      apiKey,
      HttpClientRequest.get(`${threadPath(threadId)}/questions`),
      QuestionsResponse,
    ).pipe(
      Effect.map(({ questions }) =>
        questions.map((pending): HopliteCloudQuestion => ({
          questionId: pending.questionId,
          parts: pending.request.questions.map((part) => ({
            question: part.question,
            options: part.options.map((option) => ({
              label: option.label,
              description: option.description ?? "",
            })),
          })),
        })),
      ),
    );

  const listQuestions = Effect.fn("HopliteCloud.listQuestions")(function* ({
    threadId,
  }: HopliteCloudGetTaskInput) {
    return yield* fetchQuestions(yield* requireKey, threadId);
  });

  const answerQuestion = Effect.fn("HopliteCloud.answerQuestion")(function* (
    input: HopliteCloudAnswerInput,
  ) {
    const apiKey = yield* requireKey;
    const request = HttpClientRequest.post(
      `${threadPath(input.threadId)}/questions/${encodeURIComponent(input.questionId)}`,
    ).pipe(
      yield* idempotent(input.clientRequestId),
      HttpClientRequest.bodyJsonUnsafe({ answer: input.answer }),
    );
    const { result } = yield* send(apiKey, request, AnswerResponse);
    return { runId: result.runId ?? null };
  });

  const connected = readSecret(HOPLITE_API_KEY_SECRET).pipe(
    Effect.map(Option.isSome),
    Effect.orElseSucceed(() => false),
  );

  return HopliteCloud.of({
    status,
    connected,
    connect,
    disconnect,
    startTask,
    getTask,
    readTask,
    sendMessage,
    stopTask,
    preview,
    listQuestions,
    answerQuestion,
  });
});

function toTask(thread: typeof ThreadRecord.Type, reply: string | null): HopliteCloudTask {
  return {
    threadId: thread.id,
    projectId: thread.projectId,
    title: thread.title ?? null,
    status: thread.status,
    latestReply: reply === null ? null : reply.slice(0, MAX_REPLY_LENGTH),
    pullRequestUrl: thread.pullRequests?.at(-1)?.url ?? null,
  };
}

export const layer = Layer.effect(HopliteCloud, make);
