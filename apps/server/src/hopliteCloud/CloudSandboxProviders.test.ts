import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientResponse, UrlParams } from "effect/http";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { connectEnvelope } from "./CloudSandboxProviders.ts";
import * as HopliteCloud from "./HopliteCloudService.ts";

const KEYS = { e2b: "e2b_good_key", daytona: "dtn_good_key", agent37: "sk_live_good_key" };
const ANTHROPIC_KEY = "sk-ant-model-secret";
const OAUTH_TOKEN = "sk-ant-oat01-subscription-secret";
const GITHUB_TOKEN = "ghp_github_secret";

interface Sent {
  readonly method: string;
  readonly url: string;
  readonly params: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

// The agent's state files, as READ_TURN_SCRIPT prints them once its first turn finished.
const turnOutput = (result: string) =>
  `turn=1\nexit=0\n---\n${JSON.stringify({ result })}\n---t3-task-err---\nwarn {retrying}`;
const finishedTurn = turnOutput(
  `Opened https://github.com/acme/web/pull/3 with ${ANTHROPIC_KEY} and ${GITHUB_TOKEN}, not https://github.com/${GITHUB_TOKEN}/web/pull/4`,
);

interface HarnessOptions {
  /** The exit code of the script that starts a turn. */
  readonly turnExit?: number;
  readonly readOutput?: string;
  /** What any other command prints. */
  readonly commandOutput?: string;
  /** E2B's stream ends with an RPC error. */
  readonly e2bError?: boolean;
  /** The enqueue script reports `queued` instead of a turn. */
  readonly queued?: boolean;
  /** Daytona's sandbox is stopped until POST /start arrives. */
  readonly daytonaStopped?: boolean;
  /** Successive chat reads return these outputs, then the last one. */
  readonly chatOutputs?: ReadonlyArray<string>;
}

const base64 = (text: string) => btoa(text);

// E2B, Daytona and Agent37 APIs that accept one key each, and record what they were sent.
const makeHarness = (environment: NodeJS.ProcessEnv, options: HarnessOptions = {}) => {
  const {
    turnExit = 0,
    readOutput = finishedTurn,
    commandOutput = "",
    e2bError = false,
    queued = false,
    daytonaStopped = false,
    chatOutputs = [],
  } = options;
  const stored = new Map<string, Uint8Array>();
  const sent: Array<Sent> = [];
  let daytonaState = daytonaStopped ? "stopped" : "started";
  let chatReads = 0;
  const secrets = ServerSecretStore.ServerSecretStore.of({
    get: (name) => Effect.sync(() => Option.fromNullishOr(stored.get(name))),
    set: (name, value) => Effect.sync(() => void stored.set(name, value)),
    create: (name, value) => Effect.sync(() => void stored.set(name, value)),
    getOrCreateRandom: () => Effect.die("unused"),
    remove: (name) => Effect.sync(() => void stored.delete(name)),
  });
  const httpClient = HttpClient.make((request) => {
    const url = new URL(request.url);
    const body =
      request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : "";
    sent.push({
      method: request.method,
      url: request.url,
      params: UrlParams.toString(request.urlParams),
      headers: request.headers,
      body,
    });
    const respond = (status: number, json: unknown) =>
      Effect.succeed(HttpClientResponse.fromWeb(request, Response.json(json, { status })));
    const chats = body.includes("t3-chat");
    const reads = body.includes("exit=$(cat") && !chats;
    const starts = body.includes("--dangerously-skip-permissions");
    const exitCode = starts ? turnExit : 0;
    const output = chats
      ? (chatOutputs[Math.min(chatReads, Math.max(chatOutputs.length - 1, 0))] ?? commandOutput)
      : reads
        ? readOutput
        : starts
          ? queued
            ? "queued"
            : exitCode === 0
              ? "turn=2"
              : "fatal: repository not found"
          : commandOutput;
    if (chats) chatReads += 1;
    if (url.host === "app.daytona.io" && url.pathname.endsWith("/signed-preview-url")) {
      if (request.headers.authorization !== `Bearer ${KEYS.daytona}`) return respond(401, {});
      const port = /ports\/(\d+)\//.exec(url.pathname)?.[1] ?? "3000";
      return respond(200, { url: `https://${port}-dsb-1.daytona.app` });
    }
    const route = `${request.method} ${url.host}${url.pathname}`;
    switch (route) {
      case "GET api.e2b.app/v2/sandboxes":
      case "POST api.e2b.app/sandboxes":
      case "POST api.e2b.app/sandboxes/isb1/connect":
        if (request.headers["x-api-key"] !== KEYS.e2b) return respond(401, {});
        return respond(
          200,
          route.startsWith("GET")
            ? []
            : { sandboxID: "isb1", envdAccessToken: "envd_token", domain: "e2b.app" },
        );
      case "POST 49983-isb1.e2b.app/process.Process/Start": {
        if (request.headers["x-access-token"] !== "envd_token") return respond(401, {});
        const frames = [
          connectEnvelope({ event: { data: { stdout: base64(output) } } }),
          connectEnvelope({ event: { end: { exitCode } } }),
        ];
        const trailer = connectEnvelope(
          e2bError ? { error: { code: "deadline_exceeded", message: "timed out" } } : {},
        );
        trailer[0] = 2;
        return Effect.succeed(
          HttpClientResponse.fromWeb(request, new Response(new Blob([...frames, trailer]))),
        );
      }
      case "GET app.daytona.io/api/sandbox":
      case "POST app.daytona.io/api/sandbox":
      case "GET app.daytona.io/api/sandbox/dsb-1":
      case "POST app.daytona.io/api/sandbox/dsb-1/start":
      case "DELETE app.daytona.io/api/sandbox/dsb-1":
      case "POST proxy.app.daytona.io/toolbox/dsb-1/process/execute":
        if (request.headers.authorization !== `Bearer ${KEYS.daytona}`) return respond(401, {});
        if (route.endsWith("/execute")) {
          if (daytonaState === "stopped") return respond(500, {});
          return respond(200, { exitCode, result: output });
        }
        if (route.endsWith("/start")) {
          daytonaState = "started";
          return respond(200, {});
        }
        if (route === "GET app.daytona.io/api/sandbox" || route.startsWith("DELETE"))
          return respond(200, []);
        return respond(200, {
          id: "dsb-1",
          state: route.startsWith("POST") ? "creating" : daytonaState,
        });
      case "GET api.agent37.com/v1/instances":
      case "POST api.agent37.com/v1/instances":
        if (request.headers.authorization !== `Bearer ${KEYS.agent37}`) return respond(401, {});
        return respond(200, route.startsWith("GET") ? { instances: [] } : { id: "a37x" });
      case "POST sandbox.agent37.app/v1/instances/a37x/exec":
        if (request.headers["x-agent37-key"] !== KEYS.agent37) return respond(401, {});
        return respond(200, { exit_code: exitCode, stdout: output });
    }
    return respond(404, {});
  });
  const layer = HopliteCloud.layer.pipe(
    Layer.provide(Layer.succeed(ServerSecretStore.ServerSecretStore, secrets)),
    Layer.provide(Layer.succeed(HttpClient.HttpClient, httpClient)),
    Layer.provide(Layer.succeed(HostProcess.Environment, environment)),
    Layer.provide(NodeCrypto.layer),
  );
  return { sent, layer };
};

const errorCode = <A, E extends { readonly code: string }, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.flip,
    Effect.map((error) => error.code),
  );

