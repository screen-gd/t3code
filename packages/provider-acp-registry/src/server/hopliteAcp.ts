import { isHopliteAcpConfig, ProviderDriverKind } from "@t3tools/contracts";
import {
  AcpProviderCapabilitiesV2,
  type AcpAdapterV2ExtensionContext,
  type AcpAdapterV2Flavor,
} from "@t3tools/provider-acp/server/adapter";
import type { AcpToolCallState } from "@t3tools/provider-acp/server/runtimeModel";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type { AcpRegistrySettings } from "../settings.ts";

/** `hoplite acp` relays to Hoplite's cloud sandbox; https://hoplite.sh/docs/cli/acp */
export function isHopliteAcpCommand(settings: AcpRegistrySettings): boolean {
  return isHopliteAcpConfig(settings);
}

const HOPLITE_SIGN_IN_REQUIRED =
  /not signed in to Hoplite|signing in to Hoplite|rejected the stored CLI key/i;

// The CLI prints "visit https://…/device?user_code=CODE" then "confirm the code CODE".
// Match the last pair in the accumulated text: a retry prints a fresh code.
const HOPLITE_SIGN_IN_PROMPT = /visit\s+(\S+)[\s\S]*?confirm the code\s+([A-Za-z0-9-]+)/g;

const HOPLITE_USER_CODE = /^[A-Za-z0-9-]{4,64}$/;

/** The CLI says a sign-in is starting or needed before it can serve sessions. */
export function isHopliteSignInRequired(text: string): boolean {
  return HOPLITE_SIGN_IN_REQUIRED.test(text);
}

/**
 * The device sign-in Hoplite's CLI writes to stderr while `authenticate` or `session/new` waits
 * on browser approval, parsed from an accumulated tail (chunks may split any line). Only the last
 * printed code counts, and only an https page is safe to show the user.
 */
export function parseHopliteSignInPrompt(
  text: string,
): { readonly url: string; readonly userCode: string } | undefined {
  let last: RegExpMatchArray | undefined;
  for (const match of text.matchAll(HOPLITE_SIGN_IN_PROMPT)) {
    last = match;
  }
  const [, urlText, userCode] = last ?? [];
  if (urlText === undefined || userCode === undefined || !HOPLITE_USER_CODE.test(userCode)) {
    return undefined;
  }
  try {
    const url = new URL(urlText);
    return url.protocol === "https:" ? { url: url.href, userCode } : undefined;
  } catch {
    return undefined;
  }
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

/** Hoplite edits and rewinds its cloud sandbox; T3 must never snapshot or restore local files for it. */
export const HOPLITE_ACP_CAPABILITIES = {
  ...AcpProviderCapabilitiesV2,
  checkpointing: {
    ...AcpProviderCapabilitiesV2.checkpointing,
    appCanCheckpointFilesystem: false,
    providerCanRollbackConversation: true,
  },
};

const HOPLITE_CHECKPOINT_LIMIT = 100;

const HopliteCheckpoints = Schema.Struct({
  checkpoints: Schema.Array(Schema.Struct({ checkpointId: Schema.String })),
});

/**
 * Hoplite keeps one rewind point per reply, newest first; restoring one drops that reply and
 * everything after it and resets the cloud workspace. The `droppedTurns`-th newest is assumed
 * to be the first dropped T3 turn's reply: one Hoplite run per T3 turn, none from elsewhere since.
 */
export const rollbackHopliteSession: NonNullable<AcpAdapterV2Flavor["rollbackSession"]> = Effect.fn(
  "rollbackHopliteSession",
)(function* (runtime, sessionId, { droppedTurns }) {
  const fail = (detail: string) =>
    new ProviderAdapter.ProviderAdapterProtocolError({
      driver: ProviderDriverKind.make("acpRegistry"),
      detail,
    });
  if (droppedTurns > HOPLITE_CHECKPOINT_LIMIT) {
    return yield* fail(
      `Hoplite can rewind at most ${HOPLITE_CHECKPOINT_LIMIT} replies; this rewind drops ${droppedTurns}.`,
    );
  }
  const { checkpoints } = yield* runtime
    .request("_hoplite/thread/checkpoints", { sessionId, limit: droppedTurns })
    .pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(HopliteCheckpoints)),
      Effect.mapError((cause) =>
        "_tag" in cause && cause._tag === "SchemaError"
          ? fail("Hoplite returned an unreadable checkpoint list.")
          : cause,
      ),
    );
  const target = checkpoints[droppedTurns - 1];
  if (target === undefined) {
    return yield* fail(
      `Hoplite has ${checkpoints.length} rewind points, but this rewind drops ${droppedTurns} replies.`,
    );
  }
  yield* runtime.request("_hoplite/thread/restore_checkpoint", {
    sessionId,
    checkpointId: target.checkpointId,
  });
});
