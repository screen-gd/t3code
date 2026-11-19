import { useAtomValue } from "@effect/atom-react";
import type {
  CloudSandboxProvider,
  CloudSandboxProviderStatus,
  HopliteCloudStatus,
} from "@t3tools/contracts";
import {
  type AtomCommandResult,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { useState } from "react";

import { usePrimaryEnvironmentId } from "~/state/environments";
import { hopliteCloudEnvironment } from "~/state/hopliteCloud";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { Alert, AlertDescription } from "../ui/alert";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
  DialogTrigger,
} from "../ui/dialog";
import {
  CLOUD_SANDBOX_PROVIDERS,
  CloudSandboxProviderMark,
  CloudSandboxProviderMarks,
  cloudSandboxProviderInfo,
} from "../CloudSandboxLogos";
import { SettingsRow, SettingsSection } from "./settingsLayout";

// An older server reports only Hoplite.
const providerStatuses = (status: HopliteCloudStatus): ReadonlyArray<CloudSandboxProviderStatus> =>
  status.providers ?? [
    { provider: "hoplite", connected: status.connected, problem: status.problem },
  ];

/**
 * Cloud sandbox providers run agents in their own sandboxes. This machine keeps each
 * provider's API key and starts the tasks, so a key never comes back to a client once sent.
 */
