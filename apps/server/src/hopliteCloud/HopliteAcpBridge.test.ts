import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { prepareHopliteFrame } from "./HopliteAcpBridge.ts";

it.effect("keeps local MCP credentials out of cloud session setup", () =>
  Effect.gen(function* () {
    for (const method of ["session/new", "session/load", "session/resume"]) {
      const line = JSON.stringify({
        jsonrpc: "2.0",
        id: "request-1",
        method,
        params: {
          cwd: "/workspace",
          sessionId: "thread-1",
          mcpServers: [
            { name: "t3", command: "node", env: [{ name: "TOKEN", value: "local-test-secret" }] },
          ],
        },
      });
      const result = yield* prepareHopliteFrame(line);
      assert.notInclude(result, "local-test-secret");
      assert.deepStrictEqual(JSON.parse(result), {
        jsonrpc: "2.0",
        id: "request-1",
        method,
        params: { cwd: "/workspace", sessionId: "thread-1", mcpServers: [] },
      });
    }
  }),
);

it.effect("passes permission replies and prompt content through unchanged", () =>
  Effect.gen(function* () {
    const frame = {
      jsonrpc: "2.0",
      id: 8,
      result: { outcome: { outcome: "selected", optionId: "reject_once" } },
    };
    assert.deepStrictEqual(JSON.parse(yield* prepareHopliteFrame(JSON.stringify(frame))), frame);
    const prompt = {
      jsonrpc: "2.0",
      id: 9,
      method: "session/prompt",
      params: { sessionId: "thread-1", prompt: [{ type: "text", text: "Fix login" }] },
    };
    assert.deepStrictEqual(JSON.parse(yield* prepareHopliteFrame(JSON.stringify(prompt))), prompt);
  }),
);

it.effect("rejects malformed JSON and messages larger than Hoplite accepts", () =>
  Effect.gen(function* () {
    assert.equal((yield* Effect.flip(prepareHopliteFrame("not-json"))).stage, "protocol");
    assert.equal(
      (yield* Effect.flip(prepareHopliteFrame(JSON.stringify({ value: "x".repeat(1024 * 1024) }))))
        .stage,
      "protocol",
    );
  }),
);
