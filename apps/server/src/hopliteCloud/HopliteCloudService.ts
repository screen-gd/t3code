import {
  type CloudSandbox,
  type CloudSandboxCreateInput,
  type CloudSandboxIdInput,
  type CloudSandboxProvider,
  type CloudSandboxRunInput,
  type CloudSandboxRunResult,
  type CloudSandboxProviderStatus,
  type CloudTaskChatEvent,
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
import type * as Duration from "effect/Duration";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Socket from "effect/socket/Socket";
import * as Stream from "effect/Stream";
import * as NodeSocket from "@effect/platform-node/NodeSocket";

import * as HostProcess from "@t3tools/shared/HostProcess";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import {
  type AgentKeys,
  type CommandResult,
  makeSessionAdapters,
  PROVIDER_NAMES,
  providerOfTask,
  type ProviderSend,
  type SessionProvider,
} from "./CloudSandboxProviders.ts";
import {
  agentTurnEnv,
  BUSY_EXIT,
  agentTurnScript,
  parseTurn,
  READ_TURN_SCRIPT,
  redact,
  STOP_SCRIPT,
} from "./CloudSandboxTasks.ts";
import { HOPLITE_ACP_URL, watchHopliteThreadChat } from "./HopliteTaskChat.ts";

export const HOPLITE_API_BASE_URL = "https://api.hoplite.sh";
export const HOPLITE_API_KEY_SECRET = "hoplite-cloud-api-key";
const CLOUD_SANDBOX_PROVIDERS: ReadonlyArray<CloudSandboxProvider> = [
  "hoplite",
  "e2b",
  "daytona",
  "agent37",
];
/** Hoplite keeps the name its key had before other providers were added. */
const apiKeySecretFor = (provider: CloudSandboxProvider) =>
  provider === "hoplite" ? HOPLITE_API_KEY_SECRET : `cloud-sandbox-${provider}-api-key`;

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
    /** Whether any provider's key is stored, without asking it. */
    readonly connected: Effect.Effect<boolean>;
    readonly connect: (
      provider: CloudSandboxProvider,
      apiKey: string,
    ) => Effect.Effect<HopliteCloudStatus, HopliteCloudError>;
    readonly disconnect: (
      provider: CloudSandboxProvider,
    ) => Effect.Effect<HopliteCloudStatus, HopliteCloudError>;
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
    readonly createSandbox: (
      input: CloudSandboxCreateInput,
    ) => Effect.Effect<CloudSandbox, HopliteCloudError>;
    readonly runInSandbox: (
      input: CloudSandboxRunInput,
    ) => Effect.Effect<CloudSandboxRunResult, HopliteCloudError>;
    readonly deleteSandbox: (input: CloudSandboxIdInput) => Effect.Effect<void, HopliteCloudError>;
    /** A Hoplite thread's chat: its recent history, then live activity until unsubscribed. */
    readonly watchThreadChat: (
      hopliteThreadId: string,
    ) => Stream.Stream<CloudTaskChatEvent, HopliteCloudError>;
  }
>()("t3/hopliteCloud/HopliteCloudService/HopliteCloud") {}

const messageFor = (code: HopliteCloudErrorCode, name: string): string => {
  switch (code) {
    case "not_connected":
      return `${name} is not connected. Add a ${name} API key in Settings > Environments.`;
    case "invalid_key":
      return `${name} rejected the API key. Create a new key and connect again.`;
    case "forbidden":
      return `The ${name} API key lacks the permission for this action.`;
    case "not_found":
      return `${name} has no such project or thread for this key.`;
    case "project_required":
      return "Name the GitHub repo (owner/name) to work in.";
    case "repo_unavailable":
      return `${name}'s GitHub app cannot see that repository. Install it on the repository from ${name}, then try again.`;
    case "model_unavailable":
      return `${name} has no such model for this key.`;
    case "rate_limited":
      return `${name} is rate limiting this key. Try again in a minute.`;
    case "unavailable":
      return `${name} could not be reached.`;
    case "unsupported":
      return `${name}'s API cannot do this; do it from ${name} instead.`;
  }
};

