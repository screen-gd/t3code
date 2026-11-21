import * as Schema from "effect/Schema";

import { NodeId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

/**
 * Cloud sandbox providers run coding agents in their own sandboxes through an API,
 * such as Hoplite (hoplite.sh). The environment
 * holding a provider's API key starts and reads tasks there; clients and agents only
 * ever see task records, never a key.
 */
export const CloudSandboxProvider = Schema.Literals(["hoplite"]);
export type CloudSandboxProvider = typeof CloudSandboxProvider.Type;

const HopliteId = TrimmedNonEmptyString.check(Schema.isMaxLength(128));
const HopliteModel = Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(128)));

export const CloudSandboxProviderStatus = Schema.Struct({
  provider: CloudSandboxProvider,
  connected: Schema.Boolean,
  /** Why the stored key stopped working, such as a revoked key. */
  problem: Schema.NullOr(Schema.String),
});
export type CloudSandboxProviderStatus = typeof CloudSandboxProviderStatus.Type;

export const HopliteCloudStatus = Schema.Struct({
  /** Hoplite's key, as before providers were added. */
  connected: Schema.Boolean,
  problem: Schema.NullOr(Schema.String),
  /** Every provider, connected or not; older servers omit it. */
  providers: Schema.optional(Schema.Array(CloudSandboxProviderStatus)),
});
export type HopliteCloudStatus = typeof HopliteCloudStatus.Type;

export const HopliteCloudConnectInput = Schema.Struct({
  /** Omitted means Hoplite. */
  provider: Schema.optional(CloudSandboxProvider),
  apiKey: TrimmedNonEmptyString.check(Schema.isMaxLength(512)),
});
export type HopliteCloudConnectInput = typeof HopliteCloudConnectInput.Type;

export const HopliteCloudDisconnectInput = Schema.Struct({
  /** Omitted means Hoplite. */
  provider: Schema.optional(CloudSandboxProvider),
});
export type HopliteCloudDisconnectInput = typeof HopliteCloudDisconnectInput.Type;

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
  /** Omitted means Hoplite. */
  provider: Schema.optional(CloudSandboxProvider),
  title: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(200))),
  /** A GitHub `owner/name`; the task runs in the Hoplite project that has it. */
  repo: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(200))),
  /** Hoplite only: a model id or name, such as `gpt-6-luna` or "GPT 6 Luna"; omitted uses Hoplite's default. */
  model: HopliteModel,
  /** Makes retries create one thread. */
  clientRequestId: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(64))),
});
export type HopliteCloudStartTaskInput = typeof HopliteCloudStartTaskInput.Type;

export const HopliteCloudGetTaskInput = Schema.Struct({ threadId: HopliteId });
export type HopliteCloudGetTaskInput = typeof HopliteCloudGetTaskInput.Type;

export const HopliteCloudSendMessageInput = Schema.Struct({
  threadId: HopliteId,
  message: TrimmedNonEmptyString.check(Schema.isMaxLength(100_000)),
  model: HopliteModel,
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
  "model_unavailable",
  "rate_limited",
  "unavailable",
  /** The provider's API has no way to do this. */
  "unsupported",
]);
export type HopliteCloudErrorCode = typeof HopliteCloudErrorCode.Type;

export class HopliteCloudError extends Schema.TaggedError<HopliteCloudError>()(
  "HopliteCloudError",
  {
    code: HopliteCloudErrorCode,
    message: Schema.String,
  },
) {}

/** One entry of a cloud task's chat, as the delegating thread shows it. */
export const CloudTaskChatEntry = Schema.Union([
  Schema.TaggedStruct("message", {
    id: Schema.String,
    role: Schema.Literals(["user", "assistant"]),
    text: Schema.String,
  }),
  Schema.TaggedStruct("tool", {
    id: Schema.String,
    title: Schema.String,
    status: Schema.Literals(["pending", "in_progress", "completed", "failed"]),
  }),
]);
export type CloudTaskChatEntry = typeof CloudTaskChatEntry.Type;

/** Changes to a cloud task's chat; streamed text arrives as appends, not resent entries. */
export const CloudTaskChatEvent = Schema.Union([
  Schema.TaggedStruct("upsert", { entry: CloudTaskChatEntry }),
  Schema.TaggedStruct("append", { id: Schema.String, text: Schema.String }),
  /** The history is replayed; what follows happens live. `running` is absent from older servers. */
  Schema.TaggedStruct("live", { running: Schema.optional(Schema.Boolean) }),
  /** The chat as replayed on a new connection, in place of what was shown. */
  Schema.TaggedStruct("replace", { entries: Schema.Array(CloudTaskChatEntry) }),
]);
export type CloudTaskChatEvent = typeof CloudTaskChatEvent.Type;

export const HopliteCloudWatchTaskChatInput = Schema.Struct({
  /** The thread that delegated the task. */
  threadId: ThreadId,
  taskId: NodeId,
});
export type HopliteCloudWatchTaskChatInput = typeof HopliteCloudWatchTaskChatInput.Type;

export const HopliteCloudSendTaskMessageInput = Schema.Struct({
  threadId: ThreadId,
  taskId: NodeId,
  message: TrimmedNonEmptyString.check(Schema.isMaxLength(100_000)),
});
export type HopliteCloudSendTaskMessageInput = typeof HopliteCloudSendTaskMessageInput.Type;
