// @effect-diagnostics nodeBuiltinImport:off - The test runs the real turn script in bash.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";

import {
  agentTurnScript,
  chatIsRunning,
  parseChat,
  parseTurn,
  readChatScript,
  readTurnScript,
} from "./CloudSandboxTasks.ts";

const bashEnv = (home: string) => ({
  env: { ...process.env, HOME: home.replaceAll("\\", "/") },
  encoding: "utf8" as const,
});

// Git Bash lacks these Linux tools; lifecycle tests own the runner and use sequential lock calls.
const stubUnixTools = (bin: string) => {
  if (HostProcess.Platform.defaultValue() !== "win32") return;
  NodeFS.writeFileSync(NodePath.join(bin, "flock"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
};

const makeTaskFixture = () => {
  const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-task-"));
  const state = NodePath.join(home, ".t3-task");
  const bin = NodePath.join(home, "bin");
  NodeFS.mkdirSync(state);
  NodeFS.mkdirSync(bin);
  stubUnixTools(bin);
  NodeFS.writeFileSync(NodePath.join(bin, "git"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  NodeFS.writeFileSync(
    NodePath.join(bin, "npx"),
    [
      "#!/bin/bash",
      'echo "$@" >> "$HOME/.t3-task/args.log"',
      'if [ -f "$HOME/.t3-task/block" ]; then',
      '  touch "$HOME/.t3-task/started"',
      '  read -r release < "$HOME/.t3-task/release"',
      "fi",
      'printf \'{"result":"%s"}\\n\' "$T3_TASK_PROMPT"',
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  const runners: Array<{ child: NodeChildProcess.ChildProcess; exit: Promise<number | null> }> = [];
  const bash = (script: string, env: Record<string, string> = {}) =>
    new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      const child = NodeChildProcess.spawn("bash", ["-s"], {
        ...bashEnv(home),
        env: { ...bashEnv(home).env, ...env },
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (data) => {
        stdout += data;
      });
      child.stderr.on("data", (data) => {
        stderr += data;
      });
      child.on("error", reject);
      child.on("close", (status) => resolve({ status, stdout, stderr }));
      child.stdin.end('export PATH="$HOME/bin:$PATH"\n' + script);
    });
  const send = (prompt: string, first: boolean, extra = "") =>
    bash(
      [
        extra,
        // The fixture launches and owns the same runner, rather than detaching it.
        agentTurnScript({ first }).replace(/    setsid nohup[^\n]+/, "    :"),
      ].join("\n"),
      { T3_TASK_PROMPT: prompt },
    );
  const run = (extra = "") => {
    const child = NodeChildProcess.spawn("bash", ["-s"], bashEnv(home));
    const exit = new Promise<number | null>((resolve, reject) => {
      child.on("error", reject);
      child.on("close", resolve);
    });
    child.stdin.end(
      [
        'export PATH="$HOME/bin:$PATH"',
        extra,
        'echo "$$" > "$HOME/.t3-task/runner.pid"',
        'exec bash "$HOME/.t3-task/runner.sh"',
      ].join("\n"),
    );
    runners.push({ child, exit });
    return exit;
  };
  const blocked = async (extra = "") => {
    assert.equal(
      (await bash('mkfifo "$HOME/.t3-task/release"; touch "$HOME/.t3-task/block"')).status,
      0,
    );
    const ready = Promise.withResolvers<void>();
    const watcher = NodeFS.watch(state, (_event, file) => {
      if (file === "started") ready.resolve();
    });
    try {
      const exit = run(extra);
      await Promise.race([
        ready.promise,
        exit.then(() => {
          throw new Error("Runner exited before readiness");
        }),
      ]);
      return { exit };
    } finally {
      watcher.close();
    }
  };
  const release = async () => {
    const writer = NodeChildProcess.spawn("bash", ["-s"], bashEnv(home));
    const exit = new Promise<void>((resolve, reject) => {
      writer.on("error", reject);
      writer.on("close", () => resolve());
    });
    writer.stdin.end('rm -f "$HOME/.t3-task/block"; echo go > "$HOME/.t3-task/release"');
    try {
      await Promise.race([exit, ...runners.map(({ exit }) => exit)]);
    } finally {
      writer.kill();
      await exit;
    }
  };
  return {
    home,
    state,
    bash,
    send,
    run,
    blocked,
    release,
    async [Symbol.asyncDispose]() {
      if (NodeFS.existsSync(NodePath.join(state, "block"))) {
        if (NodeFS.existsSync(NodePath.join(state, "started"))) await release();
        else for (const { child } of runners) child.kill();
      }
      await Promise.all(runners.map(({ exit }) => exit));
      NodeFS.rmSync(home, { recursive: true, force: true });
    },
  };
};

it("runs a follow-up queued behind the turn still running", async () => {
  await using f = makeTaskFixture();
  assert.include((await f.send("first", true, 'export T3_TASK_MODEL="opus"')).stdout, "turn=1");
  const { exit } = await f.blocked();
  const queued = await f.send("second", false);
  assert.equal(queued.status, 0, queued.stderr);
  assert.include(queued.stdout, "queued=2");
  await f.release();
  assert.equal(await exit, 0);
  const args = NodeFS.readFileSync(NodePath.join(f.state, "args.log"), "utf8").split("\n");
  assert.include(args[0], "--model opus");
  assert.include(args[1], " -c --model opus");
  const read = await f.bash(readTurnScript({ queued: 2 }));
  assert.deepStrictEqual(parseTurn({ exitCode: 0, output: read.stdout }, "queued-2"), {
    thread: "ready",
    run: { id: "queued-2", status: "completed" },
    latestReply: "second",
    pullRequestUrl: null,
  });
});

it("runs codex turns, resuming the last session on follow-ups", async () => {
  await using f = makeTaskFixture();
  await f.send("first", true, 'export T3_TASK_AGENT="codex"; export T3_TASK_MODEL="gpt-5-codex"');
  assert.equal(await f.run(), 0);
  await f.send("second", false);
  assert.equal(await f.run(), 0);
  const args = NodeFS.readFileSync(NodePath.join(f.state, "args.log"), "utf8").split("\n");
  assert.include(args[0], 'mcp_servers.t3_questions.command="node"');
  assert.include(
    args[0],
    "exec --json --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check -m gpt-5-codex first",
  );
  assert.include(args[1], "-m gpt-5-codex resume --last second");
});

it("preserves a completed turn when another caller starts the next turn", async () => {
  await using f = makeTaskFixture();
  await f.send("first reply", true);
  assert.equal(await f.run(), 0);
  await f.send("second reply", false);
  assert.equal(await f.run(), 0);
  const latest = await f.bash(readTurnScript());
  assert.include(latest.stdout, "second reply");
  const first = await f.bash(readTurnScript({ turn: 1 }));
  assert.include(first.stdout, "first reply");
  assert.include(first.stdout, "exit=0");
  assert.notInclude(first.stdout, "second reply");
});

it("refuses a follow-up while the runner is signed in under a different login", async () => {
  await using f = makeTaskFixture();
  await f.send("first", true, 'export T3_TASK_KEY_ID="login-a"');
  const { exit } = await f.blocked();
  const refused = await f.send("second", false, 'export T3_TASK_KEY_ID="login-b"');
  assert.equal(refused.status, 3, refused.stderr);
  assert.include(refused.stdout, "---t3-task-login-changed---");
  assert.equal(NodeFS.readFileSync(NodePath.join(f.state, "seq"), "utf8").trim(), "1");
  assert.deepStrictEqual(NodeFS.readdirSync(NodePath.join(f.state, "queue")), []);
  await f.release();
  assert.equal(await exit, 0);
});

it("reads a dead runner's state as failed and starts clean on the next turn", async () => {
  await using f = makeTaskFixture();
  await f.send("first", true);
  await f.bash('echo "$$" > "$HOME/.t3-task/runner.pid"');
  NodeFS.mkdirSync(NodePath.join(f.state, "runs", "1"), { recursive: true });
  NodeFS.writeFileSync(NodePath.join(f.state, "turn"), "1");
  NodeFS.writeFileSync(NodePath.join(f.state, "queue", "000002.prompt"), "stale");
  const latest = await f.bash(readTurnScript());
  assert.equal(parseTurn({ exitCode: 0, output: latest.stdout }).run.status, "failed");
  assert.isFalse(chatIsRunning((await f.bash(readChatScript())).stdout));
  await f.send("next", false);
  assert.equal(await f.run(), 0);
  assert.equal(
    NodeFS.readFileSync(NodePath.join(f.state, "runs", "1", "exit"), "utf8").trim(),
    "137",
  );
  assert.include((await f.bash(readTurnScript())).stdout, "next");
});

it("fails promptly without flock, even when an abandoned fallback lock exists", async () => {
  await using f = makeTaskFixture();
  NodeFS.mkdirSync(NodePath.join(f.state, "lock.d"));
  // A legacy owner must never be consulted or removed when reliable locking is unavailable.
  const result = await f.send(
    "first",
    true,
    [
      'command() { if [ "$*" = "-v flock" ]; then return 1; fi; builtin command "$@"; }',
      'mkdir() { case "$*" in *lock.d*) echo unsafe-lock >&2; exit 77;; esac; command mkdir "$@"; }',
    ].join("\n"),
  );
  assert.equal(result.status, 1);
  assert.include(result.stderr, "flock is required");
  assert.notInclude(result.stderr, "unsafe-lock");
});

it("keeps a queue observation pending when the runner dequeues before the reply is printed", async () => {
  await using f = makeTaskFixture();
  NodeFS.mkdirSync(NodePath.join(f.state, "queue"));
  NodeFS.writeFileSync(NodePath.join(f.state, "queue", "000001.prompt"), "work");
  const read = await f.bash(
    [
      'echo() { if [ "$1" = "turn=" ]; then mkdir -p "$HOME/.t3-task/runs/1"; printf 000001 > "$HOME/.t3-task/runs/1/item"; mv "$HOME/.t3-task/queue/000001.prompt" "$HOME/.t3-task/runs/1/prompt"; fi; builtin echo "$@"; }',
      readTurnScript({ queued: 1 }),
    ].join("\n"),
  );
  assert.include(read.stdout, "pending=1");
  assert.notInclude(read.stdout, "dropped=1");
  const assigned = await f.bash(readTurnScript({ queued: 1 }));
  assert.include(assigned.stdout, "turn=1");
  NodeFS.rmSync(NodePath.join(f.state, "runs", "1"), { recursive: true });
  assert.include((await f.bash(readTurnScript({ queued: 1 }))).stdout, "dropped=1");
});

const assistantEvent = (text: string) =>
  JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "text", text }] },
  });