const agentEnvironment = { ANTHROPIC_API_KEY: ANTHROPIC_KEY, GH_TOKEN: GITHUB_TOKEN };

it.effect.each([
  ["e2b", "isb1"],
  ["daytona", "dsb-1"],
  ["agent37", "a37x"],
] as const)(
  "%s runs Claude Code in a new sandbox and hides every key from its reply",
  ([provider, sandboxId]) => {
    const harness = makeHarness(agentEnvironment);
    return Effect.gen(function* () {
      const cloud = yield* HopliteCloud.HopliteCloud;
      assert.equal(yield* errorCode(cloud.connect(provider, "wrong_key_value")), "invalid_key");
      yield* cloud.connect(provider, KEYS[provider]);

      const started = yield* cloud.startTask({ provider, prompt: "Fix login", repo: "acme/web" });
      assert.equal(started.task.threadId, `${provider}:${sandboxId}`);
      if (provider === "agent37") {
        const created = harness.sent.find(
          (request) => request.method === "POST" && request.url.endsWith("/instances"),
        );
        assert.deepInclude(JSON.parse(created!.body), {
          auto_sleep: true,
          idle_timeout_seconds: 3600,
        });
      }
      const turn = harness.sent.find((request) =>
        request.body.includes("--dangerously-skip-permissions"),
      );
      assert.isDefined(turn);
      // The model key and GitHub token go in as the agent's environment, never as a URL.
      assert.include(turn!.body, ANTHROPIC_KEY);
      assert.isFalse(harness.sent.some((request) => request.url.includes(ANTHROPIC_KEY)));

      const read = yield* cloud.readTask({ threadId: `${provider}:${sandboxId}` });
      assert.deepInclude(read.task, {
        status: "ready",
        pullRequestUrl: "https://github.com/acme/web/pull/3",
        latestReply:
          "Opened https://github.com/acme/web/pull/3 with [redacted] and [redacted], not https://github.com/[redacted]/web/pull/4",
      });
      assert.deepStrictEqual(read.run, { id: "turn-1", status: "completed" });
      yield* cloud.readTask({ threadId: `${provider}:${sandboxId}`, runId: "turn-1" });
      assert.include(harness.sent.at(-1)!.body, "runs/$turn");
    }).pipe(Effect.provide(harness.layer));
  },
);

