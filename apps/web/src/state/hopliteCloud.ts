import { createHopliteCloudEnvironmentAtoms } from "@t3tools/client-runtime/state/hopliteCloud";

import { connectionAtomRuntime } from "../connection/runtime";

export const hopliteCloudEnvironment = createHopliteCloudEnvironmentAtoms(connectionAtomRuntime);
