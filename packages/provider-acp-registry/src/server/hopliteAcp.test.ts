import { describe, expect, it } from "vite-plus/test";
import { acpToolCallDiffPatch, acpToolCallSnippetEdit } from "@t3tools/provider-acp/server/adapter";

import { normalizeHopliteToolCall } from "./hopliteAcp.ts";

const tool = (content: ReadonlyArray<unknown>, meta?: unknown) => ({
  toolCallId: "call_1",
  kind: "edit",
  data: { content, ...(meta === undefined ? {} : { meta }) },
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