it.effect("E2B's key goes only to its API, never to the sandbox's own daemon", () => {
  const harness = makeHarness(agentEnvironment);
  return Effect.gen(function* () {
    const cloud = yield* HopliteCloud.HopliteCloud;
    yield* cloud.connect("e2b", KEYS.e2b);
    const sandbox = yield* cloud.createSandbox({ provider: "e2b" });
    const ran = yield* cloud.runInSandbox({ sandboxId: sandbox.sandboxId, command: "ls" });
    assert.deepStrictEqual(ran, { exitCode: 0, output: "" });
    const daemon = harness.sent.filter((request) => request.url.includes("49983-isb1"));
    assert.lengthOf(daemon, 1);
    assert.isUndefined(daemon[0]!.headers["x-api-key"]);
    assert.isUndefined(daemon[0]!.headers.authorization);
  }).pipe(Effect.provide(harness.layer));
});

it.effect("refuses sandbox ids outside each provider's format before sending a key", () => {
  const harness = makeHarness(agentEnvironment);
  return Effect.gen(function* () {
    const cloud = yield* HopliteCloud.HopliteCloud;
    for (const provider of ["e2b", "daytona", "agent37"] as const) {
      yield* cloud.connect(provider, KEYS[provider]);
    }
    const before = harness.sent.length;
    for (const runId of ["../x", "turn-1;echo bad", "turn-0"]) {
      assert.equal(
        yield* errorCode(cloud.readTask({ threadId: "daytona:dsb-1", runId })),
        "not_found",
      );
    }
    for (const threadId of ["e2b:../x", "e2b:ISB1", "daytona:-x", "daytona:a/b", "agent37:.."]) {
      assert.equal(yield* errorCode(cloud.readTask({ threadId })), "not_found");
      assert.equal(
        yield* errorCode(cloud.runInSandbox({ sandboxId: threadId, command: "ls" })),
        "not_found",
      );
    }
    assert.equal(
      yield* errorCode(cloud.runInSandbox({ sandboxId: "thr_abc", command: "ls" })),
      "not_found",
    );
    assert.equal(harness.sent.length, before);
  }).pipe(Effect.provide(harness.layer));
});

it.effect("asks for a model key before creating a sandbox for a task", () => {
  const harness = makeHarness({});
  return Effect.gen(function* () {
    const cloud = yield* HopliteCloud.HopliteCloud;
    yield* cloud.connect("daytona", KEYS.daytona);
    const before = harness.sent.length;
    assert.equal(
      yield* errorCode(cloud.startTask({ provider: "daytona", prompt: "Fix", repo: "acme/web" })),
      "not_connected",
    );
    assert.equal(harness.sent.length, before);
  }).pipe(Effect.provide(harness.layer));
});

interface ClaudeKeyCase {
  readonly environment: NodeJS.ProcessEnv;
  /** Saved through setClaudeCredential before the task starts. */
  readonly saved?: string;
  readonly commandOutput?: string;
  readonly included: ReadonlyArray<string>;
  readonly excluded: ReadonlyArray<string>;
  readonly envOutput?: string;
  readonly statusClaude?: {
    readonly source: "settings" | "environment";
    readonly kind: "api_key" | "subscription";
  };
}

