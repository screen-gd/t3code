import type { CloudSandboxProvider } from "@t3tools/contracts";

import { msg } from "gt-react";
import { CloudIcon } from "lucide-react";

import { cn } from "~/lib/utils";
import { Agent37Icon, DaytonaIcon, E2BIcon, HopliteIcon, type Icon } from "./Icons";

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
    id: "devin",
    name: "Devin Cloud",
    icon: CloudIcon,
    keyPlaceholder: "",
    keyHelp: msg(
      "Uses the Devin CLI login on this environment. Install Devin and run `devin auth login` first.",
    ),
  },
  {
    id: "hoplite",
    name: "Hoplite",
    icon: HopliteIcon,
    keyPlaceholder: "hop_…",
    keyHelp: msg("Create a key in Hoplite under Settings → Workspace → API keys."),
  },
  {
    id: "e2b",
    name: "E2B",
    icon: E2BIcon,
    keyPlaceholder: "e2b_…",
    keyHelp: msg("Create a key in the E2B dashboard under Keys."),
  },
  {
    id: "daytona",
    name: "Daytona",
    icon: DaytonaIcon,
    keyPlaceholder: "dtn_…",
    keyHelp: msg("Create a key in the Daytona dashboard under Keys."),
  },
  {
    id: "agent37",
    name: "Agent37",
    icon: Agent37Icon,
    keyPlaceholder: "sk_live_…",
    keyHelp: msg("Create a key in the Agent37 dashboard under Cloud → API keys."),
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
        (provider.id === "hoplite" || provider.id === "e2b") && "overflow-hidden rounded-sm",
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
