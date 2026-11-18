import {
  HopliteCloudGetTaskInput,
  HopliteCloudPreview,
  HopliteCloudPreviewInput,
  HopliteCloudSendMessageInput,
  HopliteCloudStartTaskInput,
  HopliteCloudTask,
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

const HopliteTaskStartTool = Tool.make("hoplite_task_start", {
  description:
    "Run `prompt` as a Hoplite cloud agent thread in its own sandbox with the project's repository, separate from this checkout. Needs Hoplite connected in Settings > Environments.",
  parameters: Schema.Struct({
    prompt: HopliteCloudStartTaskInput.fields.prompt,
    title: HopliteCloudStartTaskInput.fields.title,
    projectId: HopliteCloudStartTaskInput.fields.projectId.annotate({
      description: "Hoplite project. Default: the one set in Settings.",
    }),
    clientRequestId: HopliteCloudStartTaskInput.fields.clientRequestId,
  }),
  success: HopliteCloudTaskResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Start Hoplite cloud task")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.OpenWorld, true);

const HopliteTaskStatusTool = Tool.make("hoplite_task_status", {
  description: "Status, latest reply, and pull request of a Hoplite cloud task.",
  parameters: HopliteCloudGetTaskInput,
  success: HopliteCloudTask,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Hoplite cloud task status")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.OpenWorld, true);

const HopliteTaskMessageTool = Tool.make("hoplite_task_message", {
  description:
    "Send a Hoplite cloud task a follow-up, such as an answer or more work. It runs after any active run.",
  parameters: HopliteCloudSendMessageInput,
  success: HopliteCloudTaskResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Message Hoplite cloud task")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.OpenWorld, true);

const HopliteTaskStopTool = Tool.make("hoplite_task_stop", {
  description: "Stop a Hoplite cloud task's active run. The thread stays and can take messages.",
  parameters: HopliteCloudGetTaskInput,
  success: HopliteCloudTask,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Stop Hoplite cloud task")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.OpenWorld, true);

const HopliteTaskPreviewTool = Tool.make("hoplite_task_preview", {
  description: "A Hoplite cloud task's app preview and its URL. `start` launches a stopped one.",
  parameters: HopliteCloudPreviewInput,
  success: HopliteCloudPreview,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Hoplite cloud task preview")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.OpenWorld, true);

export const HopliteToolkit = Toolkit.make(
  HopliteTaskStartTool,
  HopliteTaskStatusTool,
  HopliteTaskMessageTool,
  HopliteTaskStopTool,
  HopliteTaskPreviewTool,
);