const claudeKeyCases: ReadonlyArray<readonly [name: string, options: ClaudeKeyCase]> = [
  [
    "runs Claude Code on a subscription token when no API key is set",
    {
      environment: { CLAUDE_CODE_OAUTH_TOKEN: OAUTH_TOKEN },
      commandOutput: `CLAUDE_CODE_OAUTH_TOKEN=${OAUTH_TOKEN}`,
      included: ["CLAUDE_CODE_OAUTH_TOKEN", OAUTH_TOKEN],
      excluded: ["ANTHROPIC_API_KEY"],
      envOutput: "CLAUDE_CODE_OAUTH_TOKEN=[redacted]",
      statusClaude: { source: "environment", kind: "subscription" },
    },
  ],
  [
    "prefers the API key when a subscription token is also set",
    {
      environment: {
        ANTHROPIC_API_KEY: ANTHROPIC_KEY,
        CLAUDE_CODE_OAUTH_TOKEN: OAUTH_TOKEN,
      },
      included: [ANTHROPIC_KEY],
      excluded: [OAUTH_TOKEN],
      statusClaude: { source: "environment", kind: "api_key" },
    },
  ],
  [
    "prefers a Claude login saved in Settings over the environment",
    {
      environment: { ANTHROPIC_API_KEY: ANTHROPIC_KEY },
      saved: "sk-ant-oat99-saved-subscription",
      commandOutput: "CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat99-saved-subscription",
      included: ["CLAUDE_CODE_OAUTH_TOKEN", "sk-ant-oat99-saved-subscription"],
      excluded: [ANTHROPIC_KEY],
      envOutput: "CLAUDE_CODE_OAUTH_TOKEN=[redacted]",
      statusClaude: { source: "settings", kind: "subscription" },
    },
  ],
];

it.effect.each(claudeKeyCases)("%s", ([, options]) => {
  const harness = makeHarness(options.environment, {
    commandOutput: options.commandOutput ?? "",
  });
  return Effect.gen(function* () {
    const cloud = yield* HopliteCloud.HopliteCloud;
    yield* cloud.connect("daytona", KEYS.daytona);
    if (options.saved !== undefined) yield* cloud.setClaudeCredential(options.saved);
    const status = yield* cloud.status;
    assert.deepInclude(status, { claude: options.statusClaude ?? null });
    yield* cloud.startTask({ provider: "daytona", prompt: "Fix", repo: "acme/web" });
    const turn = harness.sent.find((request) =>
      request.body.includes("--dangerously-skip-permissions"),
    );
    assert.isDefined(turn);
    for (const expected of options.included) assert.include(turn!.body, expected);
    for (const unexpected of options.excluded) assert.notInclude(turn!.body, unexpected);
    if (options.envOutput !== undefined) {
      const ran = yield* cloud.runInSandbox({ sandboxId: "daytona:dsb-1", command: "env" });
      assert.equal(ran.output, options.envOutput);
    }
  }).pipe(Effect.provide(harness.layer));
});

it.effect("redacts a key that the reply's length limit would cut in two", () => {
  const reply = `${"x".repeat(3_990)}${ANTHROPIC_KEY}`;
  const harness = makeHarness(agentEnvironment, { readOutput: turnOutput(reply) });
  return Effect.gen(function* () {
    const cloud = yield* HopliteCloud.HopliteCloud;
    yield* cloud.connect("daytona", KEYS.daytona);
    const read = yield* cloud.readTask({ threadId: "daytona:dsb-1" });
    assert.equal(read.task.latestReply, `${"x".repeat(3_990)}[redacted]`);
  }).pipe(Effect.provide(harness.layer));
});

it.effect("hides the agent's keys from commands run in a task's sandbox", () => {
  const harness = makeHarness(agentEnvironment, {
    commandOutput: `ANTHROPIC_API_KEY=${ANTHROPIC_KEY}`,
  });
  return Effect.gen(function* () {
    const cloud = yield* HopliteCloud.HopliteCloud;
    yield* cloud.connect("daytona", KEYS.daytona);
    const ran = yield* cloud.runInSandbox({ sandboxId: "daytona:dsb-1", command: "env" });
    assert.equal(ran.output, "ANTHROPIC_API_KEY=[redacted]");
  }).pipe(Effect.provide(harness.layer));
});

it.effect("deletes the sandbox and fails the task when its agent cannot start", () => {
  const harness = makeHarness(agentEnvironment, { turnExit: 128 });
  return Effect.gen(function* () {
    const cloud = yield* HopliteCloud.HopliteCloud;
    yield* cloud.connect("daytona", KEYS.daytona);
    const error = yield* Effect.flip(
      cloud.startTask({ provider: "daytona", prompt: "Fix", repo: "acme/missing" }),
    );
    assert.equal(error.code, "unavailable");
    assert.include(error.message, "fatal: repository not found");
    assert.isTrue(
      harness.sent.some((request) => request.method === "DELETE" && request.url.endsWith("/dsb-1")),
    );
  }).pipe(Effect.provide(harness.layer));
});