it("parses a turn's reply from stream-json, old output and a turn still running", () => {
  const finished = [
    "turn=1",
    "exit=0",
    "---",
    assistantEvent("working on it"),
    JSON.stringify({ type: "result", result: "all done" }),
    "",
    "---t3-task-err---",
    "a warning",
  ].join("\n");
  assert.deepStrictEqual(parseTurn({ exitCode: 0, output: finished }), {
    thread: "ready",
    run: { id: "turn-1", status: "completed" },
    latestReply: "all done",
    pullRequestUrl: null,
  });
  for (const question of ["Which colour?", "Which colour?\n- Blue\n- Green"]) {
    assert.equal(
      parseTurn({
        exitCode: 0,
        output: finished.replace("all done", JSON.stringify(question).slice(1, -1)),
      }).run.status,
      "waiting",
    );
  }
  const cleanupExit = finished
    .replace('"result":"all done"', '"result":"all done","subtype":"success","is_error":false')
    .replace("exit=0", "exit=137");
  assert.equal(parseTurn({ exitCode: 0, output: cleanupExit }).run.status, "completed");
  const legacy = [
    "turn=2",
    "exit=0",
    "---",
    JSON.stringify({ result: "old format" }),
    "",
    "---t3-task-err---",
    "",
  ].join("\n");
  assert.deepStrictEqual(parseTurn({ exitCode: 0, output: legacy }), {
    thread: "ready",
    run: { id: "turn-2", status: "completed" },
    latestReply: "old format",
    pullRequestUrl: null,
  });
  const running = ["turn=3", "exit=", "---", assistantEvent("halfway"), ""].join("\n");
  assert.deepStrictEqual(parseTurn({ exitCode: 0, output: running }), {
    thread: "running",
    run: { id: "turn-3", status: "running" },
    latestReply: "halfway",
    pullRequestUrl: null,
  });
  const codexDone = [
    "turn=4",
    "exit=0",
    "---",
    JSON.stringify({ type: "thread.started", thread_id: "thr_1" }),
    JSON.stringify({
      type: "item.completed",
      item: { id: "m1", type: "agent_message", text: "first draft" },
    }),
    JSON.stringify({
      type: "item.completed",
      item: { id: "m2", type: "agent_message", text: "codex settled" },
    }),
    JSON.stringify({ type: "turn.completed", usage: {} }),
    "",
    "---t3-task-err---",
    "",
  ].join("\n");
  assert.deepStrictEqual(parseTurn({ exitCode: 0, output: codexDone }), {
    thread: "ready",
    run: { id: "turn-4", status: "completed" },
    latestReply: "codex settled",
    pullRequestUrl: null,
  });
  const codexRunning = [
    "turn=5",
    "exit=",
    "---",
    JSON.stringify({
      type: "item.completed",
      item: { id: "m1", type: "agent_message", text: "codex midway" },
    }),
    "",
  ].join("\n");
  assert.deepStrictEqual(parseTurn({ exitCode: 0, output: codexRunning }), {
    thread: "running",
    run: { id: "turn-5", status: "running" },
    latestReply: "codex midway",
    pullRequestUrl: null,
  });
  const codexFailed = [
    "turn=6",
    "exit=1",
    "---",
    JSON.stringify({ type: "turn.failed", error: { message: "stream disconnected" } }),
    "",
    "---t3-task-err---",
    "",
  ].join("\n");
  assert.deepStrictEqual(parseTurn({ exitCode: 0, output: codexFailed }), {
    thread: "failed",
    run: { id: "turn-6", status: "failed" },
    latestReply: "stream disconnected",
    pullRequestUrl: null,
  });
  // A queued-N read reports pending while it waits, dropped once it can never run.
  const waiting = ["turn=", "live=1", "exit=", "pending=1", "---", ""].join("\n");
  assert.deepStrictEqual(parseTurn({ exitCode: 0, output: waiting }, "queued-2"), {
    thread: "queued",
    run: { id: "queued-2", status: "queued" },
    latestReply: null,
    pullRequestUrl: null,
  });
  const dropped = ["turn=", "live=0", "exit=", "dropped=1", "---", ""].join("\n");
  assert.deepStrictEqual(parseTurn({ exitCode: 0, output: dropped }, "queued-2"), {
    thread: "blocked",
    run: { id: "queued-2", status: "cancelled" },
    latestReply: "This message was cleared before it ran.",
    pullRequestUrl: null,
  });
  const staleQueue = ["turn=", "live=0", "exit=", "pending=1", "---", ""].join("\n");
  assert.deepStrictEqual(parseTurn({ exitCode: 0, output: staleQueue }, "queued-2"), {
    thread: "failed",
    run: { id: "queued-2", status: "failed" },
    latestReply: "The sandbox stopped before this message ran. Send it again.",
    pullRequestUrl: null,
  });
  const diedMidTurn = ["turn=7", "live=0", "exit=", "---", ""].join("\n");
  assert.deepStrictEqual(parseTurn({ exitCode: 0, output: diedMidTurn }), {
    thread: "failed",
    run: { id: "turn-7", status: "failed" },
    latestReply: "The sandbox stopped before this turn finished.",
    pullRequestUrl: null,
  });
});

