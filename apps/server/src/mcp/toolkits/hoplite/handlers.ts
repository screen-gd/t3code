import { type HopliteCloudError, OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as HopliteCloud from "../../../hopliteCloud/HopliteCloudService.ts";
import * as HopliteTaskWatch from "../../../hopliteCloud/HopliteTaskWatch.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { HopliteToolkit } from "./tools.ts";

const toFailure = (error: HopliteCloudError) =>
  new OrchestratorMcpFailure({
    code:
      error.code === "not_found"
        ? "task_not_found"
        : error.code === "project_required"
          ? "target_required"
          : "provider_unavailable",
    message: error.message,
  });

// Only an agent's own thread can be woken; outside MCP clients check status themselves.
const callerThreadId = Effect.map(
  McpInvocationContext.McpInvocationContext,
  (scope) => scope.thread?.threadId,
);

const handlers = {
  // These spend the controller's Hoplite key, so read-only clients and linked environments may not.
  hoplite_task_start: McpToolAccess.writesWithCapability((input) =>
    Effect.all([HopliteTaskWatch.HopliteTaskWatch, callerThreadId]).pipe(
      Effect.flatMap(([watch, caller]) => watch.startTask(input, caller)),
      Effect.mapError(toFailure),
    ),
  ),
  hoplite_task_status: McpToolAccess.reads((input) =>
    HopliteCloud.HopliteCloud.pipe(
      Effect.flatMap((hoplite) => hoplite.getTask(input)),
      Effect.mapError(toFailure),
    ),
  ),
  hoplite_task_message: McpToolAccess.writesWithCapability((input) =>
    Effect.all([HopliteTaskWatch.HopliteTaskWatch, callerThreadId]).pipe(
      Effect.flatMap(([watch, caller]) => watch.sendMessage(input, caller)),
      Effect.mapError(toFailure),
    ),
  ),
  hoplite_task_stop: McpToolAccess.writesWithCapability((input) =>
    HopliteTaskWatch.HopliteTaskWatch.pipe(
      Effect.flatMap((watch) => watch.stopTask(input)),
      Effect.mapError(toFailure),
    ),
  ),
  hoplite_task_preview: McpToolAccess.writesWithCapability((input) =>
    HopliteCloud.HopliteCloud.pipe(
      Effect.flatMap((hoplite) => hoplite.preview(input)),
      Effect.mapError(toFailure),
    ),
  ),
} satisfies McpToolAccess.Handlers<typeof HopliteToolkit.tools>;

export const layer = McpToolAccess.toLayer(HopliteToolkit, handlers);
