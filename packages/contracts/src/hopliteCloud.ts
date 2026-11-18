import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";

/**
 * Hoplite (hoplite.sh) runs coding agents in cloud sandboxes. The environment
 * holding the Hoplite API key starts and reads threads there; clients and
 * agents only ever see project and thread records, never the key.
 */
const HopliteId = TrimmedNonEmptyString.check(Schema.isMaxLength(128));

export const HopliteCloudProject = Schema.Struct({
  id: HopliteId,
  name: Schema.String,
});
export type HopliteCloudProject = typeof HopliteCloudProject.Type;

export const HopliteCloudStatus = Schema.Struct({
  connected: Schema.Boolean,
  projects: Schema.Array(HopliteCloudProject),
  defaultProjectId: Schema.NullOr(HopliteId),
  /** Why the stored key could not list projects, such as a revoked key. */
  problem: Schema.NullOr(Schema.String),
});
export type HopliteCloudStatus = typeof HopliteCloudStatus.Type;

export const HopliteCloudConnectInput = Schema.Struct({
  apiKey: TrimmedNonEmptyString.check(Schema.isMaxLength(512)),
});
export type HopliteCloudConnectInput = typeof HopliteCloudConnectInput.Type;

export const HopliteCloudSetDefaultProjectInput = Schema.Struct({
  projectId: Schema.NullOr(HopliteId),
});
export type HopliteCloudSetDefaultProjectInput = typeof HopliteCloudSetDefaultProjectInput.Type;

export const HopliteCloudThreadStatus = Schema.Literals([
  "queued",
  "running",
  "waiting",
  "blocked",
  "ready",
  "failed",
  "archived",
]);
export type HopliteCloudThreadStatus = typeof HopliteCloudThreadStatus.Type;

export const HopliteCloudTask = Schema.Struct({
  threadId: HopliteId,
  projectId: HopliteId,
  title: Schema.NullOr(Schema.String),
  status: HopliteCloudThreadStatus,
  /** The latest agent reply, cut to a few thousand characters. */
  latestReply: Schema.NullOr(Schema.String),
  pullRequestUrl: Schema.NullOr(Schema.String),
});
export type HopliteCloudTask = typeof HopliteCloudTask.Type;

export const HopliteCloudStartTaskInput = Schema.Struct({
  prompt: TrimmedNonEmptyString.check(Schema.isMaxLength(100_000)),
  title: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(200))),
  projectId: Schema.optional(HopliteId),
  /** Makes retries create one thread. */
  clientRequestId: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(64))),
});
export type HopliteCloudStartTaskInput = typeof HopliteCloudStartTaskInput.Type;

export const HopliteCloudGetTaskInput = Schema.Struct({ threadId: HopliteId });
export type HopliteCloudGetTaskInput = typeof HopliteCloudGetTaskInput.Type;

export const HopliteCloudErrorCode = Schema.Literals([
  "not_connected",
  "invalid_key",
  "forbidden",
  "not_found",
  "project_required",
  "rate_limited",
  "unavailable",
]);
export type HopliteCloudErrorCode = typeof HopliteCloudErrorCode.Type;

export class HopliteCloudError extends Schema.TaggedError<HopliteCloudError>()(
  "HopliteCloudError",
  {
    code: HopliteCloudErrorCode,
    message: Schema.String,
  },
) {}