it.effect("queues a follow-up behind the turn still running", () => {
  const harness = makeHarness(agentEnvironment, { queued: true });
  return Effect.gen(function* () {
    const cloud = yield* HopliteCloud.HopliteCloud;
    yield* cloud.connect("daytona", KEYS.daytona);
    assert.deepStrictEqual(
      yield* cloud.sendMessage({ threadId: "daytona:dsb-1", message: "Also fix signup" }),
      { runId: null },
    );
  }).pipe(Effect.provide(harness.layer));
});

it.effect("passes a task's model and template into the sandbox", () => {
  const harness = makeHarness(agentEnvironment);
  return Effect.gen(function* () {
    const cloud = yield* HopliteCloud.HopliteCloud;
    yield* cloud.connect("daytona", KEYS.daytona);
    yield* cloud.startTask({
      provider: "daytona",
      prompt: "Fix",
      repo: "acme/web",
      model: "opus",
      template: "snap-web",
    });
    const created = harness.sent.find(
      (request) => request.method === "POST" && request.url.endsWith("/api/sandbox"),
    );
    assert.deepInclude(JSON.parse(created!.body), { snapshot: "snap-web" });
    const turn = harness.sent.find((request) =>
      request.body.includes("--dangerously-skip-permissions"),
    );
    // The model goes in the turn's environment; the script adds --model only when set.
    const envs = JSON.parse(turn!.body).envs as Record<string, string>;
    assert.equal(envs.T3_TASK_MODEL, "opus");
  }).pipe(Effect.provide(harness.layer));
});

it.effect("creates E2B sandboxes that pause on idle, from a template", () => {
  const harness = makeHarness(agentEnvironment);
  return Effect.gen(function* () {
    const cloud = yield* HopliteCloud.HopliteCloud;
    yield* cloud.connect("e2b", KEYS.e2b);
    yield* cloud.createSandbox({ provider: "e2b", template: "tmpl-web" });
    const created = harness.sent.find(
      (request) => request.method === "POST" && request.url.endsWith("/sandboxes"),
    );
    assert.deepInclude(JSON.parse(created!.body), {
      templateID: "tmpl-web",
      autoPause: true,
    });
  }).pipe(Effect.provide(harness.layer));
});

it.effect("previews the app a sandbox serves, each provider its own way", () => {
  const harness = makeHarness(agentEnvironment);
  return Effect.gen(function* () {
    const cloud = yield* HopliteCloud.HopliteCloud;
    for (const provider of ["e2b", "daytona", "agent37"] as const) {
      yield* cloud.connect(provider, KEYS[provider]);
    }
    assert.deepStrictEqual(yield* cloud.preview({ threadId: "e2b:isb1" }), {
      status: "ready",
      url: "https://3000-isb1.e2b.app",
      reason: null,
    });
    assert.deepStrictEqual(yield* cloud.preview({ threadId: "daytona:dsb-1", port: 8080 }), {
      status: "ready",
      url: "https://8080-dsb-1.daytona.app",
      reason: null,
    });
    const signed = harness.sent.find((request) => request.url.includes("signed-preview-url"));
    assert.include(signed!.params, "expiresInSeconds=86400");
    assert.deepStrictEqual(yield* cloud.preview({ threadId: "agent37:a37x" }), {
      status: "unsupported",
      url: null,
      reason: "Agent37 has no preview links.",
    });
  }).pipe(Effect.provide(harness.layer));
});

it.effect("starts a stopped Daytona sandbox and runs the command again", () => {
  const harness = makeHarness(agentEnvironment, {
    daytonaStopped: true,
    commandOutput: "done",
  });
  return Effect.gen(function* () {
    const cloud = yield* HopliteCloud.HopliteCloud;
    yield* cloud.connect("daytona", KEYS.daytona);
    assert.deepStrictEqual(
      yield* cloud.runInSandbox({ sandboxId: "daytona:dsb-1", command: "ls" }),
      { exitCode: 0, output: "done" },
    );
    const executions = harness.sent.filter((request) => request.url.endsWith("/execute"));
    assert.lengthOf(executions, 2);
    assert.isTrue(harness.sent.some((request) => request.url.endsWith("/api/sandbox/dsb-1/start")));
  }).pipe(Effect.provide(harness.layer));
});

