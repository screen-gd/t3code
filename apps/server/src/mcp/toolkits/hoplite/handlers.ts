import { type HopliteCloudError, OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as HopliteCloud from "../../../hopliteCloud/HopliteCloudService.ts";
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

const handlers = {
  // Spends the controller's Hoplite key, so read-only clients and linked environments may not.
  hoplite_task_start: McpToolAccess.writesWithCapability((input) =>
    HopliteCloud.HopliteCloud.pipe(
      Effect.flatMap((hoplite) => hoplite.startTask(input)),
      Effect.mapError(toFailure),
    ),
  ),
  hoplite_task_status: McpToolAccess.reads((input) =>
    HopliteCloud.HopliteCloud.pipe(
      Effect.flatMap((hoplite) => hoplite.getTask(input)),
      Effect.mapError(toFailure),
    ),
  ),
} satisfies McpToolAccess.Handlers<typeof HopliteToolkit.tools>;

export const layer = McpToolAccess.toLayer(HopliteToolkit, handlers);