// Task and question ids go into request paths sent with the key, so each must match
// its provider's own format; URL-encoding alone still lets `..` through.
const TASK_ID_FORMATS: Record<CloudSandboxProvider, RegExp> = {
  hoplite: /^thr_[A-Za-z0-9_-]{1,128}$/,
  e2b: /^[a-z0-9]{1,64}$/,
  daytona: /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/,
  agent37: /^[a-z0-9]{1,64}$/,
};
const MAX_SANDBOX_OUTPUT = 20_000;
const MAX_REMEMBERED_REQUESTS = 500;
const HOPLITE_QUESTION_ID_FORMAT = /^q_[A-Za-z0-9_-]{1,128}$/;

const invalidId = (provider: CloudSandboxProvider, what: string) =>
  Effect.fail(
    new HopliteCloudError({
      code: "not_found",
      message: `That is not a ${PROVIDER_NAMES[provider]} ${what} id.`,
    }),
  );

const taskOf = (taskId: string) => {
  const task = providerOfTask(taskId);
  return TASK_ID_FORMATS[task.provider].test(task.id)
    ? Effect.succeed(task)
    : invalidId(task.provider, "task");
};

// Each provider takes its key its own way; E2B's in-sandbox daemon gets its own token instead.
const authorize = (
  provider: CloudSandboxProvider,
  request: HttpClientRequest.HttpClientRequest,
  apiKey: string,
) => {
  const host = new URL(request.url).host;
  if (provider === "e2b") {
    return host === "api.e2b.app"
      ? HttpClientRequest.setHeader(request, "X-API-Key", apiKey)
      : request;
  }
  if (provider === "agent37" && host.endsWith(".agent37.app")) {
    return HttpClientRequest.setHeader(request, "X-Agent37-Key", apiKey);
  }
  return HttpClientRequest.bearerToken(request, apiKey);
};

