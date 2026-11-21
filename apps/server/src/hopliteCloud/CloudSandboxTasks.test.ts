// @effect-diagnostics nodeBuiltinImport:off - The test runs the real turn script in bash.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";

import { agentTurnScript, BUSY_EXIT, readTurnScript } from "./CloudSandboxTasks.ts";

it("refuses a turn while the last turn's agent still runs", () => {
  const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-task-"));
  try {
    const state = NodePath.join(home, ".t3-task");
    NodeFS.mkdirSync(state);
    NodeFS.writeFileSync(NodePath.join(state, "turn"), "1");
    // A stub npx, so a regressed guard starts nothing real.
    const bin = NodePath.join(home, "bin");
    NodeFS.mkdirSync(bin);
    NodeFS.writeFileSync(NodePath.join(bin, "npx"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    const run = NodeChildProcess.spawnSync(
      "bash",
      // Bash writes its own live pid because Windows uses a different pid namespace.
      [
        "-c",
        `export PATH="$HOME/bin:$PATH"\necho $$ > "$HOME/.t3-task/pid"\n${agentTurnScript({ first: false })}`,
      ],
      {
        env: { ...process.env, HOME: home.replaceAll("\\", "/") },
      },
    );
    assert.equal(run.status, BUSY_EXIT);
    assert.equal(NodeFS.readFileSync(NodePath.join(state, "turn"), "utf8"), "1");
  } finally {
    NodeFS.rmSync(home, { recursive: true, force: true });
  }
});

it("preserves a completed turn when another caller starts the next turn", () => {
  const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-task-"));
  try {
    const bin = NodePath.join(home, "bin");
    NodeFS.mkdirSync(bin);
    NodeFS.writeFileSync(NodePath.join(bin, "git"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    // Git Bash lacks setsid; this case tests result files, not process-group isolation.
    if (HostProcess.Platform.defaultValue() === "win32")
      NodeFS.writeFileSync(NodePath.join(bin, "setsid"), '#!/bin/sh\nexec "$@"\n', { mode: 0o755 });
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
          "wait",
          'export T3_TASK_PROMPT="second reply"',
          agentTurnScript({ first: false }),
          "wait",
        ].join("\n"),
      ],
      { env: { ...process.env, HOME: home.replaceAll("\\", "/") }, encoding: "utf8" },
    );
    assert.equal(run.status, 0, run.stderr);
    assert.equal(
      NodeFS.readFileSync(NodePath.join(home, ".t3-task", "runs", "1", "out.json"), "utf8").trim(),
      '{"result":"first reply"}',
    );
    const latest = NodeChildProcess.spawnSync("bash", ["-c", readTurnScript()], {
      env: { ...process.env, HOME: home.replaceAll("\\", "/") },
      encoding: "utf8",
    });
    assert.include(latest.stdout, "second reply");
    const first = NodeChildProcess.spawnSync("bash", ["-c", readTurnScript(1)], {
      env: { ...process.env, HOME: home.replaceAll("\\", "/") },
      encoding: "utf8",
    });
    assert.include(first.stdout, "first reply");
    assert.include(first.stdout, "exit=0");
    assert.notInclude(first.stdout, "second reply");
  } finally {
    NodeFS.rmSync(home, { recursive: true, force: true });
  }
});
