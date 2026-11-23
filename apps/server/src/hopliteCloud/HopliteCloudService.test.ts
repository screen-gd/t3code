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
  /** Paths that answer with this status instead, as a flaky or rate-limited Hoplite would. */
  const failing = new Map<string, number>();
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
    const failStatus = failing.get(url.pathname);
    if (failStatus !== undefined) return respond(failStatus, { ok: false, error: "failed" });
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
    if (url.pathname === "/api/model-providers") {
      return respond(200, {
        ok: true,
        modelConfigurationRevision: "r1",
        providers: [],
        models: [
          { id: "gpt-6-luna", name: "GPT-6 Luna", provider: "openai" },
          { id: "claude-sonnet-5", name: "Claude Sonnet 5", provider: "anthropic" },
        ],
      });
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
    if (
      request.method === "POST" &&
      [
        "/api/threads/thr_1/questions/q_1",
        "/api/threads/thr_1/questions/appr_toolu_exampleABC",
      ].includes(url.pathname)
    ) {
      return respond(202, { ok: true, result: { threadId: "thr_1", runId: "run_1" } });
    }
    if (url.pathname === "/api/threads/thr_1") return respond(200, { ok: true, thread });
    if (url.pathname === "/api/threads/thr_1/active-run") {
      return respond(200, { ok: true, activeRun: { runId: "run_1", status: "running" } });
    }
    // Like Hoplite, run-state without a runId is the latest finished run, not the active one.
    if (url.pathname === "/api/threads/thr_1/run-state") {
      return Option.isNone(UrlParams.getFirst(request.urlParams, "runId"))
        ? respond(200, { ok: true, run: { runId: "run_0", status: "completed" } })
        : respond(200, {
            ok: true,
            run: {
              runId: "run_1",
              status: "running",
              assistantMessage: { content: "Tests pass." },
            },
          });
    }
    return respond(404, { ok: false, error: "not_found" });
  });
  const layer = HopliteCloud.layer.pipe(
    Layer.provide(Layer.succeed(ServerSecretStore.ServerSecretStore, secrets)),
    Layer.provide(Layer.succeed(HttpClient.HttpClient, httpClient)),
    Layer.provide(NodeCrypto.layer),
  );
  return { stored, sent, failing, layer };
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
    const error = yield* Effect.flip(hoplite.connect("hoplite", REVOKED_KEY));
    assert.equal(error.code, "invalid_key");
    assert.notInclude(error.message, REVOKED_KEY);
    assert.isFalse(harness.stored.has(HopliteCloud.HOPLITE_API_KEY_SECRET));
    assert.deepInclude(yield* hoplite.status, { connected: false, problem: null });
  }).pipe(Effect.provide(harness.layer));
});

it.effect("rejects an agent choice it cannot honor", () => {
  const harness = makeHarness();
  return Effect.gen(function* () {
    const hoplite = yield* HopliteCloud.HopliteCloud;
    yield* hoplite.connect("hoplite", GOOD_KEY);
    const error = yield* Effect.flip(
      hoplite.startTask({ prompt: "Fix", repo: "acme/api", agent: "codex" }),
    );
    assert.equal(error.code, "unsupported");
    assert.include(error.message, "own agent");
  }).pipe(Effect.provide(harness.layer));
});

it.effect("connecting checks the key, and a task starts in the repo's project", () => {
  const harness = makeHarness();
  return Effect.gen(function* () {
    const hoplite = yield* HopliteCloud.HopliteCloud;
    const connected = yield* hoplite.connect("hoplite", GOOD_KEY);
    assert.deepInclude(connected, { connected: true, problem: null });
    // Checking the key, before saving it and again for the status, reads one page each.
    assert.equal(harness.sent.filter((request) => request.path === "/api/projects").length, 2);

    assert.equal(yield* errorCode(hoplite.startTask({ prompt: "Fix login" })), "project_required");

    const { task, runId } = yield* hoplite.startTask({
      prompt: "Fix login",
      repo: "acme/api",
      clientRequestId: "req-1",
    });
    assert.equal(task.status, "queued");
    assert.equal(runId, "run_1");
    const create = harness.sent.find(
      (request) => request.method === "POST" && request.path === "/api/threads",
    );
    assert.deepStrictEqual(create?.body, { projectId: "prj_2", prompt: "Fix login" });
    // Hoplite replays a write with the same key instead of starting a second thread.
    assert.equal(create?.headers["idempotency-key"], "t3code:req-1");
  }).pipe(Effect.provide(harness.layer));
});