const failure = (code: HopliteCloudErrorCode, provider: CloudSandboxProvider = "hoplite") =>
  new HopliteCloudError({ code, message: messageFor(code, PROVIDER_NAMES[provider]) });

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
  const environment = yield* HostProcess.Environment;
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
  const keyFor = (provider: CloudSandboxProvider) =>
    readSecret(apiKeySecretFor(provider)).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.fail(failure("not_connected", provider)),
          onSome: Effect.succeed,
        }),
      ),
    );
  const requireKey = keyFor("hoplite");

  // Errors keep only the status: an HttpClientError carries the request, and with it the key.
  const sendAs = <A, I>(
    provider: CloudSandboxProvider,
    apiKey: string,
    request: HttpClientRequest.HttpClientRequest,
    schema: Schema.Codec<A, I> | null,
    timeout: Duration.Input = REQUEST_TIMEOUT,
  ): Effect.Effect<A | undefined, HopliteCloudError> =>
    httpClient.execute(authorize(provider, request, apiKey)).pipe(
      Effect.mapError(() => failure("unavailable", provider)),
      Effect.flatMap((response) =>
        response.status < 200 || response.status >= 300
          ? Effect.fail(failure(codeForStatus(response.status), provider))
          : schema === null
            ? Effect.as(response.text.pipe(Effect.ignore), undefined)
            : HttpClientResponse.schemaBodyJson(schema)(response).pipe(
                Effect.mapError(() => failure("unavailable", provider)),
              ),
      ),
      Effect.timeoutOrElse({
        duration: timeout,
        orElse: () => Effect.fail(failure("unavailable", provider)),
      }),
      Effect.tapError((error) =>
        Effect.logWarning("hoplite-cloud.request-failed", { provider, code: error.code }),
      ),
      Effect.withTracerEnabled(false),
    );
  const sendBytes = (
    provider: SessionProvider,
    apiKey: string,
    request: HttpClientRequest.HttpClientRequest,
    timeout: Duration.Input = REQUEST_TIMEOUT,
  ): Effect.Effect<Uint8Array, HopliteCloudError> =>
    httpClient.execute(authorize(provider, request, apiKey)).pipe(
      Effect.mapError(() => failure("unavailable", provider)),
      Effect.flatMap((response) =>
        response.status < 200 || response.status >= 300
          ? Effect.fail(failure(codeForStatus(response.status), provider))
          : response.arrayBuffer.pipe(
              Effect.map((buffer) => new Uint8Array(buffer)),
              Effect.mapError(() => failure("unavailable", provider)),
            ),
      ),
      Effect.timeoutOrElse({
        duration: timeout,
        orElse: () => Effect.fail(failure("unavailable", provider)),
      }),
      Effect.withTracerEnabled(false),
    );
  const sessions = makeSessionAdapters({
    send: sendAs as ProviderSend,
    sendBytes,
    failure: (provider, code) => Effect.fail(failure(code, provider)),
  });
  const sessionOf = (provider: SessionProvider) => sessions[provider];
  // The agent in a sandbox runs on this machine's model key and GitHub token.
  const agentKeys = Effect.fn("HopliteCloud.agentKeys")(function* () {
    const anthropicApiKey = environment.ANTHROPIC_API_KEY;
    if (anthropicApiKey === undefined || anthropicApiKey === "") {
      return yield* new HopliteCloudError({
        code: "not_connected",
        message:
          "Set ANTHROPIC_API_KEY where T3 Code runs: the agent in the sandbox runs Claude Code on it.",
      });
    }
    const githubToken = environment.GH_TOKEN || environment.GITHUB_TOKEN || undefined;
    return { anthropicApiKey, githubToken } satisfies AgentKeys;
  });
  // Every key a sandbox can hold, to keep out of anything that comes back from it.
  const sandboxSecrets = (apiKey: string) =>
    Effect.option(agentKeys()).pipe(
      Effect.map(
        Option.match({
          onNone: () => [apiKey],
          onSome: (agent) => [apiKey, agent.anthropicApiKey, agent.githubToken],
        }),
      ),
    );
  const turnFailed = (
    provider: SessionProvider,
    result: CommandResult,
    secrets: ReadonlyArray<string | undefined>,
  ) =>
    new HopliteCloudError({
      code: "unavailable",
      message: `The agent in the ${PROVIDER_NAMES[provider]} sandbox did not start: ${redact(result.output, secrets).trim().slice(-500)}`,
    });
  // A retry with the same clientRequestId gets the first call's result, not another sandbox or turn.
  const remembered = <A>(
    cache: Map<string, A>,
    key: string | undefined,
    effect: Effect.Effect<A, HopliteCloudError>,
  ): Effect.Effect<A, HopliteCloudError> => {
    if (key === undefined) return effect;
    const hit = cache.get(key);
    if (hit !== undefined) return Effect.succeed(hit);
    return Effect.tap(effect, (value) =>
      Effect.sync(() => {
        cache.set(key, value);
        const oldest = cache.keys().next();
        if (cache.size > MAX_REMEMBERED_REQUESTS && oldest.done !== true)
          cache.delete(oldest.value);
      }),
    );
  };
  const startedTasks = new Map<string, HopliteStartedTask>();
  const sentMessages = new Map<string, { readonly runId: null }>();
  const sessionTask = Effect.fn("HopliteCloud.sessionTask")(function* (
    provider: SessionProvider,
    id: string,
  ) {
    const apiKey = yield* keyFor(provider);
    const result = yield* sessionOf(provider).exec(apiKey, id, READ_TURN_SCRIPT, {});
    // Redacted before parsing, so neither the reply's cut nor its link can split a key.
    const turn = parseTurn({
      ...result,
      output: redact(result.output, yield* sandboxSecrets(apiKey)),
    });
    return {
      task: {
        threadId: `${provider}:${id}`,
        projectId: provider,
        title: null,
        status: turn.thread,
        latestReply: turn.latestReply,
        pullRequestUrl: turn.pullRequestUrl,
      },
      run: turn.run,
    } satisfies HopliteTaskRead;
  });
  const send = <A, I>(
    apiKey: string,
    request: HttpClientRequest.HttpClientRequest,
    schema: Schema.Codec<A, I>,
  ): Effect.Effect<A, HopliteCloudError> =>
    Effect.map(sendAs("hoplite", apiKey, request, schema), (value) => value as A);

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

  const verifyKey = (provider: CloudSandboxProvider, apiKey: string) =>
    provider === "hoplite"
      ? Effect.asVoid(listProjects(apiKey))
      : sessionOf(provider).verify(apiKey);

  const providerStatus = (provider: CloudSandboxProvider) =>
    readSecret(apiKeySecretFor(provider)).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.succeed<CloudSandboxProviderStatus>({
              provider,
              connected: false,
              problem: null,
            }),
          onSome: (apiKey) =>
            verifyKey(provider, apiKey).pipe(
              Effect.as<CloudSandboxProviderStatus>({ provider, connected: true, problem: null }),
              // A saved key that stops working stays connected so the user can see why and replace it.
              Effect.catch((error) =>
                Effect.succeed<CloudSandboxProviderStatus>({
                  provider,
                  connected: true,
                  problem: error.message,
                }),
              ),
            ),
        }),
      ),
    );

  const status = Effect.forEach(CLOUD_SANDBOX_PROVIDERS, providerStatus, {
    concurrency: "unbounded",
  }).pipe(
    Effect.map((providers): HopliteCloudStatus => {
      const hoplite = providers.find((entry) => entry.provider === "hoplite")!;
      return { connected: hoplite.connected, problem: hoplite.problem, providers };
    }),
    Effect.withSpan("HopliteCloud.status"),
  );

  const connect = Effect.fn("HopliteCloud.connect")(function* (
    provider: CloudSandboxProvider,
    apiKey: string,
  ) {
    // Check the key before saving it so a typo never replaces a working one.
    yield* verifyKey(provider, apiKey);
    yield* saveSecret(apiKeySecretFor(provider), apiKey);
    return yield* status;
  });

  const disconnect = Effect.fn("HopliteCloud.disconnect")(function* (
    provider: CloudSandboxProvider,
  ) {
    yield* removeSecret(apiKeySecretFor(provider));
    return yield* status;
  });

  const storedProviders = Effect.filter(CLOUD_SANDBOX_PROVIDERS, (provider) =>
    readSecret(apiKeySecretFor(provider)).pipe(
      Effect.map(Option.isSome),
      Effect.orElseSucceed(() => false),
    ),
  );

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
    threadId: taskId,
  }: HopliteCloudGetTaskInput) {
    const { provider, id: threadId } = yield* taskOf(taskId);
    if (provider !== "hoplite") return yield* sessionTask(provider, threadId);
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

  // Hoplite first, as it was the only provider before; then whichever key is stored.
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

  const startSandboxTask = Effect.fn("HopliteCloud.startSandboxTask")(function* (
    provider: SessionProvider,
    input: HopliteCloudStartTaskInput,
  ) {
    const keys = yield* agentKeys();
    const apiKey = yield* keyFor(provider);
    const adapter = sessionOf(provider);
    const id = yield* adapter.create(apiKey);
    // A task that never started is never reported, so its sandbox goes too.
    const removeSandbox = adapter.remove(apiKey, id).pipe(Effect.ignore);
    const started = yield* adapter
      .exec(
        apiKey,
        id,
        agentTurnScript({ first: true }),
        agentTurnEnv(keys, input.prompt, input.repo),
      )
      .pipe(Effect.tapError(() => removeSandbox));
    if (started.exitCode !== 0) {
      yield* removeSandbox;
      return yield* turnFailed(provider, started, [apiKey, keys.anthropicApiKey, keys.githubToken]);
    }
    return {
      task: {
        threadId: `${provider}:${id}`,
        projectId: input.repo ?? provider,
        title: input.title ?? null,
        status: "running",
        latestReply: null,
        pullRequestUrl: null,
      },
      runId: "turn-1",
    } satisfies HopliteStartedTask;
  });

  const startTask = Effect.fn("HopliteCloud.startTask")(function* (
    input: HopliteCloudStartTaskInput,
  ) {
    const provider = input.provider ?? "hoplite";
    if (provider !== "hoplite") {
      if (input.model !== undefined) {
        return yield* new HopliteCloudError({
          code: "model_unavailable",
          message: `The agent in a ${PROVIDER_NAMES[provider]} sandbox is Claude Code; leave \`model\` out.`,
        });
      }
      return yield* remembered(
        startedTasks,
        input.clientRequestId === undefined ? undefined : `${provider}:${input.clientRequestId}`,
        startSandboxTask(provider, input),
      );
    }
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

  const sendSandboxMessage = Effect.fn("HopliteCloud.sendSandboxMessage")(function* (
    provider: SessionProvider,
    id: string,
    message: string,
  ) {
    const keys = yield* agentKeys();
    const apiKey = yield* keyFor(provider);
    const ran = yield* sessionOf(provider).exec(
      apiKey,
      id,
      agentTurnScript({ first: false }),
      agentTurnEnv(keys, message, undefined),
    );
    if (ran.exitCode === BUSY_EXIT) {
      return yield* new HopliteCloudError({
        code: "unavailable",
        message:
          "The task's agent is still on its last message. Wait for it to finish, or stop it.",
      });
    }
    if (ran.exitCode !== 0) {
      return yield* turnFailed(provider, ran, [apiKey, keys.anthropicApiKey, keys.githubToken]);
    }
    // The new turn shows up in the sandbox's turn count once it starts.
    return { runId: null };
  });

  const sendMessage = Effect.fn("HopliteCloud.sendMessage")(function* (
    input: HopliteCloudSendMessageInput,
  ) {
    const { provider, id } = yield* taskOf(input.threadId);
    if (provider !== "hoplite") {
      if (input.model !== undefined) return yield* failure("model_unavailable", provider);
      return yield* remembered(
        sentMessages,
        input.clientRequestId === undefined
          ? undefined
          : `${input.threadId}:${input.clientRequestId}`,
        sendSandboxMessage(provider, id, input.message),
      );
    }
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
    const session = yield* taskOf(threadId);
    if (session.provider !== "hoplite") {
      const apiKey = yield* keyFor(session.provider);
      yield* sessionOf(session.provider).exec(apiKey, session.id, STOP_SCRIPT, {});
      return yield* getTask({ threadId });
    }
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
    const { provider } = yield* taskOf(threadId);
    if (provider !== "hoplite") {
      return {
        status: "unsupported",
        url: null,
        reason: `${PROVIDER_NAMES[provider]} tasks have no preview here.`,
      } satisfies HopliteCloudPreview;
    }
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
    // The agent in a sandbox asks in its reply, which comes back as a follow-up.
    if ((yield* taskOf(threadId)).provider !== "hoplite") return [];
    return yield* fetchQuestions(yield* requireKey, threadId);
  });

  const answerQuestion = Effect.fn("HopliteCloud.answerQuestion")(function* (
    input: HopliteCloudAnswerInput,
  ) {
    const { provider } = yield* taskOf(input.threadId);
    if (provider !== "hoplite") return yield* failure("unsupported", provider);
    if (!HOPLITE_QUESTION_ID_FORMAT.test(input.questionId))
      return yield* invalidId("hoplite", "question");
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

  const connected = Effect.map(storedProviders, (stored) => stored.length > 0);

  const watchThreadChat = (hopliteThreadId: string) =>
    Stream.unwrap(
      Effect.map(requireKey, (apiKey) =>
        Stream.unwrap(
          Socket.makeWebSocket(HOPLITE_ACP_URL, {
            openTimeout: "10 seconds",
            headers: { "X-Api-Key": apiKey },
          }).pipe(
            Effect.map((socket) => watchHopliteThreadChat({ socket, hopliteThreadId })),
            Effect.provide(NodeSocket.layerWebSocketConstructor),
          ),
        ).pipe(
          Stream.mapError(
            (error) =>
              new HopliteCloudError({
                code: "unavailable",
                message: `Hoplite's chat for this task could not be loaded: ${error.message}`,
              }),
          ),
        ),
      ),
    );

  const sandboxOf = Effect.fn("HopliteCloud.sandboxOf")(function* (sandboxId: string) {
    const { provider, id } = yield* taskOf(sandboxId);
    if (provider === "hoplite") return yield* invalidId("hoplite", "sandbox");
    return { provider, id, apiKey: yield* keyFor(provider) };
  });

  const createSandbox = Effect.fn("HopliteCloud.createSandbox")(function* ({
    provider,
  }: CloudSandboxCreateInput) {
    const id = yield* sessionOf(provider).create(yield* keyFor(provider));
    return { sandboxId: `${provider}:${id}` } satisfies CloudSandbox;
  });

  // Only the provider key is used here, but a task's sandbox may hold the agent's keys.
  const runInSandbox = Effect.fn("HopliteCloud.runInSandbox")(function* (
    input: CloudSandboxRunInput,
  ) {
    const { provider, id, apiKey } = yield* sandboxOf(input.sandboxId);
    const result = yield* sessionOf(provider).exec(apiKey, id, input.command, {});
    return {
      exitCode: result.exitCode,
      output: redact(result.output, yield* sandboxSecrets(apiKey)).slice(-MAX_SANDBOX_OUTPUT),
    } satisfies CloudSandboxRunResult;
  });

  const deleteSandbox = Effect.fn("HopliteCloud.deleteSandbox")(function* ({
    sandboxId,
  }: CloudSandboxIdInput) {
    const { provider, id, apiKey } = yield* sandboxOf(sandboxId);
    yield* sessionOf(provider).remove(apiKey, id);
  });

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
    createSandbox,
    runInSandbox,
    deleteSandbox,
    watchThreadChat,
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
