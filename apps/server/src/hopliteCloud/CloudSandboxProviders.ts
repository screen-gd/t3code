import type {
  CloudSandboxProvider,
  HopliteCloudError,
  HopliteCloudErrorCode,
  HopliteCloudStartTaskInput,
  HopliteCloudTask,
  HopliteCloudThreadStatus,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as HttpClientRequest from "effect/http/HttpClientRequest";

import type { HopliteRunStatus, HopliteTaskRead } from "./HopliteCloudService.ts";

/**
 * Providers other than Hoplite run a whole task as one session. Their tasks have ids
 * `<provider>:<session id>` so every task call finds its provider again; Hoplite's keep
 * their bare thread ids.
 */
export type SessionProvider = Exclude<CloudSandboxProvider, "hoplite">;

export const PROVIDER_NAMES: Record<CloudSandboxProvider, string> = {
  hoplite: "Hoplite",
  devin: "Devin",
  jules: "Jules",
};

export const DEVIN_API_BASE_URL = "https://api.devin.ai/v1";
export const JULES_API_BASE_URL = "https://jules.googleapis.com/v1alpha";

const MAX_REPLY_LENGTH = 4_000;

const taskIdFor = (provider: SessionProvider, sessionId: string) => `${provider}:${sessionId}`;

export const providerOfTask = (
  taskId: string,
): { readonly provider: CloudSandboxProvider; readonly id: string } => {
  for (const provider of ["devin", "jules"] as const) {
    if (taskId.startsWith(`${provider}:`)) {
      return { provider, id: taskId.slice(provider.length + 1) };
    }
  }
  return { provider: "hoplite", id: taskId };
};

/** Sends with the provider's auth and maps failures; `null` ignores the body. */
export type ProviderSend = <A, I>(
  provider: SessionProvider,
  apiKey: string,
  request: HttpClientRequest.HttpClientRequest,
  schema: Schema.Codec<A, I> | null,
) => Effect.Effect<A | undefined, HopliteCloudError>;

export type ProviderFailure = (
  provider: CloudSandboxProvider,
  code: HopliteCloudErrorCode,
) => Effect.Effect<never, HopliteCloudError>;

export interface SessionAdapter {
  /** Fails when the key does not work. */
  readonly verify: (apiKey: string) => Effect.Effect<void, HopliteCloudError>;
  readonly start: (
    apiKey: string,
    input: HopliteCloudStartTaskInput,
  ) => Effect.Effect<HopliteCloudTask, HopliteCloudError>;
  readonly read: (apiKey: string, id: string) => Effect.Effect<HopliteTaskRead, HopliteCloudError>;
  readonly sendMessage: (
    apiKey: string,
    id: string,
    message: string,
  ) => Effect.Effect<void, HopliteCloudError>;
  /** Fails with `unsupported` when the provider has no way to stop a session. */
  readonly stop: (apiKey: string, id: string) => Effect.Effect<void, HopliteCloudError>;
}

interface SessionState {
  readonly thread: HopliteCloudThreadStatus;
  readonly run: HopliteRunStatus;
}

const QUEUED: SessionState = { thread: "queued", run: "queued" };
const RUNNING: SessionState = { thread: "running", run: "running" };
// The session waits for the next message, so the turn the caller follows is over.
const AWAITING: SessionState = { thread: "waiting", run: "completed" };

/**
 * A turn is a user message: right after a follow-up the session can still report the
 * turn before it, and the watch only settles once the count moves past that one.
 */
const turnId = (userMessages: number) => `turn-${userMessages}`;

const cut = (reply: string | undefined) =>
  reply === undefined ? null : reply.slice(0, MAX_REPLY_LENGTH);

const withRepo = (input: HopliteCloudStartTaskInput) =>
  input.repo === undefined
    ? input.prompt
    : `${input.prompt}\n\nWork in the GitHub repository ${input.repo}.`;

const DevinSession = Schema.Struct({
  session_id: Schema.String,
  title: Schema.optional(Schema.NullOr(Schema.String)),
  status_enum: Schema.optional(Schema.NullOr(Schema.String)),
  pull_request: Schema.optional(Schema.NullOr(Schema.Struct({ url: Schema.String }))),
  messages: Schema.optional(
    Schema.Array(Schema.Struct({ type: Schema.String, message: Schema.String })),
  ),
});
const DevinCreated = Schema.Struct({ session_id: Schema.String });
const DevinSessions = Schema.Struct({});

const devinState = (status: string | null | undefined): SessionState => {
  switch (status) {
    case "working":
    case "resumed":
    case "resume_requested":
    case "resume_requested_frontend":
      return RUNNING;
    case "blocked":
      return AWAITING;
    case "finished":
      return { thread: "ready", run: "completed" };
    case "expired":
      return { thread: "failed", run: "failed" };
    case "suspend_requested":
    case "suspend_requested_frontend":
      return { thread: "blocked", run: "completed" };
    default:
      return QUEUED;
  }
};

const isUserMessage = (type: string) => type.includes("user");

const makeDevin = (send: ProviderSend): SessionAdapter => {
  const sessionUrl = (id: string) => `${DEVIN_API_BASE_URL}/sessions/${encodeURIComponent(id)}`;
  const readSession = (apiKey: string, id: string) =>
    send("devin", apiKey, HttpClientRequest.get(sessionUrl(id)), DevinSession).pipe(
      Effect.map((session) => session!),
    );
  return {
    verify: (apiKey) =>
      Effect.asVoid(
        send(
          "devin",
          apiKey,
          HttpClientRequest.get(`${DEVIN_API_BASE_URL}/sessions`).pipe(
            HttpClientRequest.setUrlParams({ limit: "1" }),
          ),
          DevinSessions,
        ),
      ),
    start: Effect.fn("CloudSandbox.devin.start")(function* (apiKey, input) {
      const created = yield* send(
        "devin",
        apiKey,
        HttpClientRequest.post(`${DEVIN_API_BASE_URL}/sessions`).pipe(
          HttpClientRequest.bodyJsonUnsafe({
            prompt: withRepo(input),
            ...(input.title === undefined ? {} : { title: input.title }),
          }),
        ),
        DevinCreated,
      );
      return {
        threadId: taskIdFor("devin", created!.session_id),
        projectId: input.repo ?? "devin",
        title: input.title ?? null,
        status: "queued",
        latestReply: null,
        pullRequestUrl: null,
      } satisfies HopliteCloudTask;
    }),
    read: Effect.fn("CloudSandbox.devin.read")(function* (apiKey, id) {
      const session = yield* readSession(apiKey, id);
      const state = devinState(session.status_enum);
      const messages = session.messages ?? [];
      return {
        task: {
          threadId: taskIdFor("devin", session.session_id),
          projectId: "devin",
          title: session.title ?? null,
          status: state.thread,
          latestReply: cut(messages.findLast((message) => !isUserMessage(message.type))?.message),
          pullRequestUrl: session.pull_request?.url ?? null,
        },
        run: {
          id: turnId(messages.filter((message) => isUserMessage(message.type)).length),
          status: state.run,
        },
      } satisfies HopliteTaskRead;
    }),
    sendMessage: (apiKey, id, message) =>
      Effect.asVoid(
        send(
          "devin",
          apiKey,
          HttpClientRequest.post(`${sessionUrl(id)}/message`).pipe(
            HttpClientRequest.bodyJsonUnsafe({ message }),
          ),
          null,
        ),
      ),
    stop: (apiKey, id) =>
      Effect.asVoid(send("devin", apiKey, HttpClientRequest.delete(sessionUrl(id)), null)),
  };
};

const JulesSource = Schema.Struct({
  name: Schema.String,
  githubRepo: Schema.optional(
    Schema.Struct({
      defaultBranch: Schema.optional(Schema.Struct({ displayName: Schema.String })),
    }),
  ),
});
const JulesSources = Schema.Struct({});
const JulesSession = Schema.Struct({
  id: Schema.String,
  title: Schema.optional(Schema.String),
  state: Schema.optional(Schema.String),
  outputs: Schema.optional(
    Schema.Array(
      Schema.Struct({ pullRequest: Schema.optional(Schema.Struct({ url: Schema.String })) }),
    ),
  ),
});
const JulesActivities = Schema.Struct({
  activities: Schema.optional(
    Schema.Array(
      Schema.Struct({
        agentMessaged: Schema.optional(
          Schema.Struct({ agentMessage: Schema.optional(Schema.String) }),
        ),
        userMessaged: Schema.optional(
          Schema.Struct({ userMessage: Schema.optional(Schema.String) }),
        ),
      }),
    ),
  ),
});

const julesState = (state: string | undefined): SessionState => {
  switch (state) {
    case "PLANNING":
    case "IN_PROGRESS":
      return RUNNING;
    case "AWAITING_PLAN_APPROVAL":
    case "AWAITING_USER_FEEDBACK":
      return AWAITING;
    case "PAUSED":
      return { thread: "blocked", run: "completed" };
    case "COMPLETED":
      return { thread: "ready", run: "completed" };
    case "FAILED":
      return { thread: "failed", run: "failed" };
    default:
      return QUEUED;
  }
};

const GITHUB_OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const GITHUB_REPO = /^(?!\.\.?$)[A-Za-z0-9._-]{1,100}$/;

const makeJules = (send: ProviderSend, failure: ProviderFailure): SessionAdapter => {
  const sessionUrl = (id: string) => `${JULES_API_BASE_URL}/sessions/${encodeURIComponent(id)}`;
  return {
    verify: (apiKey) =>
      Effect.asVoid(
        send(
          "jules",
          apiKey,
          HttpClientRequest.get(`${JULES_API_BASE_URL}/sources`).pipe(
            HttpClientRequest.setUrlParams({ pageSize: "1" }),
          ),
          JulesSources,
        ),
      ),
    start: Effect.fn("CloudSandbox.jules.start")(function* (apiKey, input) {
      if (input.repo === undefined) return yield* failure("jules", "project_required");
      const [owner, name] = input.repo
        .trim()
        .replace(/^https:\/\/github\.com\//i, "")
        .replace(/\.git$/i, "")
        .split("/");
      if (owner === undefined || name === undefined)
        return yield* failure("jules", "project_required");
      // Both go into the request path, so only GitHub's own name formats pass.
      if (!GITHUB_OWNER.test(owner) || !GITHUB_REPO.test(name))
        return yield* failure("jules", "repo_unavailable");
      // Jules names a repository its GitHub app can see `sources/github/<owner>/<repo>`.
      const source = yield* send(
        "jules",
        apiKey,
        HttpClientRequest.get(
          `${JULES_API_BASE_URL}/sources/github/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`,
        ),
        JulesSource,
      ).pipe(
        Effect.catchIf(
          (error) => error.code === "not_found",
          () => failure("jules", "repo_unavailable"),
        ),
      );
      const session = yield* send(
        "jules",
        apiKey,
        HttpClientRequest.post(`${JULES_API_BASE_URL}/sessions`).pipe(
          HttpClientRequest.bodyJsonUnsafe({
            prompt: input.prompt,
            ...(input.title === undefined ? {} : { title: input.title }),
            sourceContext: {
              source: source!.name,
              githubRepoContext: {
                startingBranch: source!.githubRepo?.defaultBranch?.displayName ?? "main",
              },
            },
            automationMode: "AUTO_CREATE_PR",
          }),
        ),
        JulesSession,
      );
      return {
        threadId: taskIdFor("jules", session!.id),
        projectId: source!.name,
        title: session!.title ?? input.title ?? null,
        status: "queued",
        latestReply: null,
        pullRequestUrl: null,
      } satisfies HopliteCloudTask;
    }),
    read: Effect.fn("CloudSandbox.jules.read")(function* (apiKey, id) {
      const session = (yield* send(
        "jules",
        apiKey,
        HttpClientRequest.get(sessionUrl(id)),
        JulesSession,
      ))!;
      const { activities = [] } = (yield* send(
        "jules",
        apiKey,
        HttpClientRequest.get(`${sessionUrl(id)}/activities`).pipe(
          HttpClientRequest.setUrlParams({ pageSize: "100" }),
        ),
        JulesActivities,
      ))!;
      const state = julesState(session.state);
      return {
        task: {
          threadId: taskIdFor("jules", session.id),
          projectId: "jules",
          title: session.title ?? null,
          status: state.thread,
          latestReply: cut(
            activities.findLast((activity) => activity.agentMessaged?.agentMessage !== undefined)
              ?.agentMessaged?.agentMessage,
          ),
          pullRequestUrl:
            session.outputs?.findLast((output) => output.pullRequest !== undefined)?.pullRequest
              ?.url ?? null,
        },
        // The prompt that started the session is its first turn.
        run: {
          id: turnId(
            1 + activities.filter((activity) => activity.userMessaged !== undefined).length,
          ),
          status: state.run,
        },
      } satisfies HopliteTaskRead;
    }),
    sendMessage: (apiKey, id, message) =>
      Effect.asVoid(
        send(
          "jules",
          apiKey,
          HttpClientRequest.post(`${sessionUrl(id)}:sendMessage`).pipe(
            HttpClientRequest.bodyJsonUnsafe({ prompt: message }),
          ),
          null,
        ),
      ),
    stop: () => failure("jules", "unsupported"),
  };
};

export const makeSessionAdapters = (
  send: ProviderSend,
  failure: ProviderFailure,
): Record<SessionProvider, SessionAdapter> => ({
  devin: makeDevin(send),
  jules: makeJules(send, failure),
});
