import {
  type CloudSandbox,
  type CloudSandboxAgent,
  type CloudSandboxCreateInput,
  type CloudSandboxIdInput,
  type CloudSandboxProvider,
  type CloudSandboxRunInput,
  type CloudSandboxRunResult,
  type CloudSandboxProviderStatus,
  type CloudTaskChatEntry,
  type CloudTaskChatEvent,
  type HopliteCloudAnswerInput,
  HopliteCloudError,
  type HopliteCloudErrorCode,
  type HopliteCloudGetTaskInput,
  HopliteCloudPreview,
  type HopliteCloudPreviewInput,
  HopliteCloudQuestion,
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
import * as Equal from "effect/Equal";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Socket from "effect/socket/Socket";
import * as Stream from "effect/Stream";
import * as NodeSocket from "@effect/platform-node/NodeSocket";

import * as HostProcess from "@t3tools/shared/HostProcess";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as DevinCloud from "./DevinCloud.ts";
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
  agentTurnScript,
  chatIsRunning,
  parseChat,
  parseTurn,
  readChatScript,
  readTurnScript,
  redact,
  startedRunId,
  STOP_SCRIPT,
} from "./CloudSandboxTasks.ts";
import { HOPLITE_ACP_URL, watchHopliteThreadChat } from "./HopliteTaskChat.ts";
import { answerQuestionScript, readQuestionsScript } from "./CloudSandboxQuestions.ts";

export const HOPLITE_API_BASE_URL = "https://api.hoplite.sh";
export const HOPLITE_API_KEY_SECRET = "hoplite-cloud-api-key";
/** The Claude login saved in Settings, which wins over this machine's environment. */
const CLAUDE_CREDENTIAL_SECRET = "cloud-sandbox-claude-credential";
/** The OpenAI API key saved in Settings for Codex sandboxes. */
const CODEX_CREDENTIAL_SECRET = "cloud-sandbox-codex-credential";
/** Credentials a sandbox may still hold after they were replaced or removed here. */
const RETIRED_CREDENTIALS_SECRET = "cloud-sandbox-retired-credentials";
const RetiredCredentialsJson = Schema.fromJsonString(Schema.Array(Schema.String));
const decodeRetiredCredentials = Schema.decodeOption(RetiredCredentialsJson);
const encodeRetiredCredentials = Schema.encodeEffect(RetiredCredentialsJson);
const MAX_RETIRED_CREDENTIALS = 20;
const CLOUD_SANDBOX_PROVIDERS: ReadonlyArray<CloudSandboxProvider> = [
  "hoplite",
  "e2b",
  "daytona",
  "agent37",
  "devin",
];
/** Hoplite keeps the name its key had before other providers were added. */
const apiKeySecretFor = (provider: CloudSandboxProvider) =>
  provider === "hoplite" ? HOPLITE_API_KEY_SECRET : `cloud-sandbox-${provider}-api-key`;

