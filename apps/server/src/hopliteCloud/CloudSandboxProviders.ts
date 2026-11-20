import type {
  CloudSandboxProvider,
  HopliteCloudError,
  HopliteCloudErrorCode,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as HttpClientRequest from "effect/http/HttpClientRequest";

/**
 * Sandbox providers give a bare machine, so a task there runs Claude Code inside it.
 * Their tasks have ids `<provider>:<sandbox id>` so every call finds its provider again;
 * Hoplite's keep their bare thread ids.
 */
export type SessionProvider = Exclude<CloudSandboxProvider, "hoplite">;
const SESSION_PROVIDERS: ReadonlyArray<SessionProvider> = ["e2b", "daytona", "agent37"];

export const PROVIDER_NAMES: Record<CloudSandboxProvider, string> = {
  hoplite: "Hoplite",
  e2b: "E2B",
  daytona: "Daytona",
  agent37: "Agent37",
};

const E2B_API_BASE_URL = "https://api.e2b.app";
const DAYTONA_API_BASE_URL = "https://app.daytona.io/api";
const DAYTONA_TOOLBOX_BASE_URL = "https://proxy.app.daytona.io/toolbox";
const AGENT37_API_BASE_URL = "https://api.agent37.com/v1";
const AGENT37_SANDBOX_BASE_URL = "https://sandbox.agent37.app/v1";

export const providerOfTask = (
  taskId: string,
): { readonly provider: CloudSandboxProvider; readonly id: string } => {
  for (const provider of SESSION_PROVIDERS) {
    if (taskId.startsWith(`${provider}:`)) {
      return { provider, id: taskId.slice(provider.length + 1) };
    }
  }
  return { provider: "hoplite", id: taskId };
};

/** What goes into a sandbox so the agent there can work: never logged or returned. */
export interface AgentKeys {
  readonly anthropicApiKey: string;
  readonly githubToken: string | undefined;
}

/** Sends with the provider's auth and maps failures; `null` ignores the body. */
export type ProviderSend = <A, I>(
  provider: SessionProvider,
  apiKey: string,
  request: HttpClientRequest.HttpClientRequest,
  schema: Schema.Codec<A, I> | null,
) => Effect.Effect<A | undefined, HopliteCloudError>;

/** Like ProviderSend, for a response that is not JSON. */
export type ProviderSendBytes = (
  provider: SessionProvider,
  apiKey: string,
  request: HttpClientRequest.HttpClientRequest,
) => Effect.Effect<Uint8Array, HopliteCloudError>;

export type ProviderFailure = (
  provider: CloudSandboxProvider,
  code: HopliteCloudErrorCode,
) => Effect.Effect<never, HopliteCloudError>;

export interface CommandResult {
  readonly exitCode: number;
  readonly output: string;
}

export interface SessionAdapter {
  /** Fails when the key does not work. */
  readonly verify: (apiKey: string) => Effect.Effect<void, HopliteCloudError>;
  readonly create: (apiKey: string) => Effect.Effect<string, HopliteCloudError>;
  readonly exec: (
    apiKey: string,
    id: string,
    command: string,
    envs: Readonly<Record<string, string>>,
  ) => Effect.Effect<CommandResult, HopliteCloudError>;
  readonly remove: (apiKey: string, id: string) => Effect.Effect<void, HopliteCloudError>;
}

interface Deps {
  readonly send: ProviderSend;
  readonly sendBytes: ProviderSendBytes;
  readonly failure: ProviderFailure;
}

const E2bCreated = Schema.Struct({ sandboxID: Schema.String });
const E2bConnected = Schema.Struct({
  sandboxID: Schema.String,
  envdAccessToken: Schema.optional(Schema.NullOr(Schema.String)),
  domain: Schema.optional(Schema.NullOr(Schema.String)),
});
const E2bEvent = Schema.Struct({
  event: Schema.optional(
    Schema.Struct({
      data: Schema.optional(
        Schema.Struct({
          stdout: Schema.optional(Schema.String),
          stderr: Schema.optional(Schema.String),
        }),
      ),
      end: Schema.optional(
        Schema.Struct({
          exitCode: Schema.optional(Schema.Number),
          error: Schema.optional(Schema.String),
        }),
      ),
    }),
  ),
});
const decodeE2bEvent = Schema.decodeUnknownOption(Schema.fromJsonString(E2bEvent));

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

/** One Connect envelope: a flags byte, a big-endian length, then the JSON message. */
export const connectEnvelope = (message: unknown): Uint8Array => {
  const body = textEncoder.encode(JSON.stringify(message));
  const frame = new Uint8Array(5 + body.length);
  new DataView(frame.buffer).setUint32(1, body.length);
  frame.set(body, 5);
  return frame;
};

const fromBase64 = (value: string) =>
  textDecoder.decode(Uint8Array.from(atob(value), (c) => c.charCodeAt(0)));

/** Folds envd's `process.Process/Start` stream into the command's output and exit code. */
const readConnectStream = (bytes: Uint8Array): CommandResult => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let output = "";
  let exitCode = -1;
  for (let offset = 0; offset + 5 <= bytes.length;) {
    const flags = bytes[offset]!;
    const length = view.getUint32(offset + 1);
    const message = textDecoder.decode(bytes.subarray(offset + 5, offset + 5 + length));
    offset += 5 + length;
    // Flag 2 ends the stream with trailers, not an event.
    if ((flags & 2) !== 0) continue;
    const event = decodeE2bEvent(message);
    if (event._tag === "None") continue;
    const data = event.value.event?.data;
    if (data?.stdout !== undefined) output += fromBase64(data.stdout);
    if (data?.stderr !== undefined) output += fromBase64(data.stderr);
    const end = event.value.event?.end;
    if (end !== undefined) exitCode = end.exitCode ?? 0;
  }
  return { exitCode, output };
};

