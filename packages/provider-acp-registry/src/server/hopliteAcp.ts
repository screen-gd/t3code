import type { AcpAdapterV2ExtensionContext } from "@t3tools/provider-acp/server/adapter";
import type { AcpToolCallState } from "@t3tools/provider-acp/server/runtimeModel";
import * as Schema from "effect/Schema";

import type { AcpRegistrySettings } from "../settings.ts";

/** `hoplite acp` relays to Hoplite's cloud sandbox; https://hoplite.sh/docs/cli/acp */
export function isHopliteAcpCommand(settings: AcpRegistrySettings): boolean {
  return (
    settings.source === "local" &&
    /^hoplite(\.exe|\.cmd)?$/i.test(settings.commandPath.split(/[\\/]/).pop() ?? "")
  );
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function hopliteMeta(value: unknown): Record<string, unknown> | undefined {
  return record(record(record(value)?._meta ?? record(value)?.meta)?.hoplite);
}

// Marks a gap between partial hunks of one file; Hoplite sends no line numbers for them.
const HUNK_GAP = "\n⋯\n";

/**
 * Hoplite edits land in its sandbox, so these diffs are the only view of them. Partial hunks
 * carry no line numbers: one file's hunks become a single snippet. Truncated text and
 * `omittedDiffs` paths become `omitted` so no view renders a wrong diff.
 */
export function normalizeHopliteToolCall(tool: AcpToolCallState): AcpToolCallState {
  const content = tool.data.content;
  const omitted = hopliteMeta(tool.data)?.omittedDiffs;
  if (!Array.isArray(content) && !Array.isArray(omitted)) return tool;
  const entries = Array.isArray(content) ? content : [];
  const partialByPath = new Map<string, { oldText: Array<string>; newText: Array<string> }>();
  const next: Array<unknown> = [];
  for (const entry of entries) {
    const diff = record(entry);
    const meta = hopliteMeta(diff);
    if (diff?.type !== "diff" || meta === undefined || typeof diff.path !== "string") {
      next.push(entry);
    } else if (meta.truncated !== undefined && meta.truncated !== false) {
      next.push({ type: "diff", path: diff.path, patch: { format: "omitted" } });
    } else if (meta.partial === true && typeof diff.newText === "string") {
      const hunks = partialByPath.get(diff.path) ?? { oldText: [], newText: [] };
      hunks.oldText.push(typeof diff.oldText === "string" ? diff.oldText : "");
      hunks.newText.push(diff.newText);
      partialByPath.set(diff.path, hunks);
    } else if (meta.operation === "add" && !diff.oldText) {
      const { oldText: _oldText, ...added } = diff;
      next.push(added);
    } else {
      next.push(entry);
    }
  }
  for (const [path, hunks] of partialByPath) {
    next.push({
      type: "diff",
      path,
      oldText: hunks.oldText.join(HUNK_GAP),
      newText: hunks.newText.join(HUNK_GAP),
      patch: { format: "snippet" },
    });
  }
  // Normalization reruns on merged tool state, so add each omitted path once.
  const listed = new Set(next.map((entry) => record(entry)?.path));
  for (const item of Array.isArray(omitted) ? omitted : []) {
    const path = record(item)?.path;
    if (typeof path === "string" && !listed.has(path)) {
      listed.add(path);
      next.push({ type: "diff", path, patch: { format: "omitted" } });
    }
  }
  return { ...tool, data: { ...tool.data, content: next } };
}

const HopliteRunPhase = Schema.Struct({
  sessionId: Schema.String,
  label: Schema.NullOr(Schema.String),
});

/** `_hoplite/run_phase` reports sandbox setup before the agent answers. */
export function registerHopliteAcpExtensions(context: AcpAdapterV2ExtensionContext) {
  return context.runtime.handleExtNotification("_hoplite/run_phase", HopliteRunPhase, (notice) =>
    context.reportRunPhase({ sessionId: notice.sessionId, label: notice.label }),
  );
}
