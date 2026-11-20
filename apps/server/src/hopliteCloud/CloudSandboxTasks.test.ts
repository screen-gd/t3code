// @effect-diagnostics nodeBuiltinImport:off - The test runs the real turn script in bash.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, it } from "@effect/vitest";

import { agentTurnScript, BUSY_EXIT } from "./CloudSandboxTasks.ts";

it("refuses a turn while the last turn's agent still runs", () => {
  const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-task-"));
  try {
    const state = NodePath.join(home, ".t3-task");
    NodeFS.mkdirSync(state);
    // This test's own process stands in for the running agent.
    NodeFS.writeFileSync(NodePath.join(state, "pid"), String(process.pid));
    NodeFS.writeFileSync(NodePath.join(state, "turn"), "1");
    const run = NodeChildProcess.spawnSync("bash", ["-c", agentTurnScript({ first: false })], {
      env: { PATH: process.env.PATH, HOME: home },
    });
    assert.equal(run.status, BUSY_EXIT);
    assert.equal(NodeFS.readFileSync(NodePath.join(state, "turn"), "utf8"), "1");
  } finally {
    NodeFS.rmSync(home, { recursive: true, force: true });
  }
});
