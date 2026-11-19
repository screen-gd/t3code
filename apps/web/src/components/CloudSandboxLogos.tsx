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

/** A provider's mark at its natural shape; Hoplite's is an app tile, so it gets tile corners. */
export function CloudSandboxProviderMark({
  provider,
  className,
}: {
  provider: CloudSandboxProviderInfo;
  className?: string;
}) {
  const ProviderIcon = provider.icon;
  return (
    <ProviderIcon
      aria-hidden
      className={cn(
        "size-4 shrink-0 opacity-100",
        provider.id === "hoplite" && "overflow-hidden rounded-sm",
        className,
      )}
    />
  );
}

/** The providers' marks side by side. */
export function CloudSandboxProviderMarks({
  providers = CLOUD_SANDBOX_PROVIDERS,
  className,
}: {
  providers?: ReadonlyArray<CloudSandboxProviderInfo>;
  className?: string;
}) {
  return (
    <span
      aria-label={providers.map((provider) => provider.name).join(", ")}
      className={cn("flex items-center gap-1", className)}
    >
      {providers.map((provider) => (
        <CloudSandboxProviderMark key={provider.id} provider={provider} />
      ))}
    </span>
  );
}