/** E2B runs commands through the in-sandbox daemon's Connect RPC, on a per-sandbox token. */
const makeE2b = ({ send, sendBytes }: Deps): SessionAdapter => ({
  verify: (apiKey) =>
    Effect.asVoid(
      send("e2b", apiKey, HttpClientRequest.get(`${E2B_API_BASE_URL}/v2/sandboxes`), null),
    ),
  create: (apiKey) =>
    send(
      "e2b",
      apiKey,
      HttpClientRequest.post(`${E2B_API_BASE_URL}/sandboxes`).pipe(
        // An hour, E2B's longest for most plans; follow-ups extend it.
        HttpClientRequest.bodyJsonUnsafe({ templateID: "base", timeout: 3600 }),
      ),
      E2bCreated,
    ).pipe(Effect.map((created) => created!.sandboxID)),
  exec: Effect.fn("CloudSandbox.e2b.exec")(function* (apiKey, id, command, envs) {
    const connected = yield* send(
      "e2b",
      apiKey,
      HttpClientRequest.post(`${E2B_API_BASE_URL}/sandboxes/${id}/connect`).pipe(
        HttpClientRequest.bodyJsonUnsafe({ timeout: 3600 }),
      ),
      E2bConnected,
    );
    const host = `https://49983-${id}.${connected?.domain ?? "e2b.app"}`;
    const request = HttpClientRequest.post(`${host}/process.Process/Start`).pipe(
      HttpClientRequest.setHeaders({
        "Connect-Protocol-Version": "1",
        ...(connected?.envdAccessToken ? { "X-Access-Token": connected.envdAccessToken } : {}),
      }),
      HttpClientRequest.bodyUint8Array(
        connectEnvelope({
          process: { cmd: "/bin/bash", args: ["-l", "-c", command], envs },
        }),
        "application/connect+json",
      ),
    );
    return readConnectStream(yield* sendBytes("e2b", apiKey, request));
  }),
  remove: (apiKey, id) =>
    Effect.asVoid(
      send("e2b", apiKey, HttpClientRequest.delete(`${E2B_API_BASE_URL}/sandboxes/${id}`), null),
    ),
});

const DaytonaSandbox = Schema.Struct({ id: Schema.String, state: Schema.optional(Schema.String) });
const DaytonaExecuted = Schema.Struct({
  exitCode: Schema.optional(Schema.Number),
  result: Schema.String,
});

