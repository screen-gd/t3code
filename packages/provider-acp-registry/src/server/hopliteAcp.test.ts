import { describe, expect, it } from "@effect/vitest";
import { acpToolCallDiffPatch, acpToolCallSnippetEdit } from "@t3tools/provider-acp/server/adapter";
import type * as AcpSessionRuntime from "@t3tools/provider-acp/server/AcpSessionRuntime";
import * as Effect from "effect/Effect";

import {
  isHopliteSignInRequired,
  normalizeHopliteToolCall,
  parseHopliteSignInPrompt,
  rollbackHopliteSession,
} from "./hopliteAcp.ts";

const tool = (content: ReadonlyArray<unknown>, meta?: unknown) => ({
  toolCallId: "call_1",
  kind: "edit",
  data: { content, ...(meta === undefined ? {} : { meta }) },
});

describe("parseHopliteSignInPrompt", () => {
  const stderr = [
    "hoplite acp: signing in to Hoplite: opening your browser (the address follows if it does not open)",
    "Opening your browser to sign in to Hoplite…",
    "  If it does not open, visit https://hoplite.sh/device?user_code=YML8ANAY",
    "  and confirm the code YML8ANAY",
    "Keep this terminal open; waiting for browser approval…",
  ].join("\n");

  it("parses the device sign-in prompt the CLI writes to stderr", () => {
    expect(parseHopliteSignInPrompt(stderr)).toEqual({
      url: "https://hoplite.sh/device?user_code=YML8ANAY",
      userCode: "YML8ANAY",
    });
  });

  it("parses a tail that starts mid-line and uses CRLF", () => {
    const tail = `…(the address follows if it does not open)\r\n  If it does not open, visit https://hoplite.sh/device?user_code=YML8ANAY\r\n  and confirm the code YML8ANAY\r\nKeep this terminal open`;
    expect(parseHopliteSignInPrompt(tail)).toEqual({
      url: "https://hoplite.sh/device?user_code=YML8ANAY",
      userCode: "YML8ANAY",
    });
  });

  it("returns the last printed code when the CLI retries", () => {
    const retried = `${stderr}\n  If it does not open, visit https://hoplite.sh/device?user_code=NEWCODE1\n  and confirm the code NEWCODE1\n`;
    expect(parseHopliteSignInPrompt(retried)?.userCode).toBe("NEWCODE1");
  });

  it("rejects non-https addresses and malformed output", () => {
    expect(
      parseHopliteSignInPrompt(
        "visit http://hoplite.sh/device?user_code=YML8ANAY\n  and confirm the code YML8ANAY",
      ),
    ).toBeUndefined();
    expect(
      parseHopliteSignInPrompt("visit notaurl\n  and confirm the code YML8ANAY"),
    ).toBeUndefined();
    expect(
      parseHopliteSignInPrompt(
        "visit https://hoplite.sh/device?user_code=YML8ANAY\n  and confirm the code !!bad!!",
      ),
    ).toBeUndefined();
    expect(parseHopliteSignInPrompt("unrelated stderr output")).toBeUndefined();
  });
});

describe("isHopliteSignInRequired", () => {
  it.each([
    "hoplite acp: not signed in to Hoplite (not signed in to Hoplite; run `hoplite login`); the first session signs in",
    "hoplite acp: signing in to Hoplite: opening your browser (the address follows if it does not open)",
    "Hoplite rejected the stored CLI key (401); signing in again",
  ])("matches the CLI's sign-in stderr: %s", (line) => {
    expect(isHopliteSignInRequired(line)).toBe(true);
  });

  it.each(["hoplite acp: ready", "No Hoplite project for /repo", "some other warning"])(
    "ignores unrelated stderr: %s",
    (line) => {
      expect(isHopliteSignInRequired(line)).toBe(false);
    },
  );
});

describe("normalizeHopliteToolCall", () => {
  it("keeps whole-file diffs previewable and treats a new file as added", () => {
    const content = normalizeHopliteToolCall(
      tool([
        {
          type: "diff",
          path: "src/new.ts",
          oldText: "",
          newText: "export {};\n",
          _meta: { hoplite: { operation: "add" } },
        },
      ]),
    ).data.content;
    expect(acpToolCallDiffPatch(content)).toContain("--- /dev/null");
  });

  it("hides truncated text and omitted files instead of rendering a wrong diff", () => {
    const content = normalizeHopliteToolCall(
      tool(
        [
          {
            type: "diff",
            path: "src/big.ts",
            oldText: "a",
            newText: "b",
            _meta: { hoplite: { operation: "update", truncated: true } },
          },
        ],
        { hoplite: { omittedDiffs: [{ path: ".env", reason: "sensitive" }] } },
      ),
    ).data.content;
    expect(acpToolCallDiffPatch(content)).toBeUndefined();
    expect(content).toEqual([
      { type: "diff", path: "src/big.ts", patch: { format: "omitted" } },
      { type: "diff", path: ".env", patch: { format: "omitted" } },
    ]);
  });

  it("merges one file's partial hunks into a snippet, and reruns without duplicating", () => {
    const partial = { hoplite: { operation: "update", partial: true } };
    const once = normalizeHopliteToolCall(
      tool(
        [
          { type: "diff", path: "src/a.ts", oldText: "a < b", newText: "a <= b", _meta: partial },
          { type: "diff", path: "src/a.ts", oldText: "x", newText: "y", _meta: partial },
        ],
        { hoplite: { omittedDiffs: [{ path: ".env", reason: "limit" }] } },
      ),
    );
    expect(normalizeHopliteToolCall(once)).toEqual(once);
    const [snippet] = once.data.content as ReadonlyArray<unknown>;
    expect(acpToolCallSnippetEdit([snippet])).toEqual({
      oldStr: "a < b\n⋯\nx",
      newStr: "a <= b\n⋯\ny",
    });
  });
});

describe("rollbackHopliteSession", () => {
  const runtimeWith = (checkpointIds: ReadonlyArray<string>) => {
    const calls: Array<{ readonly method: string; readonly payload: unknown }> = [];
    const runtime = {
      request: (method: string, payload: unknown) =>
        Effect.sync(() => {
          calls.push({ method, payload });
          return method === "_hoplite/thread/checkpoints"
            ? { checkpoints: checkpointIds.map((checkpointId) => ({ checkpointId })) }
            : { result: { status: "restored" } };
        }),
    } as unknown as AcpSessionRuntime.AcpSessionRuntime["Service"];
    return { runtime, calls };
  };

  it.effect("restores the reply of the oldest dropped turn, counted from the newest", () =>
    Effect.gen(function* () {
      const { runtime, calls } = runtimeWith(["cp_3", "cp_2", "cp_1"]);
      yield* rollbackHopliteSession(runtime, "sess_1", { droppedTurns: 2 });
      expect(calls).toEqual([
        { method: "_hoplite/thread/checkpoints", payload: { sessionId: "sess_1", limit: 2 } },
        {
          method: "_hoplite/thread/restore_checkpoint",
          payload: { sessionId: "sess_1", checkpointId: "cp_2" },
        },
      ]);
    }),
  );

  it.effect("fails without restoring when Hoplite has fewer rewind points than dropped turns", () =>
    Effect.gen(function* () {
      const { runtime, calls } = runtimeWith(["cp_1"]);
      const exit = yield* Effect.exit(
        rollbackHopliteSession(runtime, "sess_1", { droppedTurns: 2 }),
      );
      expect(exit._tag).toBe("Failure");
      expect(calls.map((call) => call.method)).toEqual(["_hoplite/thread/checkpoints"]);
    }),
  );
});
