import * as HostProcess from "@t3tools/shared/HostProcess";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Stdio from "effect/Stdio";
import * as Stream from "effect/Stream";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Socket from "effect/socket/Socket";

import { HOPLITE_API_BASE_URL, HOPLITE_API_KEY_SECRET } from "./HopliteCloudService.ts";
import { HOPLITE_ACP_URL } from "./HopliteTaskChat.ts";

export class HopliteAcpBridgeError extends Schema.TaggedError<HopliteAcpBridgeError>()(
  "HopliteAcpBridgeError",
  {
    stage: Schema.Literals(["credential", "repository", "project", "connection", "protocol"]),
  },
) {
  override get message() {
    switch (this.stage) {
      case "credential":
        return "Connect Hoplite in Settings > Environments, or set HOPLITE_API_KEY for this provider.";
      case "repository":
        return "This folder needs a GitHub origin remote, or HOPLITE_PROJECT_ID for this provider.";
      case "project":
        return "Connect this repository in Hoplite, or set HOPLITE_PROJECT_ID for this provider.";
      case "connection":
        return "Hoplite could not be reached. Check the connection in Settings > Environments.";
      case "protocol":
        return "Hoplite received an invalid or oversized ACP message.";
    }
  }
}

const isHopliteAcpBridgeError = Schema.is(HopliteAcpBridgeError);

const RpcFrame = Schema.Record(Schema.String, Schema.Json);
const decodeFrame = Schema.decodeEffect(Schema.fromJsonString(RpcFrame));
const encodeFrame = Schema.encodeEffect(Schema.fromJsonString(RpcFrame));
const decodeParams = Schema.decodeUnknownOption(RpcFrame);
const Projects = Schema.Struct({
  projects: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      repos: Schema.optional(Schema.Array(Schema.Struct({ repoFullName: Schema.String }))),
    }),
  ),
  nextCursor: Schema.optional(Schema.NullOr(Schema.String)),
});
const normalizeRepo = (repo: string) =>
  repo
    .trim()
    .replace(/^(?:https?:\/\/|git@)?github\.com[/:]/i, "")
    .replace(/\.git$/i, "")
    .replace(/\/+$/, "")
    .toLowerCase();
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const protocolFailure = () => new HopliteAcpBridgeError({ stage: "protocol" });

const HOPLITE_ACP_AUTH_REQUEST_ID = "t3-hoplite-auth";
const HOPLITE_ACP_AUTH_METHOD_ID = "hoplite-api-key";

export interface HopliteAcpAuthState {
  readonly initializeId: unknown;
  readonly pendingInitialize: string | undefined;
  readonly authInFlight: boolean;
}

export const hopliteAcpAuthStateInit: HopliteAcpAuthState = {
  initializeId: undefined,
  pendingInitialize: undefined,
  authInFlight: false,
};

/** Hoplite hosts its own MCP servers; local T3 launch commands and credentials stay on this host. */
export const prepareHopliteFrame = Effect.fn("HopliteAcpBridge.prepareFrame")(function* (
  line: string,
) {
  let frame = yield* decodeFrame(line).pipe(Effect.mapError(protocolFailure));
  if (["session/new", "session/load", "session/resume"].includes(String(frame.method))) {
    const params = decodeParams(frame.params);
    if (Option.isSome(params)) frame = { ...frame, params: { ...params.value, mcpServers: [] } };
  }
  const encoded = yield* encodeFrame(frame).pipe(Effect.mapError(protocolFailure));
  if (encoder.encode(encoded).length > 1024 * 1024) return yield* protocolFailure();
  return encoded;
});

/** Remembers the client's initialize id so its upstream reply can be held for bridge-side auth. */
export const trackHopliteOutboundFrame = Effect.fn("HopliteAcpBridge.trackOutbound")(function* (
  line: string,
  state: Ref.Ref<HopliteAcpAuthState>,
) {
  const frame = yield* decodeFrame(line).pipe(Effect.mapError(protocolFailure));
  if (frame.method === "initialize") {
    yield* Ref.update(state, (current) => ({ ...current, initializeId: frame.id }));
  }
});

/**
 * Answers Hoplite's login handshake for the client (`auth/login` on ACP v2, `authenticate` on v1):
 * holds the upstream initialize reply until the bridge's login succeeds, then releases it with
 * authMethods emptied. Other frames, including initialize error replies, pass through unchanged.
 */
export const handleHopliteInboundFrame = Effect.fn("HopliteAcpBridge.handleInbound")(function* (
  line: string,
  state: Ref.Ref<HopliteAcpAuthState>,
) {
  const frame = yield* decodeFrame(line).pipe(Effect.mapError(protocolFailure));
  const current = yield* Ref.get(state);
  if (current.authInFlight && frame.id === HOPLITE_ACP_AUTH_REQUEST_ID) {
    if (frame.error !== undefined) {
      return yield* new HopliteAcpBridgeError({ stage: "credential" });
    }
    const held = current.pendingInitialize;
    yield* Ref.set(state, { ...current, pendingInitialize: undefined, authInFlight: false });
    if (held === undefined) return { toClient: Option.none(), toUpstream: Option.none() };
    const heldFrame = yield* decodeFrame(held).pipe(Effect.mapError(protocolFailure));
    const result = heldFrame.result;
    const rewritten = {
      ...heldFrame,
      result:
        typeof result === "object" && result !== null
          ? { ...result, authMethods: [] }
          : { authMethods: [] },
    };
    const encoded = yield* encodeFrame(rewritten).pipe(Effect.mapError(protocolFailure));
    return {
      toClient: Option.some(encoded),
      toUpstream: Option.none<string>(),
    };
  }
  if (
    current.initializeId !== undefined &&
    frame.method === undefined &&
    frame.id === current.initializeId &&
    frame.result !== undefined
  ) {
    yield* Ref.set(state, { ...current, pendingInitialize: line, authInFlight: true });
    const resultObject = decodeParams(frame.result);
    const protocolVersion = Option.isSome(resultObject)
      ? resultObject.value["protocolVersion"]
      : undefined;
    const authRequest = yield* encodeFrame({
      jsonrpc: "2.0",
      id: HOPLITE_ACP_AUTH_REQUEST_ID,
      method:
        typeof protocolVersion === "number" && protocolVersion >= 2 ? "auth/login" : "authenticate",
      params: { methodId: HOPLITE_ACP_AUTH_METHOD_ID },
    }).pipe(Effect.mapError(protocolFailure));
    return {
      toClient: Option.none<string>(),
      toUpstream: Option.some(authRequest),
    };
  }
  return {
    toClient: Option.some(line),
    toUpstream: Option.none<string>(),
  };
});

