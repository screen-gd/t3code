import { CHECKPOINT_DIFF_TRUNCATED_MARKER } from "@t3tools/contracts";
import { FILE_HEADERS_ONLY, formatPatch, parsePatch, structuredPatch } from "diff";
import type { StructuredPatch } from "diff";

import type { OrchestrationV2FileChangeTurnItem } from "../orchestration-v2/ProjectionStore.ts";

export interface ProviderReportedFileDiff {
  readonly path: string;
  readonly additions: number;
  readonly deletions: number;
  /** Empty when the provider withheld the change (too large, or a credential file). */
  readonly patch: string;
}

function fileName(name: string | undefined): string | undefined {
  if (name === undefined || name === "/dev/null") return undefined;
  const unquoted = name.startsWith('"') ? (JSON.parse(name) as string) : name;
  return unquoted.replace(/^[ab]\//, "");
}

function fromStructured(
  structured: StructuredPatch,
  fallbackPath: string,
): ProviderReportedFileDiff | undefined {
  if (structured.hunks.length === 0) return undefined;
  const oldPath = fileName(structured.oldFileName);
  const newPath = fileName(structured.newFileName);
  const path = newPath ?? oldPath ?? fallbackPath;
  let additions = 0;
  let deletions = 0;
  for (const hunk of structured.hunks) {
    for (const line of hunk.lines) {
      if (line.startsWith("+")) additions += 1;
      else if (line.startsWith("-")) deletions += 1;
    }
  }
  const before = oldPath === undefined ? "/dev/null" : `a/${oldPath}`;
  const after = newPath === undefined ? "/dev/null" : `b/${path}`;
  // Headers would add a tab and timestamp after each file name.
  const body = formatPatch(
    {
      ...structured,
      oldFileName: before,
      newFileName: after,
      oldHeader: undefined,
      newHeader: undefined,
    },
    FILE_HEADERS_ONLY,
  );
  return {
    path,
    additions,
    deletions,
    patch: `diff --git ${JSON.stringify(`a/${oldPath ?? path}`)} ${JSON.stringify(`b/${path}`)}\n${body}`,
  };
}

function parsedDiffs(diffStr: string, fallbackPath: string) {
  try {
    return parsePatch(diffStr).flatMap((structured) => {
      const diff = fromStructured(structured, fallbackPath);
      return diff === undefined ? [] : [diff];
    });
  } catch {
    // Some agents put plain tool output in `diffStr`.
    return [];
  }
}

/** One entry per reported edit, in order; a file edited twice appears twice. */
export function providerReportedFileDiffs(
  items: ReadonlyArray<OrchestrationV2FileChangeTurnItem>,
): ReadonlyArray<ProviderReportedFileDiff> {
  return items.flatMap((item): ReadonlyArray<ProviderReportedFileDiff> => {
    const parsed = item.diffStr === undefined ? [] : parsedDiffs(item.diffStr, item.fileName);
    if (parsed.length > 0) return parsed;
    if (item.oldStr !== undefined || item.newStr !== undefined) {
      const snippet = fromStructured(
        structuredPatch(
          item.oldStr ? item.fileName : "/dev/null",
          item.fileName,
          item.oldStr ?? "",
          item.newStr ?? "",
          undefined,
          undefined,
          { context: 3 },
        ),
        item.fileName,
      );
      if (snippet !== undefined) return [snippet];
    }
    if (item.status !== "completed") return [];
    const paths = item.changes?.map((change) => change.path) ?? [item.fileName];
    return paths.map((path) => ({
      path,
      additions: item.additions ?? 0,
      deletions: item.deletions ?? 0,
      patch: "",
    }));
  });
}

export function providerReportedFileSummaries(diffs: ReadonlyArray<ProviderReportedFileDiff>) {
  const byPath = new Map<
    string,
    { path: string; kind: string; additions: number; deletions: number }
  >();
  for (const diff of diffs) {
    const current = byPath.get(diff.path);
    byPath.set(diff.path, {
      path: diff.path,
      kind: "modified",
      additions: (current?.additions ?? 0) + diff.additions,
      deletions: (current?.deletions ?? 0) + diff.deletions,
    });
  }
  return [...byPath.values()];
}

export function providerReportedPatch(
  diffs: ReadonlyArray<ProviderReportedFileDiff>,
  maxBytes: number,
): string {
  const patch = diffs
    .flatMap((diff) =>
      diff.patch === "" ? [] : [diff.patch.endsWith("\n") ? diff.patch : `${diff.patch}\n`],
    )
    .join("");
  if (Buffer.byteLength(patch) <= maxBytes) return patch;
  return (
    new TextDecoder().decode(
      Buffer.from(patch).subarray(
        0,
        maxBytes - Buffer.byteLength(CHECKPOINT_DIFF_TRUNCATED_MARKER),
      ),
      { stream: true },
    ) + CHECKPOINT_DIFF_TRUNCATED_MARKER
  );
}
