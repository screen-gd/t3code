// @effect-diagnostics nodeBuiltinImport:off - The test runs the real turn script in bash.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";

import { agentTurnScript, parseChat, parseTurn, readTurnScript } from "./CloudSandboxTasks.ts";

const bashEnv = (home: string) => ({
  env: { ...process.env, HOME: home.replaceAll("\\", "/") },
  encoding: "utf8" as const,
});

// Git Bash lacks the Linux-only tools the sandbox has; stubs keep the scripts runnable.
const stubUnixTools = (bin: string) => {
  if (HostProcess.Platform.defaultValue() !== "win32") return;
  NodeFS.writeFileSync(NodePath.join(bin, "setsid"), '#!/bin/sh\nexec "$@"\n', { mode: 0o755 });
  NodeFS.writeFileSync(NodePath.join(bin, "flock"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
};

it("runs a follow-up queued behind the turn still running", () => {
  const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-task-"));
  try {
    const bin = NodePath.join(home, "bin");
    NodeFS.mkdirSync(bin);
    stubUnixTools(bin);
    NodeFS.writeFileSync(NodePath.join(bin, "git"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    // The stub agent blocks on a fifo until the test lets the first turn finish.
    NodeFS.writeFileSync(
      NodePath.join(bin, "npx"),
      [
        "#!/bin/sh",
        'if [ -f "$HOME/.t3-task/block" ]; then',
        '  echo started > "$HOME/.t3-task/started"',
        '  cat "$HOME/.t3-task/release" > /dev/null',
        "fi",
        'printf \'{"result":"%s"}\\n\' "$T3_TASK_PROMPT"',
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
    const state = NodePath.join(home, ".t3-task");
    NodeFS.mkdirSync(state, { recursive: true });
    const run = NodeChildProcess.spawnSync(
      "bash",
      [
        "-c",
        [
          'export PATH="$HOME/bin:$PATH"',
          'mkfifo "$HOME/.t3-task/started" "$HOME/.t3-task/release"',
          'touch "$HOME/.t3-task/block"',
          'export T3_TASK_PROMPT="first"',
          agentTurnScript({ first: true }),
          // The agent has started and is blocked, so the runner is provably alive.
          'cat "$HOME/.t3-task/started" > /dev/null',
          'export T3_TASK_PROMPT="second"',
          agentTurnScript({ first: false }),
          'rm "$HOME/.t3-task/block"',
          'echo > "$HOME/.t3-task/release"',
          // The runner is detached, so its death is the signal both turns ran.
          'pid=$(cat "$HOME/.t3-task/runner.pid")',
          'while kill -0 "$pid" 2>/dev/null; do :; done',
          'rm -f "$HOME/.t3-task/started" "$HOME/.t3-task/release"',
        ].join("\n"),
      ],
      bashEnv(home),
    );
    assert.equal(run.status, 0, run.stderr);
    assert.include(run.stdout, "turn=1");
    assert.include(run.stdout, "queued");
    assert.equal(NodeFS.readFileSync(NodePath.join(state, "turn"), "utf8").trim(), "2");
    assert.include(
      NodeFS.readFileSync(NodePath.join(state, "runs", "2", "out.jsonl"), "utf8"),
      '{"result":"second"}',
    );
  } finally {
    NodeFS.rmSync(home, { recursive: true, force: true });
  }
});

it("preserves a completed turn when another caller starts the next turn", () => {
  const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-task-"));
  try {
    const bin = NodePath.join(home, "bin");
    NodeFS.mkdirSync(bin);
    stubUnixTools(bin);
    NodeFS.writeFileSync(NodePath.join(bin, "git"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    NodeFS.writeFileSync(
      NodePath.join(bin, "npx"),
      '#!/bin/sh\nprintf \'{"result":"%s"}\\n\' "$T3_TASK_PROMPT"\n',
      { mode: 0o755 },
    );
    const run = NodeChildProcess.spawnSync(
      "bash",
      [
        "-c",
        [
          'export PATH="$HOME/bin:$PATH"',
          'export T3_TASK_PROMPT="first reply"',
          agentTurnScript({ first: true }),
          // The runner is detached, so its death is the signal the turn finished.
          'pid=$(cat "$HOME/.t3-task/runner.pid"); while kill -0 "$pid" 2>/dev/null; do :; done',
          'export T3_TASK_PROMPT="second reply"',
          agentTurnScript({ first: false }),
          'pid=$(cat "$HOME/.t3-task/runner.pid"); while kill -0 "$pid" 2>/dev/null; do :; done',
        ].join("\n"),
      ],
      bashEnv(home),
    );
    assert.equal(run.status, 0, run.stderr);
    assert.equal(
      NodeFS.readFileSync(NodePath.join(home, ".t3-task", "runs", "1", "out.jsonl"), "utf8").trim(),
      '{"result":"first reply"}',
    );
    const latest = NodeChildProcess.spawnSync("bash", ["-c", readTurnScript()], bashEnv(home));
    assert.include(latest.stdout, "second reply");
    const first = NodeChildProcess.spawnSync("bash", ["-c", readTurnScript(1)], bashEnv(home));
    assert.include(first.stdout, "first reply");
    assert.include(first.stdout, "exit=0");
    assert.notInclude(first.stdout, "second reply");
  } finally {
    NodeFS.rmSync(home, { recursive: true, force: true });
  }
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
