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
        : error.code === "model_unavailable"
          ? "model_unavailable"
          : error.code === "project_required" || error.code === "repo_unavailable"
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
  // These spend the controller's provider keys, so read-only clients and linked environments may not.
  cloud_task: McpToolAccess.writesWithCapability(
    ({
      threadId,
      questionId,
      dismiss,
      prompt,
      provider,
      model,
      title,
      repo,
      template,
      agent,
      clientRequestId,
    }) =>
      questionId !== undefined && threadId === undefined
        ? Effect.fail(
            new OrchestratorMcpFailure({
              code: "target_required",
              message: "Pass the threadId of the cloud task that asked the question.",
            }),
          )
        : Effect.all([HopliteTaskWatch.HopliteTaskWatch, callerThreadId]).pipe(
            Effect.flatMap(([watch, caller]) =>
              threadId === undefined
                ? watch.startTask(
                    {
                      prompt,
                      ...(provider === undefined ? {} : { provider }),
                      ...(model === undefined ? {} : { model }),
                      ...(title === undefined ? {} : { title }),
                      ...(repo === undefined ? {} : { repo }),
                      ...(template === undefined ? {} : { template }),
                      ...(agent === undefined ? {} : { agent }),
                      ...(clientRequestId === undefined ? {} : { clientRequestId }),
                    },
                    caller,
                  )
                : questionId !== undefined
                  ? watch.answerQuestion(
                      {
                        threadId,
                        questionId,
                        answer: prompt,
                        ...(dismiss === undefined ? {} : { dismiss }),
                        ...(clientRequestId === undefined ? {} : { clientRequestId }),
                      },
                      caller,
                    )
                  : watch.sendMessage(
                      {
                        threadId,
                        message: prompt,
                        ...(model === undefined ? {} : { model }),
                        ...(clientRequestId === undefined ? {} : { clientRequestId }),
                      },
                      caller,
                    ),
            ),
            Effect.mapError(toFailure),
          ),
  ),
  cloud_preview: McpToolAccess.writesWithCapability((input) =>
    HopliteCloud.HopliteCloud.pipe(
      Effect.flatMap((hoplite) => hoplite.preview(input)),
      Effect.mapError(toFailure),
    ),
  ),
  sandbox_create: McpToolAccess.writesWithCapability((input) =>
    HopliteCloud.HopliteCloud.pipe(
      Effect.flatMap((cloud) => cloud.createSandbox(input)),
      Effect.mapError(toFailure),
    ),
  ),
  sandbox_run: McpToolAccess.writesWithCapability((input) =>
    HopliteCloud.HopliteCloud.pipe(
      Effect.flatMap((cloud) => cloud.runInSandbox(input)),
      Effect.mapError(toFailure),
    ),
  ),
  sandbox_delete: McpToolAccess.writesWithCapability((input) =>
    HopliteCloud.HopliteCloud.pipe(
      Effect.flatMap((cloud) => cloud.deleteSandbox(input)),
      Effect.as({}),
      Effect.mapError(toFailure),
    ),
  ),
} satisfies McpToolAccess.Handlers<typeof HopliteToolkit.tools>;

export const layer = McpToolAccess.toLayer(HopliteToolkit, handlers);
