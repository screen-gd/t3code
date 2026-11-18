import {
  HopliteCloudGetTaskInput,
  HopliteCloudStartTaskInput,
  HopliteCloudTask,
  OrchestratorMcpFailure,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import * as HopliteCloud from "../../../hopliteCloud/HopliteCloudService.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const HopliteTaskStartTool = Tool.make("hoplite_task_start", {
  description:
    "Run `prompt` as a Hoplite cloud agent thread in its own sandbox with the project's repository, separate from this checkout. Needs Hoplite connected in Settings > Environments. Check it with hoplite_task_status.",
  parameters: Schema.Struct({
    prompt: HopliteCloudStartTaskInput.fields.prompt,
    title: HopliteCloudStartTaskInput.fields.title,
    projectId: HopliteCloudStartTaskInput.fields.projectId.annotate({
      description: "Hoplite project. Default: the one set in Settings.",
    }),
    clientRequestId: HopliteCloudStartTaskInput.fields.clientRequestId,
  }),
  success: HopliteCloudTask,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    HopliteCloud.HopliteCloud,
  ],
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
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    HopliteCloud.HopliteCloud,
  ],
})
  .annotate(Tool.Title, "Hoplite cloud task status")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.OpenWorld, true);

export const HopliteToolkit = Toolkit.make(HopliteTaskStartTool, HopliteTaskStatusTool);
