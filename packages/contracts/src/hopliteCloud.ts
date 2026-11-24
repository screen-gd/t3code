import * as Schema from "effect/Schema";

import { NodeId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

/**
 * Cloud sandbox providers run coding agents in their own sandboxes through an API,
 * such as Hoplite (hoplite.sh). The environment
 * holding a provider's API key starts and reads tasks there; clients and agents only
 * ever see task records, never a key.
 */
export const CloudSandboxProvider = Schema.Literals([
  "hoplite",
  "e2b",
  "daytona",
  "agent37",
  "devin",
]);
export type CloudSandboxProvider = typeof CloudSandboxProvider.Type;

/** The agent a sandbox task runs: Claude Code by default, or Codex. */
export const CloudSandboxAgent = Schema.Literals(["claude", "codex"]);
export type CloudSandboxAgent = typeof CloudSandboxAgent.Type;

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
  /** Where the Claude credential sandbox agents sign in with comes from; never its value. */
  claude: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        source: Schema.Literals(["settings", "environment"]),
        kind: Schema.Literals(["api_key", "subscription"]),
      }),
    ),
  ),
  /** Where the Codex credential comes from; never its value. */
  codex: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        source: Schema.Literals(["settings", "environment"]),
        kind: Schema.Literals(["api_key"]),
      }),
    ),
  ),
});
export type HopliteCloudStatus = typeof HopliteCloudStatus.Type;

export const HopliteCloudSetAgentCredentialInput = Schema.Struct({
  agent: CloudSandboxAgent,
  /** An Anthropic or OpenAI API key, or a subscription token from `claude setup-token`. */
  credential: TrimmedNonEmptyString.check(Schema.isMaxLength(512)),
});
export type HopliteCloudSetAgentCredentialInput = typeof HopliteCloudSetAgentCredentialInput.Type;

export const HopliteCloudClearAgentCredentialInput = Schema.Struct({
  agent: CloudSandboxAgent,
});
export type HopliteCloudClearAgentCredentialInput =
  typeof HopliteCloudClearAgentCredentialInput.Type;

export const HopliteCloudConnectInput = Schema.Union([
  Schema.Struct({
    /** Omitted means Hoplite. */
    provider: Schema.optional(Schema.Literals(["hoplite", "e2b", "daytona", "agent37"])),
    apiKey: TrimmedNonEmptyString.check(Schema.isMaxLength(512)),
  }),
  Schema.Struct({ provider: Schema.Literal("devin") }),
]);
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
  /** The latest agent reply, cut to twenty thousand characters. */
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
  /**
   * Hoplite: a model id or name, such as `gpt-6-luna` or "GPT 6 Luna". Sandbox
   * providers: the agent's model — a Claude Code model such as `sonnet` or `opus`,
   * or a Codex model such as `gpt-5-codex`. Omitted uses the default.
   */
  model: HopliteModel,
  /** Sandbox providers only: the agent to run; omitted runs Claude Code. */
  agent: Schema.optional(CloudSandboxAgent),
  /** Sandbox providers only: the template or snapshot the sandbox is created from. */
  template: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(200))),
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
  dismiss: Schema.optional(Schema.Boolean),
  /** Makes retries send one answer. */
  clientRequestId: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(64))),
});
export type HopliteCloudAnswerInput = typeof HopliteCloudAnswerInput.Type;

/** A cloud delegate's question; its task and question ids route the answer. */
export const HopliteCloudQuestion = Schema.Struct({
  questionId: HopliteId,
  runId: Schema.optional(Schema.String),
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
  /** Start the thread's preview server when it is not running. Hoplite only. */
  start: Schema.optional(Schema.Boolean),
  /** The port the sandbox serves on; sandboxes default to 3000. */
  port: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65535 }))),
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

/** E2B, Daytona and Agent37 hand out bare sandboxes an agent can work in directly. */
export const CloudSandboxMachineProvider = Schema.Literals(["e2b", "daytona", "agent37"]);
export type CloudSandboxMachineProvider = typeof CloudSandboxMachineProvider.Type;

export const CloudSandboxCreateInput = Schema.Struct({
  provider: CloudSandboxMachineProvider,
  /** The template or snapshot the sandbox is created from; omitted uses the provider's default. */
  template: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(200))),
});
export type CloudSandboxCreateInput = typeof CloudSandboxCreateInput.Type;

export const CloudSandbox = Schema.Struct({
  /** `<provider>:<id>`, the same id a cloud_task in that sandbox has. */
  sandboxId: Schema.String,
});
export type CloudSandbox = typeof CloudSandbox.Type;

export const CloudSandboxRunInput = Schema.Struct({
  sandboxId: HopliteId,
  /** Runs under `bash -lc`. */
  command: TrimmedNonEmptyString.check(Schema.isMaxLength(100_000)),
});
export type CloudSandboxRunInput = typeof CloudSandboxRunInput.Type;

export const CloudSandboxRunResult = Schema.Struct({
  exitCode: Schema.Number,
  output: Schema.String,
});
export type CloudSandboxRunResult = typeof CloudSandboxRunResult.Type;

export const CloudSandboxIdInput = Schema.Struct({ sandboxId: HopliteId });
export type CloudSandboxIdInput = typeof CloudSandboxIdInput.Type;