const REQUEST_TIMEOUT = "20 seconds";
const MAX_PROJECT_PAGES = 10;
const MAX_REPLY_LENGTH = 20_000;

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
      runId: Schema.optional(Schema.String),
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
  readonly questionRunId?: string;
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
      apiKey?: string,
    ) => Effect.Effect<HopliteCloudStatus, HopliteCloudError>;
    readonly disconnect: (
      provider: CloudSandboxProvider,
    ) => Effect.Effect<HopliteCloudStatus, HopliteCloudError>;
    /** Saves the login the given sandbox agent uses, replacing any saved before. */
    readonly setAgentCredential: (
      agent: CloudSandboxAgent,
      credential: string,
    ) => Effect.Effect<HopliteCloudStatus, HopliteCloudError>;
    readonly clearAgentCredential: (
      agent: CloudSandboxAgent,
    ) => Effect.Effect<HopliteCloudStatus, HopliteCloudError>;
    readonly startTask: (
      input: HopliteCloudStartTaskInput,
    ) => Effect.Effect<HopliteStartedTask, HopliteCloudError>;
    readonly getTask: (
      input: HopliteCloudGetTaskInput,
    ) => Effect.Effect<HopliteCloudTask, HopliteCloudError>;
    readonly readTask: (
      input: HopliteCloudGetTaskInput & { readonly runId?: string; readonly title?: string },
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
    /**
     * A cloud task's chat: its recent history, then live activity until unsubscribed.
     * Each `activity` reloads the session, arriving as one `replace`.
     */
    readonly watchThreadChat: (
      taskId: string,
      activity: Stream.Stream<void>,
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
  devin: /^devin-[a-f0-9]{32}$/,
};
const MAX_SANDBOX_OUTPUT = 100_000;
const MAX_REMEMBERED_REQUESTS = 500;
const HOPLITE_QUESTION_ID_FORMAT = /^[A-Za-z0-9_-]{1,128}$/;

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
const decodeSandboxQuestions = Schema.decodeEffect(
  Schema.fromJsonString(Schema.Array(HopliteCloudQuestion)),
);

const make = Effect.gen(function* () {
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const httpClient = yield* HttpClient.HttpClient;
  const environment = yield* HostProcess.Environment;
  const random = yield* SecureRandom.SecureRandom;
  const devin = yield* DevinCloud.DevinCloud;
  const devinWrites = yield* Semaphore.make(1);

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
  const taskTitle = Effect.fn("HopliteCloud.taskTitle")(function* (
    threadId: string,
    title?: string | null,
  ) {
    const name = `cloud-task-title-${threadId.replaceAll(":", "-")}`;
    const saved = yield* readSecret(name);
    if (Option.isSome(saved)) return saved.value;
    if (title == null || title.trim() === "") return null;
    yield* saveSecret(name, title);
    return title;
  });
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
  // `claude setup-token` makes `sk-ant-oat` tokens; anything else is taken as an API key.
  const claudeVariable = (value: string): AgentKeys["agent"]["variable"] =>
    value.startsWith("sk-ant-oat") ? "CLAUDE_CODE_OAUTH_TOKEN" : "ANTHROPIC_API_KEY";
  // The agent in a sandbox signs in with the Claude login saved in Settings, else this
  // machine's Claude env vars; as in Claude Code, the API key wins when both are set.
  const claudeCredential = Effect.map(readSecret(CLAUDE_CREDENTIAL_SECRET), (saved) => {
    if (saved._tag === "Some")
      return {
        source: "settings" as const,
        value: saved.value,
        variable: claudeVariable(saved.value),
      };
    const apiKey = environment.ANTHROPIC_API_KEY;
    if (apiKey !== undefined && apiKey !== "")
      return {
        source: "environment" as const,
        value: apiKey,
        variable: "ANTHROPIC_API_KEY" as const,
      };
    const oauthToken = environment.CLAUDE_CODE_OAUTH_TOKEN;
    if (oauthToken !== undefined && oauthToken !== "")
      return {
        source: "environment" as const,
        value: oauthToken,
        variable: "CLAUDE_CODE_OAUTH_TOKEN" as const,
      };
    return undefined;
  });
  // Codex takes an API key only: the saved one, else this machine's Codex or OpenAI env var.
  const codexCredential = Effect.map(readSecret(CODEX_CREDENTIAL_SECRET), (saved) => {
    if (saved._tag === "Some")
      return {
        source: "settings" as const,
        value: saved.value,
        variable: "CODEX_API_KEY" as const,
      };
    const apiKey = environment.CODEX_API_KEY || environment.OPENAI_API_KEY || undefined;
    if (apiKey !== undefined)
      return {
        source: "environment" as const,
        value: apiKey,
        variable: "CODEX_API_KEY" as const,
      };
    return undefined;
  });
  const credentialSecretFor = (agent: CloudSandboxAgent) =>
    agent === "codex" ? CODEX_CREDENTIAL_SECRET : CLAUDE_CREDENTIAL_SECRET;
  const credentialFor = (agent: CloudSandboxAgent) =>
    agent === "codex" ? codexCredential : claudeCredential;
  const agentKeys = Effect.fn("HopliteCloud.agentKeys")(function* (agent: CloudSandboxAgent) {
    const credential = yield* credentialFor(agent);
    if (credential === undefined) {
      return yield* new HopliteCloudError({
        code: "not_connected",
        message:
          agent === "codex"
            ? "Add an OpenAI API key under Codex for sandboxes in Settings > Environments, or set CODEX_API_KEY or OPENAI_API_KEY where T3 Code runs."
            : "Add a Claude login in Settings > Environments (an API key, or a token from `claude setup-token` to use a Claude subscription), or set ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN where T3 Code runs: the agent in the sandbox runs Claude Code on it.",
      });
    }
    const githubToken = environment.GH_TOKEN || environment.GITHUB_TOKEN || undefined;
    return {
      agent: { name: agent, variable: credential.variable, value: credential.value },
      githubToken,
    } satisfies AgentKeys;
  });
  // A credential a sandbox may still hold after it was replaced or removed here; read
  // fresh each time so a just-saved login redacts immediately.
  const retiredCredentials = readSecret(RETIRED_CREDENTIALS_SECRET).pipe(
    Effect.map((stored) =>
      Option.getOrElse(Option.flatMap(stored, decodeRetiredCredentials), (): Array<string> => []),
    ),
    Effect.orElseSucceed((): Array<string> => []),
  );
  // Called before a stored key or credential is replaced or removed, so its old value
  // keeps being redacted for as long as a sandbox could still carry it.
  const retire = Effect.fn("HopliteCloud.retire")(function* (secretName: string) {
    const saved = yield* readSecret(secretName);
    if (saved._tag === "None") return;
    const retired = yield* retiredCredentials;
    const encoded = yield* encodeRetiredCredentials(
      [...new Set([saved.value, ...retired])].slice(0, MAX_RETIRED_CREDENTIALS),
    ).pipe(Effect.mapError(() => failure("unavailable")));
    yield* saveSecret(RETIRED_CREDENTIALS_SECRET, encoded);
  });
  // Every key a sandbox can hold, to keep out of anything that comes back from it.
  const sandboxSecrets = (apiKey: string) =>
    Effect.all([claudeCredential, codexCredential, retiredCredentials]).pipe(
      Effect.map(([claude, codex, retired]) => [
        apiKey,
        claude?.value,
        codex?.value,
        environment.GH_TOKEN || environment.GITHUB_TOKEN || undefined,
        ...retired,
      ]),
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
  const sentMessages = new Map<string, { readonly runId: string | null }>();
  const sessionTask = Effect.fn("HopliteCloud.sessionTask")(function* (
    provider: SessionProvider,
    id: string,
    runId?: string,
    title?: string,
  ) {
    // turn-N reads that turn; queued-N reads whichever run the queue item became.
    const named = runId === undefined ? undefined : /^(turn|queued)-([1-9]\d{0,8})$/.exec(runId);
    if (runId !== undefined && named === null) return yield* failure("not_found", provider);
    const apiKey = yield* keyFor(provider);
    const result = yield* sessionOf(provider).exec(
      apiKey,
      id,
      readTurnScript(
        named === undefined || named === null
          ? undefined
          : named[1] === "queued"
            ? { queued: Number(named[2]) }
            : { turn: Number(named[2]) },
      ),
      {},
    );
    // Redacted before parsing, so neither the reply's cut nor its link can split a key.
    const turn = parseTurn(
      {
        ...result,
        output: redact(result.output, yield* sandboxSecrets(apiKey)),
      },
      runId,
    );
    const questionTurn = /^turn=([1-9]\d*)$/m.exec(result.output)?.[1];
    return {
      task: {
        threadId: `${provider}:${id}`,
        projectId: provider,
        title: yield* taskTitle(`${provider}:${id}`, title),
        status: turn.thread,
        latestReply: turn.latestReply,
        pullRequestUrl: turn.pullRequestUrl,
      },
      run: turn.run,
      ...(questionTurn === undefined ? {} : { questionRunId: `turn-${questionTurn}` }),
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

  // One project is enough to prove a Hoplite key works.
  const verifyKey = (provider: CloudSandboxProvider, apiKey: string) =>
    provider === "devin"
      ? devin.verify
      : provider === "hoplite"
        ? Effect.asVoid(
            send(
              apiKey,
              HttpClientRequest.get(`${HOPLITE_API_BASE_URL}/api/projects`).pipe(
                HttpClientRequest.setUrlParams({ pagination: "cursor", limit: "1" }),
              ),
              ProjectsPage,
            ),
          )
        : sessionOf(provider).verify(apiKey);

  // Normalized repo -> project id, so a task skips listing every project. Cleared whenever the
  // key changes, as another key may see other projects.
  const projectIds = new Map<string, string>();

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

  const status = Effect.all([
    Effect.forEach(CLOUD_SANDBOX_PROVIDERS, providerStatus, { concurrency: "unbounded" }),
    // Only where the credential lives and what kind it is ever leave this method.
    Effect.map(claudeCredential, (credential) =>
      credential === undefined
        ? null
        : {
            source: credential.source,
            kind:
              credential.variable === "CLAUDE_CODE_OAUTH_TOKEN"
                ? ("subscription" as const)
                : ("api_key" as const),
          },
    ),
    Effect.map(codexCredential, (credential) =>
      credential === undefined ? null : { source: credential.source, kind: "api_key" as const },
    ),
  ]).pipe(
    Effect.map(([providers, claude, codex]): HopliteCloudStatus => {
      const hoplite = providers.find((entry) => entry.provider === "hoplite")!;
      return { connected: hoplite.connected, problem: hoplite.problem, providers, claude, codex };
    }),
    Effect.withSpan("HopliteCloud.status"),
  );

  const connect = Effect.fn("HopliteCloud.connect")(function* (
    provider: CloudSandboxProvider,
    apiKey?: string,
  ) {
    if (provider === "devin") {
      yield* devin.verify;
      yield* saveSecret(apiKeySecretFor(provider), "cli-login");
      return yield* status;
    }
    if (apiKey === undefined) return yield* failure("invalid_key", provider);
    // Check the key before saving it so a typo never replaces a working one.
    yield* verifyKey(provider, apiKey);
    yield* retire(apiKeySecretFor(provider));
    yield* saveSecret(apiKeySecretFor(provider), apiKey);
    projectIds.clear();
    return yield* status;
  });

  const disconnect = Effect.fn("HopliteCloud.disconnect")(function* (
    provider: CloudSandboxProvider,
  ) {
    if (provider === "devin") {
      yield* devin.disconnect;
      yield* removeSecret(apiKeySecretFor(provider));
      return yield* status;
    }
    yield* retire(apiKeySecretFor(provider));
    yield* removeSecret(apiKeySecretFor(provider));
    projectIds.clear();
    return yield* status;
  });

  const setAgentCredential = Effect.fn("HopliteCloud.setAgentCredential")(function* (
    agent: CloudSandboxAgent,
    credential: string,
  ) {
    yield* retire(credentialSecretFor(agent));
    yield* saveSecret(credentialSecretFor(agent), credential);
    return yield* status;
  });

  const clearAgentCredential = Effect.fn("HopliteCloud.clearAgentCredential")(function* (
    agent: CloudSandboxAgent,
  ) {
    yield* retire(credentialSecretFor(agent));
    yield* removeSecret(credentialSecretFor(agent));
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
  // A failed read fails: falling back to the latest finished run would report the wrong run.
  const readActiveRunId = (apiKey: string, threadId: string) =>
    send(
      apiKey,
      HttpClientRequest.get(`${threadPath(threadId)}/active-run`),
      ActiveRunResponse,
    ).pipe(Effect.map(({ activeRun }) => activeRun?.runId));
  const readRunStateOf = (apiKey: string, threadId: string, activeRunId: string | undefined) =>
    send(
      apiKey,
      HttpClientRequest.get(`${threadPath(threadId)}/run-state`).pipe(
        HttpClientRequest.setUrlParams(activeRunId === undefined ? {} : { runId: activeRunId }),
      ),
      RunStateResponse,
    ).pipe(
      Effect.map(({ run }) => run ?? null),
      // Asked without a run id, a thread with no finished run yet has nothing to report.
      Effect.catchIf(
        (error) => activeRunId === undefined && error.code === "not_found",
        () => Effect.succeed(null),
      ),
    );
  const readRunState = Effect.fn("HopliteCloud.readRunState")(function* (
    apiKey: string,
    threadId: string,
  ) {
    return yield* readRunStateOf(apiKey, threadId, yield* readActiveRunId(apiKey, threadId));
  });
  const readThread = (apiKey: string, threadId: string) =>
    send(apiKey, HttpClientRequest.get(threadPath(threadId)), ThreadResponse).pipe(
      Effect.map(({ thread }) => thread),
    );
  const taskRead = (
    thread: typeof ThreadRecord.Type,
    run: typeof RunStateResponse.Type.run,
  ): HopliteTaskRead => ({
    task: toTask(thread, run?.assistantMessage?.content ?? null),
    run: run == null ? null : { id: run.runId, status: run.status },
  });

  const readTask = Effect.fn("HopliteCloud.readTask")(function* ({
    threadId: taskId,
    runId,
    title,
  }: HopliteCloudGetTaskInput & { readonly runId?: string; readonly title?: string }) {
    const { provider, id: threadId } = yield* taskOf(taskId);
    if (provider === "devin") {
      yield* keyFor(provider);
      return yield* devin.read(threadId, runId);
    }
    if (provider !== "hoplite") return yield* sessionTask(provider, threadId, runId, title);
    const apiKey = yield* requireKey;
    const [thread, activeRunId] = yield* Effect.all(
      [readThread(apiKey, threadId), readActiveRunId(apiKey, threadId)],
      { concurrency: "unbounded" },
    );
    const read = taskRead(thread, yield* readRunStateOf(apiKey, threadId, runId ?? activeRunId));
    return {
      ...read,
      task: { ...read.task, title: yield* taskTitle(taskId, title ?? read.task.title) },
    };
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
    fullName: string,
  ) {
    const projects = yield* listProjects(apiKey);
    const existing = projects.find((project) =>
      project.repos?.some((candidate) => normalizeRepo(candidate.repoFullName) === fullName),
    );
    if (existing !== undefined) {
      projectIds.set(fullName, existing.id);
      return existing.id;
    }
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
    projectIds.set(fullName, project.id);
    return project.id;
  });

  const startSandboxTask = Effect.fn("HopliteCloud.startSandboxTask")(function* (
    provider: SessionProvider,
    input: HopliteCloudStartTaskInput,
  ) {
    const agent = input.agent ?? "claude";
    const keys = yield* agentKeys(agent);
    const apiKey = yield* keyFor(provider);
    const adapter = sessionOf(provider);
    const id = yield* adapter.create(apiKey, input.template);
    // A task that never started is never reported, so its sandbox goes too.
    const removeSandbox = adapter.remove(apiKey, id).pipe(Effect.ignore);
    const started = yield* adapter
      .exec(
        apiKey,
        id,
        agentTurnScript({ first: true }),
        agentTurnEnv(keys, input.prompt, input.repo, input.model),
      )
      .pipe(Effect.tapError(() => removeSandbox));
    if (started.exitCode !== 0) {
      yield* removeSandbox;
      return yield* turnFailed(provider, started, yield* sandboxSecrets(apiKey));
    }
    return {
      task: {
        threadId: `${provider}:${id}`,
        projectId: input.repo ?? provider,
        title: yield* taskTitle(`${provider}:${id}`, input.title ?? input.prompt.slice(0, 80)),
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
    if (provider === "devin") {
      yield* keyFor(provider);
      return yield* devinWrites.withPermit(
        remembered(
          startedTasks,
          input.clientRequestId === undefined
            ? undefined
            : [
                "devin",
                input.clientRequestId,
                input.prompt,
                input.repo,
                input.title,
                input.model,
                input.agent,
                input.template,
              ].join("\u0000"),
          devin.start(input),
        ),
      );
    }
    if (provider !== "hoplite") {
      return yield* remembered(
        startedTasks,
        // Keyed by what the task asks too, so another caller reusing an id starts its own.
        input.clientRequestId === undefined
          ? undefined
          : [
              provider,
              input.clientRequestId,
              input.prompt,
              input.repo ?? "",
              input.title ?? "",
              input.model ?? "",
              input.template ?? "",
              input.agent ?? "",
            ].join("\u0000"),
        startSandboxTask(provider, input),
      );
    }
    if (input.template !== undefined) {
      return yield* new HopliteCloudError({
        code: "unsupported",
        message: "Hoplite tasks run on Hoplite's own machines; leave `template` out.",
      });
    }
    if (input.agent !== undefined) {
      return yield* new HopliteCloudError({
        code: "unsupported",
        message: "Hoplite runs its own agent; leave `agent` out.",
      });
    }
    const apiKey = yield* requireKey;
    if (input.repo === undefined) return yield* failure("project_required");
    const model = input.model === undefined ? undefined : yield* resolveModel(apiKey, input.model);
    const fullName = normalizeRepo(input.repo);
    const key = `t3code:${input.clientRequestId ?? (yield* random.uuidV4())}`;
    const createThread = (projectId: string, retry: boolean) =>
      send(
        apiKey,
        HttpClientRequest.post(`${HOPLITE_API_BASE_URL}/api/threads`).pipe(
          // Hoplite may have kept the refused attempt under the first key.
          HttpClientRequest.setHeader("Idempotency-Key", retry ? `${key}:${projectId}` : key),
          HttpClientRequest.bodyJsonUnsafe({
            projectId,
            prompt: input.prompt,
            ...(input.title === undefined ? {} : { title: input.title }),
            ...(model === undefined ? {} : { model }),
          }),
        ),
        CreateThreadResponse,
      );
    const cached = projectIds.get(fullName);
    const { thread, run } =
      cached === undefined
        ? yield* createThread(yield* projectForRepo(apiKey, fullName), false)
        : yield* createThread(cached, false).pipe(
            // The remembered project may be gone; look it up once more.
            Effect.catchIf(
              (error) => error.code === "not_found",
              () => {
                projectIds.delete(fullName);
                return projectForRepo(apiKey, fullName).pipe(
                  Effect.flatMap((projectId) => createThread(projectId, true)),
                );
              },
            ),
          );
    const task = toTask(thread, null);
    return {
      task: {
        ...task,
        title: yield* taskTitle(thread.id, input.title ?? task.title ?? input.prompt.slice(0, 80)),
      },
      runId: run?.id ?? null,
    } satisfies HopliteStartedTask;
  });

  // While a turn still runs the message waits in the sandbox's queue and runId names
  // its item (queued-N); a fresh run gets turn-N. A runner on a different login refuses.
  const sendSandboxMessage = Effect.fn("HopliteCloud.sendSandboxMessage")(function* (
    provider: SessionProvider,
    id: string,
    message: string,
    model: string | undefined,
  ) {
    const apiKey = yield* keyFor(provider);
    const adapter = sessionOf(provider);
    // The task's own file names its agent: sandboxes from before agents existed read as claude.
    const named = yield* adapter.exec(
      apiKey,
      id,
      'cat "$HOME/.t3-task/agent" 2>/dev/null || echo claude',
      {},
    );
    const agent: CloudSandboxAgent = named.output.trim() === "codex" ? "codex" : "claude";
    const keys = yield* agentKeys(agent);
    const ran = yield* adapter.exec(
      apiKey,
      id,
      agentTurnScript({ first: false }),
      agentTurnEnv(keys, message, undefined, model),
    );
    if (ran.exitCode !== 0) {
      if (ran.output.includes("---t3-task-login-changed---")) {
        return yield* new HopliteCloudError({
          code: "unavailable",
          message:
            "This task is still running on the login it started with. Stop it, then send your message again to use the new login.",
        });
      }
      return yield* turnFailed(provider, ran, yield* sandboxSecrets(apiKey));
    }
    return { runId: startedRunId(ran) };
  });

  const sendMessage = Effect.fn("HopliteCloud.sendMessage")(function* (
    input: HopliteCloudSendMessageInput,
  ) {
    const { provider, id } = yield* taskOf(input.threadId);
    if (provider === "devin") {
      yield* keyFor(provider);
      if (input.model !== undefined) return yield* failure("unsupported", provider);
      return yield* devinWrites.withPermit(
        remembered(
          sentMessages,
          input.clientRequestId === undefined
            ? undefined
            : [input.threadId, input.clientRequestId, input.message].join("\u0000"),
          devin.send(id, input.message),
        ),
      );
    }
    if (provider !== "hoplite") {
      return yield* remembered(
        sentMessages,
        input.clientRequestId === undefined
          ? undefined
          : [input.threadId, input.clientRequestId, input.message, input.model ?? ""].join(
              "\u0000",
            ),
        sendSandboxMessage(provider, id, input.message, input.model),
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
    if (session.provider === "devin") {
      yield* keyFor("devin");
      return (yield* devin.stop(session.id)).task;
    }
    if (session.provider !== "hoplite") {
      const apiKey = yield* keyFor(session.provider);
      yield* sessionOf(session.provider).exec(apiKey, session.id, STOP_SCRIPT, {});
      return yield* getTask({ threadId });
    }
    const apiKey = yield* requireKey;
    // Hoplite stops only the run it is told to, so a run that finished meanwhile is never touched.
    const run = yield* readRunState(apiKey, threadId);
    // With nothing to stop, the run just read is current; only the thread is still needed.
    if (run === null || !["queued", "running", "waiting"].includes(run.status)) {
      return taskRead(yield* readThread(apiKey, threadId), run).task;
    }
    const request = HttpClientRequest.post(`${threadPath(threadId)}/stop`).pipe(
      HttpClientRequest.bodyJsonUnsafe({ runId: run.runId }),
    );
    yield* send(apiKey, request, StopResponse);
    return yield* getTask({ threadId });
  });

  const preview = Effect.fn("HopliteCloud.preview")(function* ({
    threadId,
    start,
    port,
  }: HopliteCloudPreviewInput) {
    const { provider, id } = yield* taskOf(threadId);
    if (provider === "devin")
      return {
        status: "unsupported",
        url: null,
        reason: "Devin Cloud previews are available in the Devin session.",
      } satisfies HopliteCloudPreview;
    if (provider !== "hoplite") {
      const apiKey = yield* keyFor(provider);
      return yield* sessionOf(provider)
        .preview(apiKey, id, port ?? 3000)
        .pipe(Effect.map((result) => result satisfies HopliteCloudPreview));
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
          ...(pending.runId === undefined ? {} : { runId: pending.runId }),
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
    const { provider, id } = yield* taskOf(threadId);
    if (provider === "devin") {
      yield* keyFor(provider);
      return yield* devin.questions(id);
    }
    if (provider !== "hoplite") {
      const result = yield* sessionOf(provider).exec(
        yield* keyFor(provider),
        id,
        readQuestionsScript(),
        {},
      );
      if (result.exitCode !== 0) return yield* failure("unavailable", provider);
      return yield* decodeSandboxQuestions(result.output.trim()).pipe(
        Effect.mapError(() => failure("unavailable", provider)),
      );
    }
    return yield* fetchQuestions(yield* requireKey, threadId);
  });

  const answerQuestion = Effect.fn("HopliteCloud.answerQuestion")(function* (
    input: HopliteCloudAnswerInput,
  ) {
    const { provider, id } = yield* taskOf(input.threadId);
    if (provider === "devin") {
      yield* keyFor(provider);
      return yield* devin.answer(
        id,
        input.questionId,
        input.dismiss === true ? null : input.answer,
      );
    }
    if (provider !== "hoplite") {
      if (!/^q_[a-f0-9]{32}$/.test(input.questionId)) return yield* invalidId(provider, "question");
      const result = yield* sessionOf(provider).exec(
        yield* keyFor(provider),
        id,
        answerQuestionScript(),
        {
          T3_QUESTION_ID: input.questionId,
          T3_QUESTION_ANSWER: input.answer,
          T3_QUESTION_DISMISS: String(input.dismiss === true),
        },
      );
      if (result.exitCode !== 0)
        return yield* failure(result.exitCode === 2 ? "not_found" : "unavailable", provider);
      return { runId: (yield* sessionTask(provider, id)).run?.id ?? null };
    }
    if (!HOPLITE_QUESTION_ID_FORMAT.test(input.questionId))
      return yield* invalidId("hoplite", "question");
    const apiKey = yield* requireKey;
    const request = HttpClientRequest.post(
      `${threadPath(input.threadId)}/questions/${encodeURIComponent(input.questionId)}`,
    ).pipe(
      yield* idempotent(input.clientRequestId ?? `answer:${input.questionId}`),
      HttpClientRequest.bodyJsonUnsafe(
        input.dismiss === true ? { answers: null } : { answer: input.answer },
      ),
    );
    const { result } = yield* send(apiKey, request, AnswerResponse);
    return { runId: result.runId ?? null };
  });

  const connected = Effect.map(storedProviders, (stored) => stored.length > 0);

  // A sandbox has no live socket: each read returns its recent chat, and a fresh read
  // follows each activity event and every three seconds while a turn still runs.
  const sandboxThreadChat = (
    provider: SessionProvider,
    id: string,
    activity: Stream.Stream<void>,
  ): Stream.Stream<CloudTaskChatEvent, HopliteCloudError> =>
    Stream.callback((queue) =>
      Effect.gen(function* () {
        const apiKey = yield* keyFor(provider);
        // Secrets are redacted per read, so a credential saved mid-watch redacts too.
        const read = Effect.flatMap(sandboxSecrets(apiKey), (secrets) =>
          sessionOf(provider)
            .exec(apiKey, id, readChatScript(), {})
            .pipe(
              Effect.map((result) => redact(result.output, secrets)),
              Effect.map((output) => ({
                entries: parseChat(output),
                running: chatIsRunning(output),
              })),
            ),
        );
        // Bursts of activity collapse into at most one pending refresh.
        const trigger = yield* Queue.dropping<void>(1);
        const running = yield* Ref.make(true);
        yield* Effect.forkChild(Stream.runForEach(activity, () => Queue.offer(trigger, undefined)));
        // While the task's runner is alive, a tick asks for the same read activity does.
        yield* Effect.forkChild(
          Effect.forever(
            Effect.sleep("3 seconds").pipe(
              Effect.andThen(
                Ref.get(running).pipe(
                  Effect.flatMap((still) =>
                    still ? Queue.offer(trigger, undefined) : Effect.void,
                  ),
                ),
              ),
            ),
          ),
        );
        let lastEntries: Array<CloudTaskChatEntry> | undefined;
        let lastRunning: boolean | undefined;
        const publish = Effect.gen(function* () {
          const { entries, running: isRunning } = yield* read;
          const changed = lastEntries === undefined || !Equal.equals(lastEntries, entries);
          if (changed) {
            lastEntries = entries;
            yield* Queue.offerAll(queue, [
              { _tag: "replace", entries },
              { _tag: "live", running: isRunning },
            ] satisfies ReadonlyArray<CloudTaskChatEvent>);
          } else if (isRunning !== lastRunning) {
            yield* Queue.offer(queue, {
              _tag: "live",
              running: isRunning,
            } satisfies CloudTaskChatEvent);
          }
          lastRunning = isRunning;
          yield* Ref.set(running, isRunning);
        });
        yield* publish;
        return yield* Effect.forever(Effect.andThen(Queue.take(trigger), publish));
      }).pipe(
        Effect.catch((error) => Queue.fail(queue, error)),
        Effect.andThen(Effect.never),
      ),
    );

  const watchThreadChat = (taskId: string, activity: Stream.Stream<void>) => {
    const parsed = providerOfTask(taskId);
    if (parsed.provider === "devin")
      return Stream.unwrap(
        Effect.gen(function* () {
          yield* taskOf(taskId);
          yield* keyFor("devin");
          return devin.watch(parsed.id);
        }),
      );
    if (parsed.provider !== "hoplite") {
      const provider = parsed.provider;
      return Stream.unwrap(
        Effect.map(
          TASK_ID_FORMATS[provider].test(parsed.id)
            ? Effect.succeed(parsed.id)
            : invalidId(provider, "task"),
          (id) => sandboxThreadChat(provider, id, activity),
        ),
      );
    }
    const hopliteThreadId = taskId;
    return Stream.unwrap(
      Effect.map(requireKey, (apiKey) =>
        Stream.unwrap(
          Socket.makeWebSocket(HOPLITE_ACP_URL, {
            openTimeout: "10 seconds",
            headers: { "X-Api-Key": apiKey },
          }).pipe(
            Effect.map((socket) => watchHopliteThreadChat({ socket, hopliteThreadId, activity })),
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
  };

  const sandboxOf = Effect.fn("HopliteCloud.sandboxOf")(function* (sandboxId: string) {
    const { provider, id } = yield* taskOf(sandboxId);
    if (provider === "hoplite" || provider === "devin")
      return yield* invalidId(provider, "sandbox");
    return { provider, id, apiKey: yield* keyFor(provider) };
  });

  const createSandbox = Effect.fn("HopliteCloud.createSandbox")(function* ({
    provider,
    template,
  }: CloudSandboxCreateInput) {
    const id = yield* sessionOf(provider).create(yield* keyFor(provider), template);
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
    setAgentCredential,
    clearAgentCredential,
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
