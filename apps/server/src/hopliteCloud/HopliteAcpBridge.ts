import * as HostProcess from "@t3tools/shared/HostProcess";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
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
const protocolFailure = () => new HopliteAcpBridgeError({ stage: "protocol" });

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

/** Selects the cloud project by this checkout's origin without creating a thread during provider checks. */
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
  const outbound = stdio.stdin.pipe(
    Stream.decodeText(),
    Stream.splitLines,
    Stream.filter((line) => line.length > 0),
    Stream.mapEffect(prepareHopliteFrame),
    Stream.runForEach((frame) => writer.write(frame)),
  );
  const inbound = Socket.toStream(socket).pipe(
    Stream.map((frame) => {
      const line = new Uint8Array(frame.length + 1);
      line.set(frame);
      line[frame.length] = 10;
      return line;
    }),
    Stream.run(stdio.stdout()),
  );
  yield* Effect.raceFirst(outbound, inbound);
}).pipe(
  Effect.mapError((error) =>
    isHopliteAcpBridgeError(error) ? error : new HopliteAcpBridgeError({ stage: "connection" }),
  ),
  Effect.withTracerEnabled(false),
);
