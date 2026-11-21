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
import { T, useGT, useMessages } from "gt-react";
import { useState } from "react";

import { usePrimaryEnvironmentId } from "~/state/environments";
import { hopliteCloudEnvironment } from "~/state/hopliteCloud";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { ConnectionStatusDot } from "../ConnectionStatusDot";
import { Alert, AlertDescription } from "../ui/alert";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Skeleton } from "../ui/skeleton";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
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
function HopliteCloudSetup({ provider }: { provider: CloudSandboxProvider }) {
  const gt = useGT();
  const m = useMessages();
  const environmentId = usePrimaryEnvironmentId();
  const canEdit = useAtomValue(hopliteCloudEnvironment.connect.permissionAtom(environmentId));
  const query = useEnvironmentQuery(
    environmentId !== null && canEdit
      ? hopliteCloudEnvironment.status({ environmentId, input: {} })
      : null,
  );
  const connect = useAtomCommand(hopliteCloudEnvironment.connect, { reportFailure: false });
  const disconnect = useAtomCommand(hopliteCloudEnvironment.disconnect, { reportFailure: false });
  const [apiKey, setApiKey] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A command answers with the new status before the query refetches it.
  const [latest, setLatest] = useState<HopliteCloudStatus | null>(null);
  const status = latest ?? query.data;

  if (environmentId === null || !canEdit) {
    return (
      <p className="text-xs text-muted-foreground">
        <T>Connecting a cloud sandbox needs settings access on this machine.</T>
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
    setError(failure instanceof Error ? failure.message : gt("The provider could not be reached."));
    return false;
  };

  if (status === null) {
    return (
      <p className="text-xs text-muted-foreground">
        {query.error ?? gt("Checking cloud sandboxes…")}
      </p>
    );
  }

  const statuses = providerStatuses(status);
  const connected = statuses.filter((entry) => entry.connected && entry.provider === provider);
  const selected = cloudSandboxProviderInfo(provider);
  const selectedStatus = statuses.find((entry) => entry.provider === provider);

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
                    {gt("{provider} connected", { provider: info.name })}
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
                    <T>Disconnect</T>
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
        <label className="block">
          <span className="mb-1.5 block text-xs font-medium text-foreground">
            {gt("{provider} API key", { provider: selected.name })}
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
          {gt("{help} It''s saved on this computer and never shown in the app again.", {
            help: m(selected.keyHelp),
          })}
        </p>
        {error ? (
          <Alert variant="error">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}
        <div className="flex justify-end">
          <Button type="submit" size="sm" disabled={pending || apiKey.trim() === ""}>
            {pending
              ? gt("Connecting…")
              : selectedStatus?.connected
                ? gt("Replace {provider} key", { provider: selected.name })
                : gt("Connect {provider}", { provider: selected.name })}
          </Button>
        </div>
      </form>
    </div>
  );
}

/**
 * Cloud sandboxes get their own section: they take tasks rather than
 * pairing a machine, so they stay out of the paired environments list.
 */
export function HopliteCloudSection() {
  const gt = useGT();
  const environmentId = usePrimaryEnvironmentId();
  const canEdit = useAtomValue(hopliteCloudEnvironment.connect.permissionAtom(environmentId));
  const query = useEnvironmentQuery(
    environmentId !== null && canEdit
      ? hopliteCloudEnvironment.status({ environmentId, input: {} })
      : null,
  );
  const [selectedProvider, setSelectedProvider] = useState<CloudSandboxProvider | null>(null);
  const status = query.data;
  const statuses = status === null ? [] : providerStatuses(status);
  // Older servers expose only the providers they support.
  const offered = CLOUD_SANDBOX_PROVIDERS.filter((provider) =>
    statuses.some((entry) => entry.provider === provider.id),
  );
  const canConfigure = environmentId !== null && canEdit;
  return (
    <SettingsSection id="hoplite-cloud" title={gt("Cloud sandboxes")}>
      {!canConfigure ? (
        <SettingsRow
          title={gt("Connecting a cloud sandbox needs settings access on this machine.")}
        />
      ) : status === null ? (
        query.error ? (
          <SettingsRow title={query.error} />
        ) : (
          CLOUD_SANDBOX_PROVIDERS.map((provider) => (
            <SettingsRow
              key={provider.id}
              title={<Skeleton className="h-4 w-24" />}
              description={<Skeleton className="h-3 w-32" />}
              control={<Skeleton className="h-7 w-20" />}
            />
          ))
        )
      ) : (
        offered.map((provider) => {
          const entry = statuses.find((candidate) => candidate.provider === provider.id);
          return (
            <SettingsRow
              key={provider.id}
              title={
                <span className="flex items-center gap-2">
                  <CloudSandboxProviderMarks providers={[provider]} />
                  {provider.name}
                </span>
              }
              description={
                entry?.problem ?? (
                  <span className="flex items-center gap-1.5">
                    {entry?.connected ? <ConnectionStatusDot dotClassName="bg-success" /> : null}
                    {entry?.connected ? gt("Connected") : gt("Not connected")}
                  </span>
                )
              }
              control={
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setSelectedProvider(provider.id)}
                >
                  {entry?.connected ? gt("Manage") : gt("Connect")}
                </Button>
              }
            />
          );
        })
      )}
      <Dialog
        open={selectedProvider !== null}
        onOpenChange={(open) => {
          if (!open) {
            setSelectedProvider(null);
            query.refresh();
          }
        }}
      >
        <DialogPopup className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>
              {selectedProvider === null
                ? gt("Cloud sandboxes")
                : cloudSandboxProviderInfo(selectedProvider).name}
            </DialogTitle>
            <DialogDescription>
              <T>Keys stay on this machine.</T>
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            {selectedProvider === null ? null : (
              <HopliteCloudSetup key={selectedProvider} provider={selectedProvider} />
            )}
          </DialogPanel>
        </DialogPopup>
      </Dialog>
    </SettingsSection>
  );
}
