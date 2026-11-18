import { describe, expect, it } from "@effect/vitest";
import { ThreadId, TurnItemId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import type { OrchestrationV2FileChangeTurnItem } from "../orchestration-v2/ProjectionStore.ts";
import {
  providerReportedFileDiffs,
  providerReportedFileSummaries,
  providerReportedPatch,
} from "./ProviderReportedDiff.ts";

const at = DateTime.makeUnsafe("2026-11-18T00:00:00.000Z");

function fileChange(
  fields: Partial<OrchestrationV2FileChangeTurnItem> &
    Pick<OrchestrationV2FileChangeTurnItem, "fileName">,
): OrchestrationV2FileChangeTurnItem {
  return {
    id: TurnItemId.make(`item:${fields.fileName}`),
    threadId: ThreadId.make("thread:provider-diff"),
    runId: null,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: 0,
    status: "completed",
    title: null,
    startedAt: at,
    completedAt: at,
    updatedAt: at,
    type: "file_change",
    ...fields,
  };
}

describe("providerReportedFileDiffs", () => {
  it("splits a multi-file patch and counts each file's lines", () => {
    const diffs = providerReportedFileDiffs([
      fileChange({
        fileName: "a.ts",
        diffStr: [
          'diff --git "a/a.ts" "b/a.ts"',
          '--- "a/a.ts"',
          '+++ "b/a.ts"',
          "@@ -1,2 +1,2 @@",
          " keep",
          "-old",
          "+new",
          "--- /dev/null",
          "+++ b/b.ts",
          "@@ -0,0 +1,2 @@",
          "+one",
          "+two",
          "",
        ].join("\n"),
      }),
    ]);
    expect(diffs.map(({ path, additions, deletions }) => ({ path, additions, deletions }))).toEqual(
      [
        { path: "a.ts", additions: 1, deletions: 1 },
        { path: "b.ts", additions: 2, deletions: 0 },
      ],
    );
    expect(diffs[1]!.patch).toContain("--- /dev/null\n+++ b/b.ts");
  });

  it("builds a patch from old and new text, and lists a withheld edit without one", () => {
    const diffs = providerReportedFileDiffs([
      fileChange({ fileName: "src/x.ts", oldStr: "a\nb\n", newStr: "a\nc\n" }),
      fileChange({ fileName: ".env", additions: 0, deletions: 0 }),
      fileChange({ fileName: "failed.ts", status: "failed" }),
    ]);
    expect(diffs.map((diff) => [diff.path, diff.additions, diff.deletions])).toEqual([
      ["src/x.ts", 1, 1],
      [".env", 0, 0],
    ]);
    expect(diffs[1]!.patch).toBe("");
  });

  it("sums a file edited twice into one summary and keeps both patches", () => {
    const diffs = providerReportedFileDiffs([
      fileChange({ fileName: "x.ts", oldStr: "a\n", newStr: "b\n" }),
      fileChange({ fileName: "x.ts", oldStr: "b\n", newStr: "b\nc\n" }),
    ]);
    expect(providerReportedFileSummaries(diffs)).toEqual([
      { path: "x.ts", kind: "modified", additions: 2, deletions: 1 },
    ]);
    expect(providerReportedPatch(diffs, 1_000).match(/^diff --git /gm)).toHaveLength(2);
  });

  it("ignores plain tool output in diffStr and truncates past the byte limit", () => {
    const diffs = providerReportedFileDiffs([
      fileChange({
        fileName: "y.ts",
        diffStr: "Applied 1 edit",
        oldStr: "",
        newStr: "x\n".repeat(50),
      }),
    ]);
    expect(diffs).toHaveLength(1);
    expect(diffs[0]!.additions).toBe(50);
    const patch = providerReportedPatch(diffs, 64);
    expect(Buffer.byteLength(patch)).toBeLessThanOrEqual(64);
    expect(patch.endsWith("[truncated]")).toBe(true);
  });
});
