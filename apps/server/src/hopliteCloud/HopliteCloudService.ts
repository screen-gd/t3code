import {
  HopliteCloudError,
  type HopliteCloudErrorCode,
  type HopliteCloudGetTaskInput,
  HopliteCloudPreview,
  type HopliteCloudPreviewInput,
  type HopliteCloudProject,
  type HopliteCloudSendMessageInput,
  type HopliteCloudSetDefaultProjectInput,
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
// Not secret, but it belongs to the key: disconnecting forgets both.
const HOPLITE_DEFAULT_PROJECT_SECRET = "hoplite-cloud-default-project";

const REQUEST_TIMEOUT = "20 seconds";
const MAX_PROJECT_PAGES = 10;
const MAX_REPLY_LENGTH = 4_000;

const ProjectsPage = Schema.Struct({
  projects: Schema.Array(Schema.Struct({ id: Schema.String, name: Schema.String })),
  nextCursor: Schema.optional(Schema.NullOr(Schema.String)),
});

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
    readonly connect: (apiKey: string) => Effect.Effect<HopliteCloudStatus, HopliteCloudError>;
    readonly disconnect: Effect.Effect<HopliteCloudStatus, HopliteCloudError>;
    readonly setDefaultProject: (
      input: HopliteCloudSetDefaultProjectInput,
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
  }
>()("t3/hopliteCloud/HopliteCloudService/HopliteCloud") {}

const MESSAGES: Record<HopliteCloudErrorCode, string> = {
  not_connected: "Hoplite is not connected. Add a Hoplite API key in Settings > Environments.",
  invalid_key: "Hoplite rejected the API key. Create a new key and connect again.",
  forbidden: "The Hoplite API key lacks the permission for this action.",
  not_found: "Hoplite has no such project or thread for this key.",
  project_required: "Choose a Hoplite project, or set a default one in Settings > Environments.",
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
    const projects: Array<HopliteCloudProject> = [];
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
      projects.push(...result.projects.map(({ id, name }) => ({ id, name })));
      cursor = result.nextCursor ?? null;
      if (cursor === null) break;
    }
    return projects;
  });

  const statusFor = Effect.fn("HopliteCloud.statusFor")(function* (apiKey: string) {
    const defaultProjectId = Option.getOrNull(yield* readSecret(HOPLITE_DEFAULT_PROJECT_SECRET));
    return yield* listProjects(apiKey).pipe(
      Effect.map((projects): HopliteCloudStatus => ({
        connected: true,
        projects,
        defaultProjectId: projects.some((project) => project.id === defaultProjectId)
          ? defaultProjectId
          : null,
        problem: null,
      })),
      // A saved key that stops working stays connected so the user can see why and replace it.
      Effect.catch((error) =>
        Effect.succeed<HopliteCloudStatus>({
          connected: true,
          projects: [],
          defaultProjectId,
          problem: error.message,
        }),
      ),
    );
  });

  const disconnectedStatus: HopliteCloudStatus = {
    connected: false,
    projects: [],
    defaultProjectId: null,
    problem: null,
  };

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
    yield* removeSecret(HOPLITE_DEFAULT_PROJECT_SECRET);
    return yield* statusFor(apiKey);
  });

  const disconnect = Effect.gen(function* () {
    yield* removeSecret(HOPLITE_API_KEY_SECRET);
    yield* removeSecret(HOPLITE_DEFAULT_PROJECT_SECRET);
    return disconnectedStatus;
  }).pipe(Effect.withSpan("HopliteCloud.disconnect"));

  const setDefaultProject = Effect.fn("HopliteCloud.setDefaultProject")(function* (
    input: HopliteCloudSetDefaultProjectInput,
  ) {
    const apiKey = yield* requireKey;
    if (input.projectId === null) {
      yield* removeSecret(HOPLITE_DEFAULT_PROJECT_SECRET);
      return yield* statusFor(apiKey);
    }
    const projects = yield* listProjects(apiKey);
    if (!projects.some((project) => project.id === input.projectId)) {
      return yield* failure("not_found");
    }
    yield* saveSecret(HOPLITE_DEFAULT_PROJECT_SECRET, input.projectId);
    return yield* statusFor(apiKey);
  });

  const threadPath = (threadId: string) =>
    `${HOPLITE_API_BASE_URL}/api/threads/${encodeURIComponent(threadId)}`;
  const idempotent = (clientRequestId: string | undefined) =>
    Effect.map(
      clientRequestId === undefined ? random.uuidV4() : Effect.succeed(clientRequestId),
      (key) => HttpClientRequest.setHeader("Idempotency-Key", `t3code:${key}`),
    );
  // A thread still preparing its sandbox has no run yet, so its run is simply absent.
  const readRunState = (apiKey: string, threadId: string) =>
    send(apiKey, HttpClientRequest.get(`${threadPath(threadId)}/run-state`), RunStateResponse).pipe(
      Effect.option,
      Effect.map((state) => Option.getOrUndefined(state)?.run ?? null),
    );

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

  const startTask = Effect.fn("HopliteCloud.startTask")(function* (
    input: HopliteCloudStartTaskInput,
  ) {
    const apiKey = yield* requireKey;
    const projectId =
      input.projectId ?? Option.getOrUndefined(yield* readSecret(HOPLITE_DEFAULT_PROJECT_SECRET));
    if (projectId === undefined) return yield* failure("project_required");
    const request = HttpClientRequest.post(`${HOPLITE_API_BASE_URL}/api/threads`).pipe(
      yield* idempotent(input.clientRequestId),
      HttpClientRequest.bodyJsonUnsafe({
        projectId,
        prompt: input.prompt,
        ...(input.title === undefined ? {} : { title: input.title }),
      }),
    );
    const { thread, run } = yield* send(apiKey, request, CreateThreadResponse);
    return { task: toTask(thread, null), runId: run?.id ?? null } satisfies HopliteStartedTask;
  });

  const sendMessage = Effect.fn("HopliteCloud.sendMessage")(function* (
    input: HopliteCloudSendMessageInput,
  ) {
    const apiKey = yield* requireKey;
    const request = HttpClientRequest.post(`${threadPath(input.threadId)}/messages`).pipe(
      yield* idempotent(input.clientRequestId),
      HttpClientRequest.bodyJsonUnsafe({ content: input.message }),
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

  return HopliteCloud.of({
    status,
    connect,
    disconnect,
    setDefaultProject,
    startTask,
    getTask,
    readTask,
    sendMessage,
    stopTask,
    preview,
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
