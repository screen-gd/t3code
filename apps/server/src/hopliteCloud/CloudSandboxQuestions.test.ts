// @effect-diagnostics nodeBuiltinImport:off -- Exercises the sandbox's actual Node MCP process.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeReadline from "node:readline";
import { assert, it } from "@effect/vitest";
import { HopliteCloudQuestion } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { answerQuestionScript, questionServerSource } from "./CloudSandboxQuestions.ts";

const decodeResponse = Schema.decodeSync(
  Schema.fromJsonString(Schema.Struct({ id: Schema.Number, result: Schema.Unknown })),
);
const decodeQuestion = Schema.decodeSync(Schema.fromJsonString(HopliteCloudQuestion));

it("keeps structured questions across MCP disconnects and delivers an explicit answer once", async () => {
  const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-questions-"));
  const state = NodePath.join(home, ".t3-task");
  NodeFS.mkdirSync(state);
  NodeFS.writeFileSync(NodePath.join(state, "turn"), "1");
  const children: NodeChildProcess.ChildProcess[] = [];
  const start = () => {
    const child = NodeChildProcess.spawn(process.execPath, ["-e", questionServerSource], {
      env: { ...process.env, HOME: home },
    });
    children.push(child);
    const responses = new Map<number, (value: unknown) => void>();
    const seen: number[] = [];
    NodeReadline.createInterface({ input: child.stdout }).on("line", (line) => {
      const response = decodeResponse(line);
      seen.push(response.id);
      responses.get(response.id)?.(response.result);
    });
    const call = (id: number, method: string, params = {}) => {
      const response = new Promise<unknown>((resolve) => responses.set(id, resolve));
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      return response;
    };
    return { child, call, seen };
  };
  try {
    const params = {
      name: "request_user_input",
      arguments: {
        questions: [{ question: "Keep the cookie?", options: [{ label: "Yes" }, { label: "No" }] }],
      },
    };
    const first = start();
    void first.call(1, "tools/call", params);
    await first.call(2, "tools/list");
    assert.deepStrictEqual(first.seen, [2]);
    const dir = NodePath.join(state, "questions");
    const [name] = NodeFS.readdirSync(dir);
    if (name === undefined) throw new Error("Question was not persisted");
    const pending = decodeQuestion(NodeFS.readFileSync(NodePath.join(dir, name), "utf8"));
    assert.equal(pending.parts[0]?.options[0]?.label, "Yes");
    first.child.kill();

    const second = start();
    const answer = second.call(3, "tools/call", params);
    await second.call(4, "tools/list");
    assert.deepStrictEqual(second.seen, [4]);
    assert.equal(NodeFS.readdirSync(dir).length, 1);
    const answerSource = answerQuestionScript().slice("node -e '".length, -1);
    const answerEnv = {
      ...process.env,
      HOME: home,
      T3_QUESTION_ID: pending.questionId,
      T3_QUESTION_ANSWER: "Yes",
    };
    NodeChildProcess.execFileSync(process.execPath, ["-e", answerSource], { env: answerEnv });
    NodeChildProcess.execFileSync(process.execPath, ["-e", answerSource], { env: answerEnv });
    const conflict = NodeChildProcess.spawnSync(process.execPath, ["-e", answerSource], {
      env: { ...answerEnv, T3_QUESTION_ANSWER: "No" },
    });
    assert.equal(conflict.status, 3);
    assert.deepStrictEqual(await answer, {
      content: [
        { type: "text", text: JSON.stringify({ questionId: pending.questionId, answer: "Yes" }) },
      ],
    });
    await second.call(5, "tools/list");
    assert.deepStrictEqual(second.seen, [4, 3, 5]);
    NodeFS.writeFileSync(NodePath.join(state, "turn"), "2");
    const dismissed = second.call(6, "tools/call", params);
    await second.call(7, "tools/list");
    const nextFile = NodeFS.readdirSync(dir).find(
      (file) => file.endsWith(".json") && file !== name,
    );
    if (nextFile === undefined) throw new Error("Second question was not persisted");
    const next = decodeQuestion(NodeFS.readFileSync(NodePath.join(dir, nextFile), "utf8"));
    NodeChildProcess.execFileSync(process.execPath, ["-e", answerSource], {
      env: { ...answerEnv, T3_QUESTION_ID: next.questionId, T3_QUESTION_DISMISS: "true" },
    });
    assert.deepStrictEqual(await dismissed, {
      content: [
        { type: "text", text: JSON.stringify({ questionId: next.questionId, dismissed: true }) },
      ],
    });
  } finally {
    for (const child of children) child.kill();
    NodeFS.rmSync(home, { recursive: true, force: true });
  }
});
