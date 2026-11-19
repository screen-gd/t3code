import {
  HopliteCloudAnswerInput,
  HopliteCloudPreview,
  HopliteCloudPreviewInput,
  HopliteCloudSendMessageInput,
  HopliteCloudStartTaskInput,
  HopliteCloudTaskResult,
  OrchestratorMcpFailure,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import * as HopliteCloud from "../../../hopliteCloud/HopliteCloudService.ts";
import * as HopliteTaskWatch from "../../../hopliteCloud/HopliteTaskWatch.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  ThreadManagementService.ThreadManagementService,
  HopliteCloud.HopliteCloud,
  HopliteTaskWatch.HopliteTaskWatch,
];

// Status and stopping go through the task's card, with task_status and task_cancel.
const HopliteTaskTool = Tool.make("cloud_task", {
  description:
    "Run `prompt` as a cloud agent in its own sandbox, or send it to an earlier one's `threadId`; with `questionId` too, `prompt` answers that question (Hoplite). `provider` picks hoplite, devin or jules among the connected ones; omitted uses Hoplite, else the one connected. `repo` is the GitHub owner/name to work in (Jules and Hoplite need it). `model` is Hoplite only, by id or name. Completion wakes you, so end your turn after starting it.",
  parameters: Schema.Struct({
    prompt: HopliteCloudStartTaskInput.fields.prompt,
    provider: HopliteCloudStartTaskInput.fields.provider,
    threadId: Schema.optional(HopliteCloudSendMessageInput.fields.threadId),
    questionId: Schema.optional(HopliteCloudAnswerInput.fields.questionId),
    model: HopliteCloudStartTaskInput.fields.model,
    title: HopliteCloudStartTaskInput.fields.title,
    repo: HopliteCloudStartTaskInput.fields.repo,
    clientRequestId: HopliteCloudStartTaskInput.fields.clientRequestId,
  }),
  success: HopliteCloudTaskResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Cloud sandbox task")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.OpenWorld, true);

const HopliteTaskPreviewTool = Tool.make("cloud_preview", {
  description: "A Hoplite cloud_task's app preview URL. `start` launches a stopped one.",
  parameters: HopliteCloudPreviewInput,
  success: HopliteCloudPreview,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Cloud task preview")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.OpenWorld, true);

export const HopliteToolkit = Toolkit.make(HopliteTaskTool, HopliteTaskPreviewTool);
