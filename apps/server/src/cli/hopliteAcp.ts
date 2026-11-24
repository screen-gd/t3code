import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeSocket from "@effect/platform-node/NodeSocket";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import { Command } from "effect/cli";

import { runHopliteAcpBridge } from "../hopliteCloud/HopliteAcpBridge.ts";

export const hopliteAcpCommand = Command.make("hoplite-acp").pipe(
  Command.withDescription("Connect an ACP client to Hoplite's cloud agent."),
  Command.unlisted,
  Command.withHandler(() =>
    runHopliteAcpBridge.pipe(
      Effect.scoped,
      Effect.provide(Layer.merge(NodeHttpClient.layerUndici, NodeSocket.layerWebSocketConstructor)),
    ),
  ),
);

/** The bridge's stdout is ACP only; connection errors never print requests or credentials. */
export async function runHopliteAcpCli(args: ReadonlyArray<string>) {
  const program = Command.runWith(hopliteAcpCommand, { version: "0.0.0" })(args).pipe(
    Effect.provide(NodeServices.layer),
  );
  const result = await Effect.runPromiseExit(program);
  if (Exit.isFailure(result)) {
    process.stderr.write(
      "Hoplite connection failed. Connect Hoplite in Settings > Environments and check this repository is set up in Hoplite.\n",
    );
    process.exitCode = 1;
  }
}
