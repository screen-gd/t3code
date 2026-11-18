import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { HttpClient, HttpClientResponse, UrlParams } from "effect/http";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as HopliteCloud from "./HopliteCloudService.ts";

const GOOD_KEY = "hop_svc_good";
const REVOKED_KEY = "hop_svc_revoked";

interface Sent {
  readonly method: string;
  readonly path: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: unknown;
}

const thread = {
  id: "thr_1",
  projectId: "prj_1",
  title: "Fix login",
  status: "running",
  waitingOn: [],
  blockedOn: [],
  pendingWakeups: 0,
  tasks: [],
  pullRequests: [{ number: 7, url: "https://github.com/o/r/pull/7", repoFullName: "o/r" }],
};

// A Hoplite API that accepts GOOD_KEY only, and records what it was sent.
const makeHarness = () => {
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
    assert.equal(url.origin, HopliteCloud.HOPLITE_API_BASE_URL);
    const body =
      request.body._tag === "Uint8Array"
        ? JSON.parse(new TextDecoder().decode(request.body.body))
        : null;
    sent.push({ method: request.method, path: url.pathname, headers: request.headers, body });
    const respond = (status: number, json: unknown) =>
      Effect.succeed(HttpClientResponse.fromWeb(request, Response.json(json, { status })));
    if (request.headers.authorization !== `Bearer ${GOOD_KEY}`) {
      return respond(401, { ok: false, error: "unauthorized" });
    }
    if (url.pathname === "/api/source-control/github/repositories") {
      return respond(200, {
        ok: true,
        repositories: [
          { id: "repo_9", fullName: "Acme/Shop", defaultBranch: "main", private: true },
        ],
      });
    }
    if (request.method === "POST" && url.pathname === "/api/projects") {
      return respond(201, {
        ok: true,
        project: { id: "prj_new", name: "Shop", previewPort: 3000 },
      });
    }
    if (url.pathname === "/api/projects") {
      return Option.isNone(UrlParams.getFirst(request.urlParams, "cursor"))
        ? respond(200, {
            ok: true,
            projects: [{ id: "prj_1", name: "Web", previewPort: 3000 }],
            nextCursor: "c2",
          })
        : respond(200, {
            ok: true,
            projects: [
              {
                id: "prj_2",
                name: "API",
                previewPort: 3000,
                repos: [{ repoFullName: "acme/api", branch: "main" }],
              },
            ],
            nextCursor: null,
          });
    }
    if (request.method === "POST" && url.pathname === "/api/threads") {
      return respond(201, {
        ok: true,
        thread: { ...thread, status: "queued", pullRequests: [] },
        run: { id: "run_1", status: "queued" },
      });
    }
    if (request.method === "POST" && url.pathname === "/api/threads/thr_1/messages") {
      return respond(201, { ok: true, message: { id: "msg_2" }, run: { id: "run_2" } });
    }
    if (request.method === "POST" && url.pathname === "/api/threads/thr_1/stop") {
      return respond(202, { ok: true, result: { threadId: "thr_1", status: "cancelled" } });
    }
    if (url.pathname === "/api/threads/thr_1/preview") {
      return respond(200, { ok: true, preview: { name: "web", status: "stopped", port: 3000 } });
    }
    if (url.pathname === "/api/threads/thr_1/preview/start") {
      return respond(200, {
        ok: true,
        preview: { name: "web", status: "starting", port: 3000, url: "https://web.preview.test" },
      });
    }
    if (request.method === "PUT" && url.pathname === "/api/projects/prj_1/env-vars/STRIPE_KEY") {
      return respond(200, { ok: true, envVar: { key: "STRIPE_KEY", updatedAt: "2026-01-01" } });
    }
    if (url.pathname === "/api/threads/thr_1/questions") {
      return respond(200, {
        ok: true,
        questions: [
          {
            questionId: "q_1",
            runId: "run_1",
            request: {
              questions: [
                {
                  header: "Auth",
                  multiSelect: false,
                  question: "Keep the old session cookie?",
                  options: [{ label: "Yes", description: "Safer rollout" }, { label: "No" }],
                },
              ],
            },
          },
        ],
      });
    }
    if (request.method === "POST" && url.pathname === "/api/threads/thr_1/questions/q_1") {
      return respond(202, { ok: true, result: { threadId: "thr_1", runId: "run_1" } });
    }
    if (url.pathname === "/api/threads/thr_1/runs/run_1/activity") {
      const tool = (id: string, toolName: string, createdAt: string) => ({
        kind: "tool",
        id,
        threadId: "thr_1",
        toolName,
        status: "completed",
        createdAt,
        inputPreview: "x".repeat(500),
      });
      return Option.isNone(UrlParams.getFirst(request.urlParams, "cursor"))
        ? respond(200, {
            ok: true,
            hasMore: true,
            nextCursor: "a2",
            items: [
              tool("t_1", "Read", "2026-01-01T00:00:01Z"),
              {
                kind: "thinking",
                id: "k_1",
                threadId: "thr_1",
                status: "completed",
                createdAt: "2026-01-01T00:00:02Z",
              },
            ],
          })
        : respond(200, {
            ok: true,
            hasMore: false,
            nextCursor: null,
            items: [tool("t_2", "Edit", "2026-01-01T00:00:03Z")],
          });
    }
    if (url.pathname === "/api/threads/thr_1/diff") {
      return respond(200, {
        ok: true,
        diff: {
          threadId: "thr_1",
          mode: "base",
          files: [
            { path: "src/login.ts", state: "modified", additions: 4, deletions: 1, patch: "@@" },
          ],
        },
      });
    }
    if (url.pathname === "/api/threads/thr_1") return respond(200, { ok: true, thread });
    if (url.pathname === "/api/threads/thr_1/run-state") {
      return respond(200, {
        ok: true,
        run: { runId: "run_1", status: "running", assistantMessage: { content: "Tests pass." } },
      });
    }
    return respond(404, { ok: false, error: "not_found" });
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

it.effect("a rejected key is never saved and its text stays out of the error", () => {
  const harness = makeHarness();
  return Effect.gen(function* () {
    const hoplite = yield* HopliteCloud.HopliteCloud;
    const error = yield* Effect.flip(hoplite.connect(REVOKED_KEY));
    assert.equal(error.code, "invalid_key");
    assert.notInclude(error.message, REVOKED_KEY);
    assert.isFalse(harness.stored.has(HopliteCloud.HOPLITE_API_KEY_SECRET));
    assert.deepStrictEqual(yield* hoplite.status, {
      connected: false,
      projects: [],
      defaultProjectId: null,
      problem: null,
    });
  }).pipe(Effect.provide(harness.layer));
});

it.effect("connecting lists every project page and starts tasks in the default project", () => {
  const harness = makeHarness();
  return Effect.gen(function* () {
    const hoplite = yield* HopliteCloud.HopliteCloud;
    const connected = yield* hoplite.connect(GOOD_KEY);
    assert.deepStrictEqual(
      connected.projects.map((project) => project.id),
      ["prj_1", "prj_2"],
    );
    assert.equal(yield* errorCode(hoplite.startTask({ prompt: "Fix login" })), "project_required");
    assert.equal(
      yield* errorCode(hoplite.setDefaultProject({ projectId: "prj_missing" })),
      "not_found",
    );
    const status = yield* hoplite.setDefaultProject({ projectId: "prj_2" });
    assert.equal(status.defaultProjectId, "prj_2");

    const { task, runId } = yield* hoplite.startTask({
      prompt: "Fix login",
      clientRequestId: "req-1",
    });
    assert.equal(task.status, "queued");
    assert.equal(runId, "run_1");
    const create = harness.sent.find((request) => request.method === "POST");
    assert.deepStrictEqual(create?.body, { projectId: "prj_2", prompt: "Fix login" });
    // Hoplite replays a write with the same key instead of starting a second thread.
    assert.equal(create?.headers["idempotency-key"], "t3code:req-1");
  }).pipe(Effect.provide(harness.layer));
});

it.effect("a task naming a repo uses the project that has it, or creates one", () => {
  const harness = makeHarness();
  return Effect.gen(function* () {
    const hoplite = yield* HopliteCloud.HopliteCloud;
    yield* hoplite.connect(GOOD_KEY);
    const threadBodies = () =>
      harness.sent
        .filter((request) => request.method === "POST" && request.path === "/api/threads")
        .map((request) => request.body);

    yield* hoplite.startTask({ prompt: "Fix login", repo: "https://github.com/Acme/API.git" });
    assert.deepStrictEqual(threadBodies().at(-1), { projectId: "prj_2", prompt: "Fix login" });
    assert.isFalse(harness.sent.some((request) => request.path.startsWith("/api/source-control")));

    yield* hoplite.startTask({ prompt: "Fix cart", repo: "acme/shop" });
    const created = harness.sent.find(
      (request) => request.method === "POST" && request.path === "/api/projects",
    );
    assert.deepStrictEqual(created?.body, { name: "Shop", repositoryId: "repo_9" });
    assert.equal(created?.headers["idempotency-key"], "t3code:project:repo_9");
    assert.deepStrictEqual(threadBodies().at(-1), { projectId: "prj_new", prompt: "Fix cart" });

    assert.equal(
      yield* errorCode(hoplite.startTask({ prompt: "Fix it", repo: "acme/private" })),
      "repo_unavailable",
    );
  }).pipe(Effect.provide(harness.layer));
});

it.effect("a task reads its latest reply and pull request", () => {
  const harness = makeHarness();
  return Effect.gen(function* () {
    const hoplite = yield* HopliteCloud.HopliteCloud;
    assert.equal(yield* errorCode(hoplite.getTask({ threadId: "thr_1" })), "not_connected");
    yield* hoplite.connect(GOOD_KEY);
    assert.deepStrictEqual(yield* hoplite.getTask({ threadId: "thr_1" }), {
      threadId: "thr_1",
      projectId: "prj_1",
      title: "Fix login",
      status: "running",
      latestReply: "Tests pass.",
      pullRequestUrl: "https://github.com/o/r/pull/7",
    });
    assert.equal(yield* errorCode(hoplite.getTask({ threadId: "thr_gone" })), "not_found");
  }).pipe(Effect.provide(harness.layer));
});

it.effect("a saved key that stops working stays connected and says why", () => {
  const harness = makeHarness();
  return Effect.gen(function* () {
    const hoplite = yield* HopliteCloud.HopliteCloud;
    harness.stored.set(HopliteCloud.HOPLITE_API_KEY_SECRET, new TextEncoder().encode(REVOKED_KEY));
    const status = yield* hoplite.status;
    assert.isTrue(status.connected);
    assert.deepStrictEqual(status.projects, []);
    assert.match(status.problem ?? "", /rejected the API key/);
    yield* hoplite.disconnect;
    assert.isFalse(harness.stored.has(HopliteCloud.HOPLITE_API_KEY_SECRET));
  }).pipe(Effect.provide(harness.layer));
});

it.effect("a task takes follow-ups, stops its active run, and reports its preview", () => {
  const harness = makeHarness();
  return Effect.gen(function* () {
    const hoplite = yield* HopliteCloud.HopliteCloud;
    yield* hoplite.connect(GOOD_KEY);
    const sent = yield* hoplite.sendMessage({
      threadId: "thr_1",
      message: "Also fix signup",
      clientRequestId: "req-2",
    });
    assert.deepStrictEqual(sent, { runId: "run_2" });
    const message = harness.sent.find((request) => request.path.endsWith("/messages"));
    assert.deepStrictEqual(message?.body, { content: "Also fix signup" });
    assert.equal(message?.headers["idempotency-key"], "t3code:req-2");

    yield* hoplite.stopTask({ threadId: "thr_1" });
    // Hoplite stops only a named run: the one run-state reported as running.
    const stop = harness.sent.find((request) => request.path.endsWith("/stop"));
    assert.deepStrictEqual(stop?.body, { runId: "run_1" });

    assert.deepStrictEqual(yield* hoplite.preview({ threadId: "thr_1" }), {
      status: "stopped",
      url: null,
      reason: null,
    });
    assert.deepStrictEqual(yield* hoplite.preview({ threadId: "thr_1", start: true }), {
      status: "starting",
      url: "https://web.preview.test",
      reason: null,
    });
  }).pipe(Effect.provide(harness.layer));
});

it.effect(
  "a task reports its questions, recent tools and changed files, and takes an answer",
  () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const hoplite = yield* HopliteCloud.HopliteCloud;
      yield* hoplite.connect(GOOD_KEY);
      const activity = yield* hoplite.activity({ threadId: "thr_1" });
      assert.equal(activity.runStatus, "running");
      assert.deepStrictEqual(activity.questions, [
        {
          questionId: "q_1",
          parts: [
            {
              question: "Keep the old session cookie?",
              options: [
                { label: "Yes", description: "Safer rollout" },
                { label: "No", description: "" },
              ],
            },
          ],
        },
      ]);
      assert.deepStrictEqual(
        activity.recentTools.map(({ tool, input }) => [tool, input?.length]),
        [
          ["Read", 300],
          ["Edit", 300],
        ],
      );
      assert.deepStrictEqual(activity.changedFiles, [
        { path: "src/login.ts", state: "modified", additions: 4, deletions: 1 },
      ]);

      const answered = yield* hoplite.answerQuestion({
        threadId: "thr_1",
        questionId: "q_1",
        answer: "Yes",
        clientRequestId: "req-3",
      });
      assert.deepStrictEqual(answered, { runId: "run_1" });
      const answer = harness.sent.find((request) => request.path.endsWith("/questions/q_1"));
      assert.deepStrictEqual(answer?.body, { answer: "Yes" });
      assert.equal(answer?.headers["idempotency-key"], "t3code:req-3");
    }).pipe(Effect.provide(harness.layer));
  },
);

it.effect("a variable a task needs is stored, encrypted, on that task's project", () => {
  const harness = makeHarness();
  return Effect.gen(function* () {
    const hoplite = yield* HopliteCloud.HopliteCloud;
    yield* hoplite.connect(GOOD_KEY);
    const saved = yield* hoplite.setEnv({ threadId: "thr_1", key: "STRIPE_KEY", value: "sk_test" });
    assert.deepStrictEqual(saved, { projectId: "prj_1" });
    const put = harness.sent.find((request) => request.method === "PUT");
    assert.equal(put?.path, "/api/projects/prj_1/env-vars/STRIPE_KEY");
    assert.deepStrictEqual(put?.body, { value: "sk_test" });
  }).pipe(Effect.provide(harness.layer));
});
