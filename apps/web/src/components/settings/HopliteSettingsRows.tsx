import { HOPLITE_ACP_AGENT_ID } from "@t3tools/contracts";
import { T } from "gt-react";

import { hopliteProjectId, withHopliteProjectId } from "./AddProviderInstanceDialog.logic";
import { DraftInput } from "../ui/draft-input";
import { SettingsRow } from "./settingsLayout";

interface HopliteSettingsRowsProps {
  readonly value: Readonly<Record<string, unknown>>;
  readonly onChange: (next: Record<string, unknown>) => void;
  readonly idPrefix: string;
  readonly disabled?: boolean | undefined;
}

/**
 * Hoplite's only settings: a pinned project and the CLI it runs. Shared by the
 * Add provider wizard's Config step and provider settings' Runtime section, so
 * Hoplite stays a normal local acpRegistry instance without argument editing.
 */
export function HopliteSettingsRows({
  value,
  onChange,
  idPrefix,
  disabled = false,
}: HopliteSettingsRowsProps) {
  const commandArgs = Array.isArray(value.commandArgs)
    ? value.commandArgs.filter((arg): arg is string => typeof arg === "string")
    : [];
  const commandPath = typeof value.commandPath === "string" ? value.commandPath : "";
  return (
    <>
      <SettingsRow
        title={
          <label htmlFor={`${idPrefix}-project`}>
            <T>Hoplite project ID</T>
          </label>
        }
        description={
          <span id={`${idPrefix}-project-description`}>
            <T>
              Optional. Without it, Hoplite uses the project linked to each thread's repository.
            </T>
          </span>
        }
        control={
          <DraftInput
            id={`${idPrefix}-project`}
            aria-describedby={`${idPrefix}-project-description`}
            size="sm"
            className="w-full @min-[32rem]/settings-row:w-56"
            value={hopliteProjectId(commandArgs)}
            onCommit={(projectId) =>
              onChange({
                ...value,
                agentId: HOPLITE_ACP_AGENT_ID,
                commandArgs: withHopliteProjectId(commandArgs, projectId),
              })
            }
            disabled={disabled}
            spellCheck={false}
          />
        }
      />
      <SettingsRow
        title={
          <label htmlFor={`${idPrefix}-cli`}>
            <T>Binary path</T>
          </label>
        }
        description={
          <span id={`${idPrefix}-cli-description`}>
            <T>Path to the Hoplite binary used by this instance.</T>
          </span>
        }
        control={
          <DraftInput
            id={`${idPrefix}-cli`}
            aria-describedby={`${idPrefix}-cli-description`}
            size="sm"
            className="w-full @min-[32rem]/settings-row:w-56"
            value={commandPath}
            placeholder="hoplite"
            onCommit={(next) => {
              const trimmed = next.trim();
              onChange({
                ...value,
                agentId: HOPLITE_ACP_AGENT_ID,
                commandPath: trimmed.length > 0 ? trimmed : "hoplite",
              });
            }}
            disabled={disabled}
            spellCheck={false}
          />
        }
      />
    </>
  );
}
