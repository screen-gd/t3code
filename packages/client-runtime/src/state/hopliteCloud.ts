import { WS_METHODS } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { createEnvironmentRpcCommand, createEnvironmentRpcQueryAtomFamily } from "./runtime.ts";

export function createHopliteCloudEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const settingsWrite = {
    mode: "singleFlight",
    key: ({ environmentId }: { readonly environmentId: string }) => environmentId,
  } as const;
  return {
    status: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:hoplite-cloud:status",
      tag: WS_METHODS.hopliteCloudGetStatus,
    }),
    connect: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:hoplite-cloud:connect",
      tag: WS_METHODS.hopliteCloudConnect,
      concurrency: settingsWrite,
    }),
    disconnect: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:hoplite-cloud:disconnect",
      tag: WS_METHODS.hopliteCloudDisconnect,
      concurrency: settingsWrite,
    }),
    setDefaultProject: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:hoplite-cloud:set-default-project",
      tag: WS_METHODS.hopliteCloudSetDefaultProject,
      concurrency: settingsWrite,
    }),
  };
}
