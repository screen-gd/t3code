import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { HttpClient, HttpClientResponse } from "effect/http";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { DEVIN_API_BASE_URL, JULES_API_BASE_URL } from "./CloudSandboxProviders.ts";
import * as HopliteCloud from "./HopliteCloudService.ts";

const DEVIN_KEY = "apk_devin_good";
const JULES_KEY = "jules_good";

interface Sent {
  readonly method: string;
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: unknown;
}

// Devin and Jules APIs that accept one key each, and record what they were sent.
const makeHarness = (devinMessages: ReadonlyArray<{ type: string; message: string }>) => {
  const stored = new Map<string, Uint8Array>();
  const sent: Array<Sent> = [];
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
      request.body._tag === "Uint8Array"
        ? JSON.parse(new TextDecoder().decode(request.body.body))
        : null;
    sent.push({ method: request.method, url: request.url, headers: request.headers, body });
    const respond = (status: number, json: unknown) =>
      Effect.succeed(HttpClientResponse.fromWeb(request, Response.json(json, { status })));
    const path = `${url.origin}${url.pathname}`;
    if (path.startsWith(DEVIN_API_BASE_URL)) {
      if (request.headers.authorization !== `Bearer ${DEVIN_KEY}`) return respond(401, {});
      const route = path.slice(DEVIN_API_BASE_URL.length);
      if (route === "/sessions" && request.method === "GET") return respond(200, { sessions: [] });
      if (route === "/sessions") return respond(200, { session_id: "devin-1", url: "u" });
      if (route === "/sessions/devin-1" && request.method === "GET") {
        return respond(200, {
          session_id: "devin-1",
          title: "Fix login",
          status_enum: "blocked",
          pull_request: { url: "https://github.com/o/r/pull/9" },
          messages: devinMessages,
        });
      }
      if (route === "/sessions/devin-1/message" || route === "/sessions/devin-1") {
        return respond(200, null);
      }
      return respond(404, {});
    }
    if (path.startsWith(JULES_API_BASE_URL)) {
      if (request.headers["x-goog-api-key"] !== JULES_KEY) return respond(401, {});
      const route = path.slice(JULES_API_BASE_URL.length);
      if (route === "/sources") return respond(200, { sources: [] });
      if (route === "/sources/github/acme/api") {
        return respond(200, {
          name: "sources/github/acme/api",
          githubRepo: { owner: "acme", repo: "api", defaultBranch: { displayName: "trunk" } },
        });
      }
      if (route === "/sessions") return respond(200, { id: "77", title: "Fix login" });
      if (route === "/sessions/77") {
        return respond(200, {
          id: "77",
          state: "COMPLETED",
          outputs: [{ pullRequest: { url: "https://github.com/acme/api/pull/3" } }],
        });
      }
      if (route === "/sessions/77/activities") {
        return respond(200, {
          activities: [
            { agentMessaged: { agentMessage: "Planning." } },
            { userMessaged: { userMessage: "Use trunk." } },
            { agentMessaged: { agentMessage: "Done, PR opened." } },
          ],
        });
      }
      return respond(404, {});
    }
    return respond(500, {});
  });
  const layer = HopliteCloud.layer.pipe(
    Layer.provide(Layer.succeed(ServerSecretStore.ServerSecretStore, secrets)),
    Layer.provide(Layer.succeed(HttpClient.HttpClient, httpClient)),
    Layer.provide(NodeCrypto.layer),
  );
  return { stored, sent, layer };
};

const errorCode = <A, E extends { readonly code: string }, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.flip,
    Effect.map((error) => error.code),
  );

it.effect("each provider's key is checked, stored apart, and listed in the status", () => {
  const harness = makeHarness([]);
  return Effect.gen(function* () {
    const cloud = yield* HopliteCloud.HopliteCloud;
    assert.equal(yield* errorCode(cloud.connect("devin", "wrong")), "invalid_key");
    assert.isFalse(yield* cloud.connected);

    yield* cloud.connect("devin", DEVIN_KEY);
    const status = yield* cloud.connect("jules", JULES_KEY);
    assert.deepStrictEqual(status, {
      connected: false,
      problem: null,
      providers: [
        { provider: "hoplite", connected: false, problem: null },
        { provider: "devin", connected: true, problem: null },
        { provider: "jules", connected: true, problem: null },
      ],
    });
    assert.isTrue(harness.stored.has("cloud-sandbox-devin-api-key"));
    assert.isFalse(harness.stored.has(HopliteCloud.HOPLITE_API_KEY_SECRET));

    const after = yield* cloud.disconnect("devin");
    assert.isFalse(harness.stored.has("cloud-sandbox-devin-api-key"));
    assert.deepInclude(after.providers?.[1], { provider: "devin", connected: false });
  }).pipe(Effect.provide(harness.layer));
});