/**
 * Selects the cloud project by this checkout's origin without creating a thread during provider
 * checks. Hoplite requires an ACP login (`auth/login` on protocol v2, `authenticate` on v1) before
 * `session/new`; the bridge answers it itself with the resolved API key and rewrites the initialize
 * reply so clients see no authMethods.
 */
export const runHopliteAcpBridge = Effect.gen(function* () {
  const environment = yield* HostProcess.Environment;
  const cwd = yield* HostProcess.WorkingDirectory;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const http = yield* HttpClient.HttpClient;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const stdio = yield* Stdio.Stdio;
  const stateDir = environment.T3CODE_PROVIDER_STATE_DIR;
  const apiKey =
    environment.HOPLITE_API_KEY?.trim() ||
    (stateDir === undefined
      ? undefined
      : yield* fs
          .readFileString(path.join(stateDir, "secrets", `${HOPLITE_API_KEY_SECRET}.bin`))
          .pipe(Effect.orElseSucceed(() => undefined)));
  if (!apiKey) return yield* new HopliteAcpBridgeError({ stage: "credential" });
  let projectId = environment.HOPLITE_PROJECT_ID?.trim();
  if (!projectId) {
    const command = yield* resolveSpawnCommand("git", ["remote", "get-url", "origin"]);
    const origin = yield* spawner
      .string(
        ChildProcess.make(command.command, command.args, {
          cwd,
          shell: command.shell,
          stdin: "ignore",
          stderr: "ignore",
        }),
      )
      .pipe(Effect.mapError(() => new HopliteAcpBridgeError({ stage: "repository" })));
    const repo = normalizeRepo(origin);
    if (!/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/i.test(repo))
      return yield* new HopliteAcpBridgeError({ stage: "repository" });
    let cursor: string | null = null;
    for (let page = 0; page < 10 && !projectId; page++) {
      const request = HttpClientRequest.get(`${HOPLITE_API_BASE_URL}/api/projects`).pipe(
        HttpClientRequest.bearerToken(apiKey),
        HttpClientRequest.setUrlParams({
          pagination: "cursor",
          limit: "100",
          ...(cursor === null ? {} : { cursor }),
        }),
      );
      const response = yield* http
        .execute(request)
        .pipe(Effect.mapError(() => new HopliteAcpBridgeError({ stage: "connection" })));
      if (response.status < 200 || response.status >= 300)
        return yield* new HopliteAcpBridgeError({
          stage: response.status === 401 || response.status === 403 ? "credential" : "connection",
        });
      const result: typeof Projects.Type = yield* HttpClientResponse.schemaBodyJson(Projects)(
        response,
      ).pipe(Effect.mapError(() => new HopliteAcpBridgeError({ stage: "project" })));
      projectId = result.projects.find((project) =>
        project.repos?.some((candidate) => normalizeRepo(candidate.repoFullName) === repo),
      )?.id;
      cursor = result.nextCursor ?? null;
      if (cursor === null) break;
    }
    if (!projectId) return yield* new HopliteAcpBridgeError({ stage: "project" });
  }
  const url = new URL(HOPLITE_ACP_URL);
  url.searchParams.set("projectId", projectId);
  const socket = yield* Socket.makeWebSocket(url.toString(), {
    openTimeout: "10 seconds",
    headers: { "X-Api-Key": apiKey },
  });
  const writer = yield* socket.writer;
  const authState = yield* Ref.make(hopliteAcpAuthStateInit);
  const outbound = stdio.stdin.pipe(
    Stream.decodeText(),
    Stream.splitLines,
    Stream.filter((line) => line.length > 0),
    Stream.mapEffect(prepareHopliteFrame),
    Stream.tap((frame) => trackHopliteOutboundFrame(frame, authState)),
    Stream.runForEach((frame) => writer.write(frame)),
  );
  const inbound = Socket.toStream(socket).pipe(
    Stream.mapEffect((frame) => handleHopliteInboundFrame(decoder.decode(frame), authState)),
    Stream.tap(({ toUpstream }) =>
      Option.isSome(toUpstream) ? writer.write(toUpstream.value) : Effect.void,
    ),
    Stream.filterMap((action) =>
      Option.isSome(action.toClient) ? Result.succeed(action.toClient.value) : Result.failVoid,
    ),
    Stream.map((line) => encoder.encode(`${line}\n`)),
    Stream.run(stdio.stdout()),
  );
  yield* Effect.raceFirst(outbound, inbound);
}).pipe(
  Effect.mapError((error) =>
    isHopliteAcpBridgeError(error) ? error : new HopliteAcpBridgeError({ stage: "connection" }),
  ),
  Effect.withTracerEnabled(false),
);
