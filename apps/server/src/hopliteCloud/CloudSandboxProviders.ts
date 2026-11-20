import type { CloudSandboxProvider } from "@t3tools/contracts";

export const PROVIDER_NAMES: Record<CloudSandboxProvider, string> = {
  hoplite: "Hoplite",
};

/** Every task is a Hoplite thread, named by its bare thread id. */
export const providerOfTask = (
  taskId: string,
): { readonly provider: CloudSandboxProvider; readonly id: string } => ({
  provider: "hoplite",
  id: taskId,
});
