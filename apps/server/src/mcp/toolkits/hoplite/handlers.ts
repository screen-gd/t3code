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
  // These spend the controller's Hoplite key, so read-only clients and linked environments may not.
  hoplite_task: McpToolAccess.writesWithCapability(
    ({ threadId, questionId, prompt, title, projectId, repo, clientRequestId }) =>
      questionId !== undefined && threadId === undefined
        ? Effect.fail(
            new OrchestratorMcpFailure({
              code: "target_required",
              message: "Pass the threadId of the Hoplite task that asked the question.",
            }),
          )
        : Effect.all([HopliteTaskWatch.HopliteTaskWatch, callerThreadId]).pipe(
            Effect.flatMap(([watch, caller]) =>
              threadId === undefined
                ? watch.startTask(
                    {
                      prompt,
                      ...(title === undefined ? {} : { title }),
                      ...(projectId === undefined ? {} : { projectId }),
                      ...(repo === undefined ? {} : { repo }),
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
                        ...(clientRequestId === undefined ? {} : { clientRequestId }),
                      },
                      caller,
                    )
                  : watch.sendMessage(
                      {
                        threadId,
                        message: prompt,
                        ...(clientRequestId === undefined ? {} : { clientRequestId }),
                      },
                      caller,
                    ),
            ),
            Effect.mapError(toFailure),
          ),
  ),
  hoplite_preview: McpToolAccess.writesWithCapability((input) =>
    HopliteCloud.HopliteCloud.pipe(
      Effect.flatMap((hoplite) => hoplite.preview(input)),
      Effect.mapError(toFailure),
    ),
  ),
  // Reading still spends the key's rate limit, so it is held to the same callers.
  hoplite_activity: McpToolAccess.writesWithCapability((input) =>
    HopliteCloud.HopliteCloud.pipe(
      Effect.flatMap((hoplite) => hoplite.activity(input)),
      Effect.mapError(toFailure),
    ),
  ),
} satisfies McpToolAccess.Handlers<typeof HopliteToolkit.tools>;

export const layer = McpToolAccess.toLayer(HopliteToolkit, handlers);