export function HopliteCloudSetup() {
  const environmentId = usePrimaryEnvironmentId();
  const canEdit = useAtomValue(hopliteCloudEnvironment.connect.permissionAtom(environmentId));
  const query = useEnvironmentQuery(
    environmentId !== null && canEdit
      ? hopliteCloudEnvironment.status({ environmentId, input: {} })
      : null,
  );
  const connect = useAtomCommand(hopliteCloudEnvironment.connect, { reportFailure: false });
  const disconnect = useAtomCommand(hopliteCloudEnvironment.disconnect, { reportFailure: false });
  const [provider, setProvider] = useState<CloudSandboxProvider>("hoplite");
  const [apiKey, setApiKey] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A command answers with the new status before the query refetches it.
  const [latest, setLatest] = useState<HopliteCloudStatus | null>(null);
  const status = latest ?? query.data;

  if (environmentId === null || !canEdit) {
    return (
      <p className="text-xs text-muted-foreground">
        Connecting a cloud sandbox needs settings access on this machine.
      </p>
    );
  }

  const run = async (command: () => Promise<AtomCommandResult<HopliteCloudStatus, unknown>>) => {
    setPending(true);
    setError(null);
    const result = await command();
    setPending(false);
    if (result._tag === "Success") {
      setLatest(result.value);
      query.refresh();
      return true;
    }
    const failure = squashAtomCommandFailure(result);
    setError(failure instanceof Error ? failure.message : "The provider could not be reached.");
    return false;
  };

  if (status === null) {
    return (
      <p className="text-xs text-muted-foreground">{query.error ?? "Checking cloud sandboxes…"}</p>
    );
  }

  const statuses = providerStatuses(status);
  const connected = statuses.filter((entry) => entry.connected);
  const selected = cloudSandboxProviderInfo(provider);
  const selectedStatus = statuses.find((entry) => entry.provider === provider);
  // Older servers take a key for Hoplite only.
  const offered =
    status.providers === undefined
      ? CLOUD_SANDBOX_PROVIDERS.filter((entry) => entry.id === "hoplite")
      : CLOUD_SANDBOX_PROVIDERS;

  return (
    <div className="space-y-4">
      {connected.length > 0 ? (
        <ul className="space-y-2">
          {connected.map((entry) => {
            const info = cloudSandboxProviderInfo(entry.provider);
            return (
              <li key={entry.provider} className="space-y-1.5">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <span className="flex items-center gap-2 text-sm text-foreground">
                    <CloudSandboxProviderMark provider={info} />
                    {info.name} connected
                  </span>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={pending}
                    onClick={() =>
                      void run(() =>
                        disconnect({ environmentId, input: { provider: entry.provider } }),
                      )
                    }
                  >
                    Disconnect
                  </Button>
                </div>
                {entry.problem ? (
                  <Alert variant="error">
                    <AlertDescription>{entry.problem}</AlertDescription>
                  </Alert>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}
      <form
        className="space-y-3"
        onSubmit={async (event) => {
          event.preventDefault();
          const key = apiKey.trim();
          if (key === "" || pending) return;
          if (await run(() => connect({ environmentId, input: { provider, apiKey: key } }))) {
            setApiKey("");
          }
        }}
      >
        {offered.length > 1 ? (
          <div>
            <span className="mb-1.5 block text-xs font-medium text-foreground">Provider</span>
            <ToggleGroup
              aria-label="Provider"
              variant="segmented"
              value={[provider]}
              onValueChange={(next) => {
                const value = offered.find((entry) => entry.id === next[0]);
                if (value) setProvider(value.id);
              }}
            >
              {offered.map((entry) => (
                <Toggle key={entry.id} value={entry.id} disabled={pending}>
                  <CloudSandboxProviderMark provider={entry} className="size-3.5" />
                  {entry.name}
                </Toggle>
              ))}
            </ToggleGroup>
          </div>
        ) : null}
        <label className="block">
          <span className="mb-1.5 block text-xs font-medium text-foreground">
            {selected.name} API key
          </span>
          <Input
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={apiKey}
            onChange={(event) => setApiKey(event.target.value)}
            placeholder={selected.keyPlaceholder}
            disabled={pending}
          />
        </label>
        <p className="text-xs text-muted-foreground">
          {selected.keyHelp} It's saved on this computer and never shown in the app again.
        </p>
        {error ? (
          <Alert variant="error">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}
        <div className="flex justify-end">
          <Button type="submit" size="sm" disabled={pending || apiKey.trim() === ""}>
            {pending
              ? "Connecting…"
              : selectedStatus?.connected
                ? `Replace ${selected.name} key`
                : `Connect ${selected.name}`}
          </Button>
        </div>
      </form>
    </div>
  );
}

/**
 * Connected cloud sandboxes get their own section: they take tasks rather than
 * pairing a machine, so they stay out of the paired environments list.
 */
export function HopliteCloudSection() {
  const environmentId = usePrimaryEnvironmentId();
  const canEdit = useAtomValue(hopliteCloudEnvironment.connect.permissionAtom(environmentId));
  const query = useEnvironmentQuery(
    environmentId !== null && canEdit
      ? hopliteCloudEnvironment.status({ environmentId, input: {} })
      : null,
  );
  const [manageOpen, setManageOpen] = useState(false);
  const status = query.data;
  const connected =
    status === null ? [] : providerStatuses(status).filter((entry) => entry.connected);
  if (connected.length === 0) return null;
  const infos = connected.map((entry) => cloudSandboxProviderInfo(entry.provider));
  const problem = connected.find((entry) => entry.problem !== null)?.problem;
  return (
    <SettingsSection id="hoplite-cloud" title="Cloud agents">
      <SettingsRow
        title={
          <span className="flex items-center gap-2">
            <CloudSandboxProviderMarks providers={infos} />
            {infos.map((info) => info.name).join(", ")}
          </span>
        }
        description={
          problem ??
          "Agents can send tasks to these cloud sandboxes. Results come back to the chat."
        }
        control={
          <Dialog open={manageOpen} onOpenChange={setManageOpen}>
            <DialogTrigger render={<Button size="sm" variant="outline" />}>Manage</DialogTrigger>
            <DialogPopup className="sm:max-w-lg">
              <DialogHeader>
                <DialogTitle>Cloud sandboxes</DialogTitle>
                <DialogDescription>Keys stay on this machine.</DialogDescription>
              </DialogHeader>
              <DialogPanel>
                <HopliteCloudSetup />
              </DialogPanel>
            </DialogPopup>
          </Dialog>
        }
      />
    </SettingsSection>
  );
}