it.effect(
  "a Devin task starts from the only key, reads its turn, takes follow-ups and stops",
  () => {
    const harness = makeHarness([
      { type: "initial_user_message", message: "Fix login" },
      { type: "devin_message", message: "Opened a PR." },
    ]);
    return Effect.gen(function* () {
      const cloud = yield* HopliteCloud.HopliteCloud;
      yield* cloud.connect("devin", DEVIN_KEY);
      assert.equal(
        yield* errorCode(cloud.startTask({ prompt: "Fix login", model: "gpt" })),
        "model_unavailable",
      );

      const { task, runId } = yield* cloud.startTask({ prompt: "Fix login", repo: "acme/api" });
      assert.equal(task.threadId, "devin:devin-1");
      assert.isNull(runId);
      const create = harness.sent.find((request) => request.method === "POST");
      assert.deepStrictEqual(create?.body, {
        prompt: "Fix login\n\nWork in the GitHub repository acme/api.",
      });

      const read = yield* cloud.readTask({ threadId: task.threadId });
      assert.deepStrictEqual(read.run, { id: "turn-1", status: "completed" });
      assert.deepInclude(read.task, {
        status: "waiting",
        latestReply: "Opened a PR.",
        pullRequestUrl: "https://github.com/o/r/pull/9",
      });
      assert.deepStrictEqual(yield* cloud.listQuestions({ threadId: task.threadId }), []);
      assert.equal((yield* cloud.preview({ threadId: task.threadId })).status, "unsupported");

      yield* cloud.sendMessage({ threadId: task.threadId, message: "Add a test" });
      assert.deepStrictEqual(harness.sent.at(-1)?.body, { message: "Add a test" });

      // A session waiting for its next message has nothing running to stop.
      yield* cloud.stopTask({ threadId: task.threadId });
      assert.isFalse(harness.sent.some((request) => request.method === "DELETE"));
    }).pipe(Effect.provide(harness.layer));
  },
);

it.effect("a Jules task needs a repo it can see and reports the session's pull request", () => {
  const harness = makeHarness([]);
  return Effect.gen(function* () {
    const cloud = yield* HopliteCloud.HopliteCloud;
    yield* cloud.connect("jules", JULES_KEY);
    assert.equal(
      yield* errorCode(cloud.startTask({ provider: "jules", prompt: "Fix login" })),
      "project_required",
    );
    assert.equal(
      yield* errorCode(cloud.startTask({ provider: "jules", prompt: "x", repo: "acme/web" })),
      "repo_unavailable",
    );
    assert.equal(
      yield* errorCode(cloud.startTask({ provider: "devin", prompt: "x" })),
      "not_connected",
    );

    const { task } = yield* cloud.startTask({
      provider: "jules",
      prompt: "Fix login",
      repo: "https://github.com/acme/api",
    });
    assert.equal(task.threadId, "jules:77");
    const create = harness.sent.find((request) => request.method === "POST");
    assert.deepStrictEqual(create?.body, {
      prompt: "Fix login",
      sourceContext: {
        source: "sources/github/acme/api",
        githubRepoContext: { startingBranch: "trunk" },
      },
      automationMode: "AUTO_CREATE_PR",
    });

    const read = yield* cloud.readTask({ threadId: task.threadId });
    assert.deepStrictEqual(read.run, { id: "turn-2", status: "completed" });
    assert.deepInclude(read.task, {
      status: "ready",
      latestReply: "Done, PR opened.",
      pullRequestUrl: "https://github.com/acme/api/pull/3",
    });
    assert.equal(
      yield* errorCode(
        cloud.answerQuestion({ threadId: task.threadId, questionId: "q", answer: "yes" }),
      ),
      "unsupported",
    );
  }).pipe(Effect.provide(harness.layer));
});