it.effect("a task naming a repo uses the project that has it, or creates one", () => {
  const harness = makeHarness();
  return Effect.gen(function* () {
    const hoplite = yield* HopliteCloud.HopliteCloud;
    yield* hoplite.connect("hoplite", GOOD_KEY);
    const threadBodies = () =>
      harness.sent
        .filter((request) => request.method === "POST" && request.path === "/api/threads")
        .map((request) => request.body);

    const projectListings = () =>
      harness.sent.filter((request) => request.method === "GET" && request.path === "/api/projects")
        .length;

    yield* hoplite.startTask({ prompt: "Fix login", repo: "https://github.com/Acme/API.git" });
    assert.deepStrictEqual(threadBodies().at(-1), { projectId: "prj_2", prompt: "Fix login" });
    assert.isFalse(harness.sent.some((request) => request.path.startsWith("/api/source-control")));

    // The repo's project is remembered, so the next task skips the listing.
    const listed = projectListings();
    yield* hoplite.startTask({ prompt: "Fix signup", repo: "acme/api" });
    assert.deepStrictEqual(threadBodies().at(-1), { projectId: "prj_2", prompt: "Fix signup" });
    assert.equal(projectListings(), listed);

    // A remembered project Hoplite no longer has is looked up once more.
    harness.failing.set("/api/threads", 404);
    const threadsBefore = threadBodies().length;
    assert.equal(
      yield* errorCode(hoplite.startTask({ prompt: "Fix it", repo: "acme/api" })),
      "not_found",
    );
    assert.equal(threadBodies().length, threadsBefore + 2);
    assert.equal(projectListings(), listed + 2);
    harness.failing.clear();

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

it.effect("a task reads its active run, latest reply and pull request", () => {
  const harness = makeHarness();
  return Effect.gen(function* () {
    const hoplite = yield* HopliteCloud.HopliteCloud;
    assert.equal(yield* errorCode(hoplite.getTask({ threadId: "thr_1" })), "not_connected");
    yield* hoplite.connect("hoplite", GOOD_KEY);
    // Not run_0, the finished run Hoplite reports when asked without a run id.
    assert.deepStrictEqual((yield* hoplite.readTask({ threadId: "thr_1" })).run, {
      id: "run_1",
      status: "running",
    });
    assert.deepStrictEqual(yield* hoplite.getTask({ threadId: "thr_1" }), {
      threadId: "thr_1",
      projectId: "prj_1",
      title: "Fix login",
      status: "running",
      latestReply: "Tests pass.",
      pullRequestUrl: "https://github.com/o/r/pull/7",
    });
    assert.equal(yield* errorCode(hoplite.getTask({ threadId: "thr_gone" })), "not_found");

    // A failed read fails the task read rather than reporting the latest finished run.
    for (const path of ["/api/threads/thr_1/active-run", "/api/threads/thr_1/run-state"]) {
      harness.failing.set(path, 503);
      assert.equal(yield* errorCode(hoplite.readTask({ threadId: "thr_1" })), "unavailable", path);
      harness.failing.clear();
    }
  }).pipe(Effect.provide(harness.layer));
});

it.effect("a saved key that stops working stays connected and says why", () => {
  const harness = makeHarness();
  return Effect.gen(function* () {
    const hoplite = yield* HopliteCloud.HopliteCloud;
    harness.stored.set(HopliteCloud.HOPLITE_API_KEY_SECRET, new TextEncoder().encode(REVOKED_KEY));
    const status = yield* hoplite.status;
    assert.isTrue(status.connected);
    assert.match(status.problem ?? "", /rejected the API key/);
    yield* hoplite.disconnect("hoplite");
    assert.isFalse(harness.stored.has(HopliteCloud.HOPLITE_API_KEY_SECRET));
  }).pipe(Effect.provide(harness.layer));
});

it.effect("a task takes follow-ups, stops its active run, and reports its preview", () => {
  const harness = makeHarness();
  return Effect.gen(function* () {
    const hoplite = yield* HopliteCloud.HopliteCloud;
    yield* hoplite.connect("hoplite", GOOD_KEY);
    const sent = yield* hoplite.sendMessage({
      threadId: "thr_1",
      message: "Also fix signup",
      clientRequestId: "req-2",
    });
    assert.deepStrictEqual(sent, { runId: "run_2" });
    const message = harness.sent.find((request) => request.path.endsWith("/messages"));
    assert.deepStrictEqual(message?.body, { content: "Also fix signup" });
    assert.equal(message?.headers["idempotency-key"], "t3code:req-2");

    // Without the active run there is no knowing which run to stop.
    harness.failing.set("/api/threads/thr_1/active-run", 503);
    assert.equal(yield* errorCode(hoplite.stopTask({ threadId: "thr_1" })), "unavailable");
    assert.isFalse(harness.sent.some((request) => request.path.endsWith("/stop")));
    harness.failing.clear();

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

it.effect("a task reports its questions and takes an answer", () => {
  const harness = makeHarness();
  return Effect.gen(function* () {
    const hoplite = yield* HopliteCloud.HopliteCloud;
    yield* hoplite.connect("hoplite", GOOD_KEY);
    const questions = yield* hoplite.listQuestions({ threadId: "thr_1" });
    assert.deepStrictEqual(questions, [
      {
        questionId: "q_1",
        runId: "run_1",
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
    yield* hoplite.answerQuestion({
      threadId: "thr_1",
      questionId: "q_1",
      answer: "Dismiss",
      dismiss: true,
    });
    const dismissed = harness.sent
      .filter((request) => request.path.endsWith("/questions/q_1"))
      .at(-1);
    assert.deepStrictEqual(dismissed?.body, { answers: null });
    assert.equal(dismissed?.headers["idempotency-key"], "t3code:answer:q_1");
    assert.deepStrictEqual(
      yield* hoplite.answerQuestion({
        threadId: "thr_1",
        questionId: "appr_toolu_exampleABC",
        answer: "Yes",
      }),
      { runId: "run_1" },
    );
  }).pipe(Effect.provide(harness.layer));
});

it.effect("a model named the way a person says it runs as Hoplite's id for it", () => {
  const harness = makeHarness();
  return Effect.gen(function* () {
    const hoplite = yield* HopliteCloud.HopliteCloud;
    yield* hoplite.connect("hoplite", GOOD_KEY);
    yield* hoplite.startTask({ prompt: "Fix login", repo: "acme/api", model: "GPT 6 Luna" });
    const create = harness.sent.find(
      (request) => request.method === "POST" && request.path === "/api/threads",
    );
    assert.deepStrictEqual(create?.body, {
      projectId: "prj_2",
      prompt: "Fix login",
      model: "gpt-6-luna",
    });

    yield* hoplite.sendMessage({ threadId: "thr_1", message: "Again", model: "claude-sonnet-5" });
    const message = harness.sent.find((request) => request.path.endsWith("/messages"));
    assert.deepStrictEqual(message?.body, { content: "Again", model: "claude-sonnet-5" });

    const unknown = yield* Effect.flip(
      hoplite.startTask({ prompt: "Fix", repo: "acme/api", model: "gpt-9" }),
    );
    assert.equal(unknown.code, "model_unavailable");
    assert.include(unknown.message, "gpt-6-luna, claude-sonnet-5");
  }).pipe(Effect.provide(harness.layer));
});

it.effect("refuses task and question ids outside Hoplite's format before sending the key", () => {
  const harness = makeHarness();
  return Effect.gen(function* () {
    const hoplite = yield* HopliteCloud.HopliteCloud;
    yield* hoplite.connect("hoplite", GOOD_KEY);
    const before = harness.sent.length;
    for (const threadId of ["..", "thr_1/../../projects", "../api/projects"]) {
      assert.equal(yield* errorCode(hoplite.readTask({ threadId })), "not_found", threadId);
      assert.equal(
        yield* errorCode(hoplite.sendMessage({ threadId, message: "hi" })),
        "not_found",
        threadId,
      );
      assert.equal(yield* errorCode(hoplite.stopTask({ threadId })), "not_found", threadId);
      assert.equal(yield* errorCode(hoplite.preview({ threadId })), "not_found", threadId);
    }
    assert.equal(
      yield* errorCode(
        hoplite.answerQuestion({ threadId: "thr_1", questionId: "../../stop", answer: "yes" }),
      ),
      "not_found",
    );
    assert.equal(harness.sent.length, before);
  }).pipe(Effect.provide(harness.layer));
});