it.effect("a retried task or follow-up with the same clientRequestId runs once", () => {
  const harness = makeHarness(agentEnvironment);
  return Effect.gen(function* () {
    const cloud = yield* HopliteCloud.HopliteCloud;
    yield* cloud.connect("daytona", KEYS.daytona);
    const start = {
      provider: "daytona",
      prompt: "Fix",
      repo: "acme/web",
      clientRequestId: "req-1",
    } as const;
    const first = yield* cloud.startTask(start);
    assert.deepStrictEqual(yield* cloud.startTask(start), first);
    const followUp = { threadId: "daytona:dsb-1", message: "More", clientRequestId: "req-2" };
    const sent = yield* cloud.sendMessage(followUp);
    assert.deepStrictEqual(sent, { runId: "turn-2" });
    assert.deepStrictEqual(yield* cloud.sendMessage(followUp), sent);
    yield* cloud.startTask({ ...start, prompt: "Another task" });
    const created = harness.sent.filter(
      (request) => request.method === "POST" && request.url.endsWith("/api/sandbox"),
    );
    const turns = harness.sent.filter((request) =>
      request.body.includes("--dangerously-skip-permissions"),
    );
    assert.lengthOf(created, 2);
    assert.lengthOf(turns, 3);
  }).pipe(Effect.provide(harness.layer));
});

it.effect("reports E2B's RPC error instead of an empty result", () => {
  const harness = makeHarness(agentEnvironment, { e2bError: true });
  return Effect.gen(function* () {
    const cloud = yield* HopliteCloud.HopliteCloud;
    yield* cloud.connect("e2b", KEYS.e2b);
    assert.equal(
      yield* errorCode(cloud.runInSandbox({ sandboxId: "e2b:isb1", command: "ls" })),
      "unavailable",
    );
  }).pipe(Effect.provide(harness.layer));
});

// The chat a readChatScript prints: a turn's prompt and stream-json, then whether its
// runner is still going.
const chatOutput = (jsonl: ReadonlyArray<string>, running: boolean, exit = "") =>
  [
    "---t3-chat-turn 1---",
    "---t3-chat-prompt---",
    "Fix login",
    "---t3-chat-jsonl---",
    ...jsonl,
    "",
    "---t3-chat-result---",
    "",
    "---t3-chat-exit---",
    exit,
    "",
    "---t3-chat-running---",
    running ? "1" : "0",
  ].join("\n");
const assistantText = (text: string) =>
  JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "text", text }] },
  });

it.effect("a sandbox task's chat replays, follows activity and polls while it runs", () => {
  const harness = makeHarness(agentEnvironment, {
    chatOutputs: [
      chatOutput([assistantText("Looking")], true),
      chatOutput([assistantText("Looking"), assistantText(`Still on ${GITHUB_TOKEN}`)], true),
      chatOutput([assistantText("Looking"), assistantText(`Still on ${GITHUB_TOKEN}`)], false, "0"),
    ],
  });
  return Effect.gen(function* () {
    const cloud = yield* HopliteCloud.HopliteCloud;
    yield* cloud.connect("daytona", KEYS.daytona);
    const activity = yield* Queue.unbounded<void>();
    const collected = yield* cloud
      .watchThreadChat("daytona:dsb-1", Stream.fromQueue(activity))
      .pipe(Stream.take(5), Stream.runCollect, Effect.forkChild);
    yield* Queue.offer(activity, undefined);
    yield* TestClock.adjust("3 seconds");
    const events = [...(yield* Fiber.join(collected))];
    assert.deepStrictEqual(
      events.map((event) => event._tag),
      ["replace", "live", "replace", "live", "live"],
    );
    const [first, , second] = events;
    assert.deepStrictEqual(first?._tag === "replace" ? first.entries : [], [
      { _tag: "message", id: "turn-1-user", role: "user", text: "Fix login" },
      { _tag: "message", id: "turn-1-1", role: "assistant", text: "Looking" },
    ]);
    const secondEntries = second?._tag === "replace" ? second.entries : [];
    // The chat output is redacted before it is parsed.
    assert.deepInclude(secondEntries.at(-1), { text: "Still on [redacted]" });
    assert.deepStrictEqual(events.at(-1), { _tag: "live", running: false });
  }).pipe(Effect.provide(harness.layer));
});
