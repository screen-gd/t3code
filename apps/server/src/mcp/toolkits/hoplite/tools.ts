import {
  CloudSandbox,
  CloudSandboxCreateInput,
  CloudSandboxIdInput,
  CloudSandboxRunInput,
  CloudSandboxRunResult,
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
    "Run `prompt` as a cloud agent in its own sandbox, or send it to an earlier one's `threadId`; with `questionId` too, `prompt` answers that question. Pass dismiss:true only for an explicit user dismissal. Questions wake you: answer from context or ask the user through your interactive picker, then relay the answer with the originating threadId and questionId. `provider` is hoplite (default; its own agent, `model` by id or name), devin (Devin Cloud using the host's Devin CLI login and account defaults; omit agent, model and template), e2b, daytona or agent37 (`agent` claude (default) or codex in a fresh sandbox, `model` that agent's model such as sonnet or gpt-5-codex, `template` the image or snapshot the sandbox is created from). `repo` is the GitHub owner/name to work in. Completion wakes you, so end your turn after starting it.",
  parameters: Schema.Struct({
    prompt: HopliteCloudStartTaskInput.fields.prompt,
    provider: HopliteCloudStartTaskInput.fields.provider,
    threadId: Schema.optional(HopliteCloudSendMessageInput.fields.threadId),
    questionId: Schema.optional(HopliteCloudAnswerInput.fields.questionId),
    dismiss: HopliteCloudAnswerInput.fields.dismiss,
    model: HopliteCloudStartTaskInput.fields.model,
    template: HopliteCloudStartTaskInput.fields.template,
    agent: HopliteCloudStartTaskInput.fields.agent,
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
  description:
    "A cloud_task's preview URL for the app it serves on `port` (default 3000). `start` launches a stopped one on Hoplite.",
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

const SandboxCreateTool = Tool.make("sandbox_create", {
  description:
    "Create an empty e2b, daytona or agent37 sandbox to run commands in yourself with sandbox_run; `template` names the image or snapshot it is created from. Delete it with sandbox_delete when done.",
  parameters: CloudSandboxCreateInput,
  success: CloudSandbox,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Create cloud sandbox")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.OpenWorld, true);

const SandboxRunTool = Tool.make("sandbox_run", {
  description:
    "Run a bash command in a sandbox from sandbox_create or cloud_task; returns its exit code and the last 100k characters of output.",
  parameters: CloudSandboxRunInput,
  success: CloudSandboxRunResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Run in cloud sandbox")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.OpenWorld, true);

const SandboxDeleteTool = Tool.make("sandbox_delete", {
  description: "Delete a sandbox and everything in it, including a cloud_task running there.",
  parameters: CloudSandboxIdInput,
  success: Schema.Struct({}),
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Delete cloud sandbox")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.OpenWorld, true);

export const HopliteToolkit = Toolkit.make(
  HopliteTaskTool,
  HopliteTaskPreviewTool,
  SandboxCreateTool,
  SandboxRunTool,
  SandboxDeleteTool,
);
