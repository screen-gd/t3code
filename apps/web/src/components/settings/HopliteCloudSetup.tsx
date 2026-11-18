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
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SettingsRow } from "./settingsLayout";

const NO_DEFAULT_PROJECT = "__none__";

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
  const setDefaultProject = useAtomCommand(hopliteCloudEnvironment.setDefaultProject, {
    reportFailure: false,
  });
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
          Create a service account key in Hoplite under Settings → Workspace → API keys, with
          project read and thread write access. It is stored on this machine, not in this client.
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
        <span className="text-sm text-foreground">
          Connected · {status.projects.length}{" "}
          {status.projects.length === 1 ? "project" : "projects"}
        </span>
        <Select
          value={status.defaultProjectId ?? NO_DEFAULT_PROJECT}
          disabled={pending || status.projects.length === 0}
          onValueChange={(value) => {
            if (value === null) return;
            void run(() =>
              setDefaultProject({
                environmentId,
                input: { projectId: value === NO_DEFAULT_PROJECT ? null : value },
              }),
            );
          }}
        >
          <SelectTrigger aria-label="Default Hoplite project" className="min-w-48" size="sm">
            <SelectValue>
              {status.projects.find((project) => project.id === status.defaultProjectId)?.name ??
                "No default project"}
            </SelectValue>
          </SelectTrigger>
          <SelectPopup>
            <SelectItem value={NO_DEFAULT_PROJECT}>No default project</SelectItem>
            {status.projects.map((project) => (
              <SelectItem key={project.id} value={project.id}>
                {project.name}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      </div>
      <p className="text-xs text-muted-foreground">
        Agents can hand a task to a Hoplite cloud thread in the default project. Each thread runs in
        its own sandbox with that project's repository.
      </p>
      {errorAlert}
      <div className="flex justify-end">
        <Button
          size="sm"
          variant="outline"
          disabled={pending}
          onClick={() => void run(() => disconnect({ environmentId, input: {} }))}
        >
          Disconnect
        </Button>
      </div>
    </div>
  );
}

/** Lists a connected Hoplite under Environments, where users look for it after connecting. */
export function HopliteCloudRow({ onManage }: { readonly onManage: () => void }) {
  const environmentId = usePrimaryEnvironmentId();
  const canEdit = useAtomValue(hopliteCloudEnvironment.connect.permissionAtom(environmentId));
  const query = useEnvironmentQuery(
    environmentId !== null && canEdit
      ? hopliteCloudEnvironment.status({ environmentId, input: {} })
      : null,
  );
  const status = query.data;
  if (status === null || !status.connected) return null;
  const project = status.projects.find((candidate) => candidate.id === status.defaultProjectId);
  return (
    <SettingsRow
      title="Hoplite cloud"
      description={
        status.problem ??
        `Ask an agent to run a task in Hoplite. It runs in a cloud sandbox${project ? ` with ${project.name}` : ""} and reports back to the thread.`
      }
      control={
        <Button size="sm" variant="outline" onClick={onManage}>
          Manage
        </Button>
      }
    />
  );
}