/** Daytona runs commands through its toolbox proxy, on the same key. */
const makeDaytona = ({ send, failure }: Deps): SessionAdapter => ({
  verify: (apiKey) =>
    Effect.asVoid(
      send("daytona", apiKey, HttpClientRequest.get(`${DAYTONA_API_BASE_URL}/sandbox`), null),
    ),
  create: Effect.fn("CloudSandbox.daytona.create")(function* (apiKey) {
    const created = yield* send(
      "daytona",
      apiKey,
      HttpClientRequest.post(`${DAYTONA_API_BASE_URL}/sandbox`).pipe(
        // Stop after an idle hour rather than Daytona's 15 minutes, so a task can finish.
        HttpClientRequest.bodyJsonUnsafe({ autoStopInterval: 60 }),
      ),
      DaytonaSandbox,
    );
    // Creation can return before the sandbox runs; commands fail until it does.
    for (let attempt = 0; attempt < 60; attempt++) {
      const sandbox = yield* send(
        "daytona",
        apiKey,
        HttpClientRequest.get(`${DAYTONA_API_BASE_URL}/sandbox/${created!.id}`),
        DaytonaSandbox,
      );
      if (sandbox!.state === "started") return created!.id;
      if (sandbox!.state === "error" || sandbox!.state === "build_failed")
        return yield* failure("daytona", "unavailable");
      yield* Effect.sleep("2 seconds");
    }
    return yield* failure("daytona", "unavailable");
  }),
  exec: (apiKey, id, command, envs) =>
    send(
      "daytona",
      apiKey,
      HttpClientRequest.post(`${DAYTONA_TOOLBOX_BASE_URL}/${id}/process/execute`).pipe(
        HttpClientRequest.bodyJsonUnsafe({
          command: `bash -lc ${shellQuote(command)}`,
          envs,
          timeout: 600,
        }),
      ),
      DaytonaExecuted,
    ).pipe(Effect.map((done) => ({ exitCode: done!.exitCode ?? 0, output: done!.result }))),
  remove: (apiKey, id) =>
    Effect.asVoid(
      send(
        "daytona",
        apiKey,
        HttpClientRequest.delete(`${DAYTONA_API_BASE_URL}/sandbox/${id}`),
        null,
      ),
    ),
});

const Agent37Instance = Schema.Struct({ id: Schema.String });
const Agent37Executed = Schema.Struct({
  exit_code: Schema.optional(Schema.Number),
  exitCode: Schema.optional(Schema.Number),
  stdout: Schema.optional(Schema.String),
  stderr: Schema.optional(Schema.String),
  output: Schema.optional(Schema.String),
});

/** Agent37 runs commands on `sandbox.agent37.app`, which takes the key in its own header. */
const makeAgent37 = ({ send }: Deps): SessionAdapter => ({
  verify: (apiKey) =>
    Effect.asVoid(
      send("agent37", apiKey, HttpClientRequest.get(`${AGENT37_API_BASE_URL}/instances`), null),
    ),
  create: (apiKey) =>
    send(
      "agent37",
      apiKey,
      HttpClientRequest.post(`${AGENT37_API_BASE_URL}/instances`).pipe(
        HttpClientRequest.bodyJsonUnsafe({ template: "agent37-claude-code" }),
      ),
      Agent37Instance,
    ).pipe(Effect.map((instance) => instance!.id)),
  exec: (apiKey, id, command, envs) =>
    send(
      "agent37",
      apiKey,
      HttpClientRequest.post(`${AGENT37_SANDBOX_BASE_URL}/instances/${id}/exec`).pipe(
        HttpClientRequest.bodyJsonUnsafe({
          command: `${envPrefix(envs)}bash -lc ${shellQuote(command)}`,
        }),
      ),
      Agent37Executed,
    ).pipe(
      Effect.map((done) => ({
        exitCode: done!.exit_code ?? done!.exitCode ?? 0,
        output: done!.output ?? `${done!.stdout ?? ""}${done!.stderr ?? ""}`,
      })),
    ),
  remove: (apiKey, id) =>
    Effect.asVoid(
      send(
        "agent37",
        apiKey,
        HttpClientRequest.delete(`${AGENT37_API_BASE_URL}/instances/${id}`),
        null,
      ),
    ),
});

const shellQuote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;
const envPrefix = (envs: Readonly<Record<string, string>>) =>
  Object.entries(envs)
    .map(([name, value]) => `${name}=${shellQuote(value)} `)
    .join("");

export const makeSessionAdapters = (deps: Deps): Record<SessionProvider, SessionAdapter> => ({
  e2b: makeE2b(deps),
  daytona: makeDaytona(deps),
  agent37: makeAgent37(deps),
});