const toolUse = (id: string, name: string, input: Record<string, string>) =>
  JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "tool_use", id, name, input }] },
  });
const toolResult = (id: string, isError: boolean) =>
  JSON.stringify({
    type: "user",
    message: { content: [{ type: "tool_result", tool_use_id: id, is_error: isError }] },
  });
const chatTurn = (turn: number, prompt: string, jsonl: ReadonlyArray<string>, exit: string) =>
  [
    `---t3-chat-turn ${turn}---`,
    "---t3-chat-prompt---",
    prompt,
    "---t3-chat-jsonl---",
    ...jsonl,
    "",
    "---t3-chat-result---",
    "",
    "---t3-chat-exit---",
    exit,
    "",
  ].join("\n");

it("parses a chat's prompts, replies and tool states", () => {
  const output = [
    chatTurn(
      1,
      "Fix login",
      [
        assistantEvent("Looking"),
        toolUse("toolu_1", "Bash", { command: "ls -la" }),
        toolResult("toolu_1", false),
        toolUse("toolu_2", "Edit", { file_path: "src/app.ts" }),
        toolResult("toolu_2", true),
        toolUse("toolu_3", "Read", { file_path: "src/gone.ts" }),
      ],
      "1",
    ),
    "---t3-chat-running---",
    "0",
  ].join("\n");
  assert.deepStrictEqual(parseChat(output), [
    { _tag: "message", id: "turn-1-user", role: "user", text: "Fix login" },
    { _tag: "message", id: "turn-1-1", role: "assistant", text: "Looking" },
    { _tag: "tool", id: "toolu_1", title: "Bash: ls -la", status: "completed" },
    { _tag: "tool", id: "toolu_2", title: "Edit: src/app.ts", status: "failed" },
    // toolu_3 never answered before the turn exited, so it counts as failed.
    { _tag: "tool", id: "toolu_3", title: "Read: src/gone.ts", status: "failed" },
  ]);

  const codex = [
    chatTurn(
      2,
      "Codex task",
      [
        JSON.stringify({ type: "thread.started", thread_id: "thr_1" }),
        JSON.stringify({
          type: "item.started",
          item: { id: "c1", type: "command_execution", command: "ls -la\nwc -l x" },
        }),
        JSON.stringify({
          type: "item.completed",
          item: { id: "m1", type: "agent_message", text: "listed" },
        }),
        JSON.stringify({
          type: "item.completed",
          item: {
            id: "c1",
            type: "command_execution",
            command: "ls -la\nwc -l x",
            exit_code: 0,
            status: "completed",
          },
        }),
        JSON.stringify({
          type: "item.completed",
          item: {
            id: "c2",
            type: "command_execution",
            command: "false",
            exit_code: 1,
            status: "completed",
          },
        }),
        JSON.stringify({
          type: "item.completed",
          item: {
            id: "f1",
            type: "file_change",
            changes: [
              { path: "a.ts", kind: "add" },
              { path: "b.ts", kind: "update" },
            ],
            status: "completed",
          },
        }),
        JSON.stringify({
          type: "item.started",
          item: { id: "w1", type: "mcp_tool_call", server: "t3", tool: "search" },
        }),
        JSON.stringify({ type: "turn.completed", usage: {} }),
      ],
      "0",
    ),
    chatTurn(
      3,
      "Fails",
      [
        // A failing Codex turn prints the same message as an error line and turn.failed.
        JSON.stringify({ type: "error", message: "ran out of turns" }),
        JSON.stringify({ type: "turn.failed", error: { message: "ran out of turns" } }),
      ],
      "1",
    ),
    "---t3-chat-running---",
    "0",
  ].join("\n");
  const repeated = parseChat(
    [
      codex.split("---t3-chat-running---")[0],
      chatTurn(
        4,
        "Again",
        [
          JSON.stringify({
            type: "item.completed",
            item: { id: "c1", type: "command_execution", command: "pwd", exit_code: 0 },
          }),
        ],
        "0",
      ),
    ].join("\n"),
  );
  assert.equal(new Set(repeated.map((entry) => entry.id)).size, repeated.length);
  assert.deepStrictEqual(parseChat(codex), [
    { _tag: "message", id: "turn-2-user", role: "user", text: "Codex task" },
    // A started command reports in_progress until its completed event arrives.
    { _tag: "tool", id: "turn-2-c1", title: "Bash: ls -la", status: "completed" },
    { _tag: "message", id: "turn-2-1", role: "assistant", text: "listed" },
    // A completed command with a non-zero exit counts as failed.
    { _tag: "tool", id: "turn-2-c2", title: "Bash: false", status: "failed" },
    { _tag: "tool", id: "turn-2-f1", title: "Edit: a.ts (+1 more)", status: "completed" },
    // w1 never completed before the turn exited, so it counts as failed.
    { _tag: "tool", id: "turn-2-w1", title: "t3.search", status: "failed" },
    { _tag: "message", id: "turn-3-user", role: "user", text: "Fails" },
    { _tag: "message", id: "turn-3-1", role: "assistant", text: "ran out of turns" },
  ]);
});

it("reads an old turn's result as its reply", () => {
  const output = [
    "---t3-chat-turn 1---",
    "---t3-chat-prompt---",
    "Fix login",
    "---t3-chat-jsonl---",
    "",
    "---t3-chat-result---",
    JSON.stringify({ result: "done the old way" }),
    "",
    "---t3-chat-exit---",
    "0",
    "",
    "---t3-chat-running---",
    "0",
  ].join("\n");
  assert.deepStrictEqual(parseChat(output), [
    { _tag: "message", id: "turn-1-user", role: "user", text: "Fix login" },
    { _tag: "message", id: "turn-1-1", role: "assistant", text: "done the old way" },
  ]);
});
