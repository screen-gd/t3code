import type { CloudSandboxProvider } from "@t3tools/contracts";

import { cn } from "~/lib/utils";
import { DevinIcon, HopliteIcon, type Icon, JulesIcon } from "./Icons";

export interface CloudSandboxProviderInfo {
  readonly id: CloudSandboxProvider;
  readonly name: string;
  readonly icon: Icon;
  readonly keyPlaceholder: string;
  /** Where the user creates the key in that provider. */
  readonly keyHelp: string;
}

/** Every cloud sandbox provider the server can hold a key for, in the order shown. */
export const CLOUD_SANDBOX_PROVIDERS: ReadonlyArray<CloudSandboxProviderInfo> = [
  {
    id: "hoplite",
    name: "Hoplite",
    icon: HopliteIcon,
    keyPlaceholder: "hop_…",
    keyHelp: "Create a key in Hoplite under Settings → Workspace → API keys.",
  },
  {
    id: "devin",
    name: "Devin",
    icon: DevinIcon,
    keyPlaceholder: "apk_…",
    keyHelp: "Create a key in Devin under Settings → API keys.",
  },
  {
    id: "jules",
    name: "Jules",
    icon: JulesIcon,
    keyPlaceholder: "Jules API key",
    keyHelp: "Create a key in Jules under Settings → API keys.",
  },
];

export const cloudSandboxProviderInfo = (id: CloudSandboxProvider): CloudSandboxProviderInfo =>
  CLOUD_SANDBOX_PROVIDERS.find((provider) => provider.id === id) ?? CLOUD_SANDBOX_PROVIDERS[0]!;

/** The providers' logos, overlapped in a small stack. */
export function CloudSandboxLogoStack({
  providers = CLOUD_SANDBOX_PROVIDERS,
  className,
}: {
  providers?: ReadonlyArray<CloudSandboxProviderInfo>;
  className?: string;
}) {
  return (
    <span
      aria-label={providers.map((provider) => provider.name).join(", ")}
      className={cn("flex items-center -space-x-1.5", className)}
    >
      {providers.map(({ id, icon: ProviderIcon }) => (
        <span
          key={id}
          className="inline-flex size-5 items-center justify-center overflow-hidden rounded-full bg-white ring-2 ring-background"
        >
          <ProviderIcon aria-hidden className="size-3.5" />
        </span>
      ))}
    </span>
  );
}
