import { useAtomValue } from "@effect/atom-react";
import type { HopliteCloudStatus } from "@t3tools/contracts";
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
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
  DialogTrigger,
} from "../ui/dialog";
import { HopliteIcon } from "../Icons";
import { SettingsRow, SettingsSection } from "./settingsLayout";

/**
 * Hoplite runs agents in cloud sandboxes. This machine keeps the API key and
 * starts the threads, so the key never comes back to a client once sent.
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
  const [apiKey, setApiKey] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A command answers with the new status before the query refetches it.
  const [latest, setLatest] = useState<HopliteCloudStatus | null>(null);
  const status = latest ?? query.data;

  if (environmentId === null || !canEdit) {
    return (
      <p className="text-xs text-muted-foreground">
        Connecting Hoplite needs settings access on this machine.
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
    setError(failure instanceof Error ? failure.message : "Hoplite could not be reached.");
    return false;
  };

  const errorAlert = error ? (
    <Alert variant="error">
      <AlertDescription>{error}</AlertDescription>
    </Alert>
  ) : null;

  if (status === null) {
    return <p className="text-xs text-muted-foreground">{query.error ?? "Checking Hoplite…"}</p>;
  }

  if (!status.connected) {
    return (
      <form
        className="space-y-3"
        onSubmit={async (event) => {
          event.preventDefault();
          const key = apiKey.trim();
          if (key === "" || pending) return;
          if (await run(() => connect({ environmentId, input: { apiKey: key } }))) setApiKey("");
        }}
      >
        <label className="block">
          <span className="mb-1.5 block text-xs font-medium text-foreground">Hoplite API key</span>
          <Input
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={apiKey}
            onChange={(event) => setApiKey(event.target.value)}
            placeholder="hop_…"
            disabled={pending}
          />
        </label>
        <p className="text-xs text-muted-foreground">
          Create an API key in Hoplite under Settings → Workspace → API keys. It's saved on this
          computer and never shown in the app again.
        </p>
        {errorAlert}
        <div className="flex justify-end">
          <Button type="submit" size="sm" disabled={pending || apiKey.trim() === ""}>
            {pending ? "Connecting…" : "Connect Hoplite"}
          </Button>
        </div>
      </form>
    );
  }

  return (
    <div className="space-y-3">
      {status.problem ? (
        <Alert variant="error">
          <AlertDescription>{status.problem}</AlertDescription>
        </Alert>
      ) : null}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span className="text-sm text-foreground">Connected</span>
        <Button
          size="sm"
          variant="outline"
          disabled={pending}
          onClick={() => void run(() => disconnect({ environmentId, input: {} }))}
        >
          Disconnect
        </Button>
      </div>
      {errorAlert}
    </div>
  );
}

/**
 * A connected Hoplite gets its own section: it delegates tasks rather than
 * pairing a machine, so it stays out of the paired environments list.
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
  if (status === null || !status.connected) return null;
  return (
    <SettingsSection id="hoplite-cloud" title="Cloud agents">
      <SettingsRow
        title={
          <span className="flex items-center gap-2">
            <HopliteIcon aria-hidden className="size-4" />
            Hoplite
          </span>
        }
        description={
          status.problem ??
          "Agents can send tasks to Hoplite to run in the cloud. Results come back to the chat."
        }
        control={
          <Dialog open={manageOpen} onOpenChange={setManageOpen}>
            <DialogTrigger render={<Button size="sm" variant="outline" />}>Manage</DialogTrigger>
            <DialogPopup className="sm:max-w-lg">
              <DialogHeader>
                <DialogTitle>Hoplite</DialogTitle>
                <DialogDescription>Your Hoplite key is connected.</DialogDescription>
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
