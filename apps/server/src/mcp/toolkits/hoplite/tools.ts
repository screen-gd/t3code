import {
  HopliteCloudActivity,
  HopliteCloudAnswerInput,
  HopliteCloudGetTaskInput,
  HopliteCloudPreview,
  HopliteCloudPreviewInput,
  HopliteCloudSendMessageInput,
  HopliteCloudSetEnvInput,
  HopliteCloudStartTaskInput,
  HopliteCloudTaskResult,
  OrchestratorMcpFailure,
  SecretRef,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import * as HopliteCloud from "../../../hopliteCloud/HopliteCloudService.ts";
import * as HopliteTaskWatch from "../../../hopliteCloud/HopliteTaskWatch.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as SecretRequests from "../../../secrets/SecretRequests.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  ThreadManagementService.ThreadManagementService,
  HopliteCloud.HopliteCloud,
  HopliteTaskWatch.HopliteTaskWatch,
  SecretRequests.SecretRequests,
];

// Status and stopping go through the task's card, with task_status and task_cancel.
const HopliteTaskTool = Tool.make("hoplite_task", {
  description:
    "Run `prompt` as a Hoplite cloud agent in its own sandbox, or send it to an earlier one's `threadId`; with `questionId` too, `prompt` answers that question. Pass `repo` as the GitHub owner/name to work in, usually this checkout's origin; Hoplite uses or creates its project for it. Track it with task_status and task_cancel.",
  parameters: Schema.Struct({
    prompt: HopliteCloudStartTaskInput.fields.prompt,
    threadId: Schema.optional(HopliteCloudSendMessageInput.fields.threadId),
    questionId: Schema.optional(HopliteCloudAnswerInput.fields.questionId),
    title: HopliteCloudStartTaskInput.fields.title,
    repo: HopliteCloudStartTaskInput.fields.repo,
    projectId: HopliteCloudStartTaskInput.fields.projectId,
    clientRequestId: HopliteCloudStartTaskInput.fields.clientRequestId,
  }),
  success: HopliteCloudTaskResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Hoplite cloud task")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.OpenWorld, true);

const HopliteTaskPreviewTool = Tool.make("hoplite_preview", {
  description: "A Hoplite task's app preview URL. `start` launches a stopped one.",
  parameters: HopliteCloudPreviewInput,
  success: HopliteCloudPreview,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Hoplite task preview")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.OpenWorld, true);

const HopliteActivityTool = Tool.make("hoplite_activity", {
  description:
    "What a Hoplite task is doing: run status, pending questions, recent tool calls, and changed files.",
  parameters: HopliteCloudGetTaskInput,
  success: HopliteCloudActivity,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Hoplite task activity")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.OpenWorld, true);

const HopliteEnvTool = Tool.make("hoplite_env", {
  description:
    "Save a value a Hoplite task needs, such as an API key, as an encrypted variable `key` on the task's Hoplite project. Get `secretRef` from request_secret first; you never see the value. Then tell the task it is set.",
  parameters: Schema.Struct({
    threadId: HopliteCloudSetEnvInput.fields.threadId,
    key: HopliteCloudSetEnvInput.fields.key,
    secretRef: SecretRef,
  }),
  success: Schema.Struct({ key: Schema.String, projectId: Schema.String }),
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Set a Hoplite project variable")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.OpenWorld, true);

export const HopliteToolkit = Toolkit.make(
  HopliteTaskTool,
  HopliteTaskPreviewTool,
  HopliteActivityTool,
  HopliteEnvTool,
);
