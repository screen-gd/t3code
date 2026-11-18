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

export const HopliteCloudTaskResult = Schema.Struct({
  ...HopliteCloudTask.fields,
  /** What the agent should do next, such as end its turn because completion wakes it. */
  next: Schema.optional(Schema.String),
});
export type HopliteCloudTaskResult = typeof HopliteCloudTaskResult.Type;

export const HopliteCloudStartTaskInput = Schema.Struct({
  prompt: TrimmedNonEmptyString.check(Schema.isMaxLength(100_000)),
  title: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(200))),
  projectId: Schema.optional(HopliteId),
  /** A GitHub `owner/name`; picks the Hoplite project with it, creating one when none has it. */
  repo: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(200))),
  /** Makes retries create one thread. */
  clientRequestId: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(64))),
});
export type HopliteCloudStartTaskInput = typeof HopliteCloudStartTaskInput.Type;

export const HopliteCloudGetTaskInput = Schema.Struct({ threadId: HopliteId });
export type HopliteCloudGetTaskInput = typeof HopliteCloudGetTaskInput.Type;

export const HopliteCloudSendMessageInput = Schema.Struct({
  threadId: HopliteId,
  message: TrimmedNonEmptyString.check(Schema.isMaxLength(100_000)),
  /** Makes retries send one message. */
  clientRequestId: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(64))),
});
export type HopliteCloudSendMessageInput = typeof HopliteCloudSendMessageInput.Type;

export const HopliteCloudAnswerInput = Schema.Struct({
  threadId: HopliteId,
  questionId: HopliteId,
  answer: TrimmedNonEmptyString.check(Schema.isMaxLength(10_000)),
  /** Makes retries send one answer. */
  clientRequestId: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(64))),
});
export type HopliteCloudAnswerInput = typeof HopliteCloudAnswerInput.Type;

/** A question a Hoplite agent stopped to ask; one answer covers all its parts. */
export const HopliteCloudQuestion = Schema.Struct({
  questionId: HopliteId,
  parts: Schema.Array(
    Schema.Struct({
      question: Schema.String,
      options: Schema.Array(Schema.Struct({ label: Schema.String, description: Schema.String })),
    }),
  ),
});
export type HopliteCloudQuestion = typeof HopliteCloudQuestion.Type;

export const HopliteCloudActivity = Schema.Struct({
  ...HopliteCloudTask.fields,
  runStatus: Schema.NullOr(
    Schema.Literals(["queued", "running", "waiting", "completed", "failed", "cancelled"]),
  ),
  questions: Schema.Array(HopliteCloudQuestion),
  /** The latest run's most recent tool calls, oldest first, with previews cut short. */
  recentTools: Schema.Array(
    Schema.Struct({
      tool: Schema.String,
      status: Schema.String,
      input: Schema.NullOr(Schema.String),
      error: Schema.NullOr(Schema.String),
    }),
  ),
  /** Files the task changed against its base branch, without patches. */
  changedFiles: Schema.Array(
    Schema.Struct({
      path: Schema.String,
      state: Schema.String,
      additions: Schema.Number,
      deletions: Schema.Number,
    }),
  ),
});
export type HopliteCloudActivity = typeof HopliteCloudActivity.Type;

export const HopliteCloudPreviewInput = Schema.Struct({
  threadId: HopliteId,
  /** Start the thread's preview server when it is not running. */
  start: Schema.optional(Schema.Boolean),
});
export type HopliteCloudPreviewInput = typeof HopliteCloudPreviewInput.Type;

export const HopliteCloudPreview = Schema.Struct({
  status: Schema.Literals([
    "ready",
    "unsupported",
    "reconciling",
    "blocked",
    "starting",
    "stopped",
    "crashed",
    "inactive",
  ]),
  /** Gateway access tokens for it stay with the server. */
  url: Schema.NullOr(Schema.String),
  reason: Schema.NullOr(Schema.String),
});
export type HopliteCloudPreview = typeof HopliteCloudPreview.Type;

export const HopliteCloudErrorCode = Schema.Literals([
  "not_connected",
  "invalid_key",
  "forbidden",
  "not_found",
  "project_required",
  "repo_unavailable",
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
