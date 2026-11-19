import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import { m as resolveMessage } from "~/i18n/messages";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";

import { Radio as RadioPrimitive } from "@base-ui/react/radio";
import { CheckIcon, ChevronDownIcon } from "lucide-react";
import { useState } from "react";
import { msg, T, useGT, useMessages, Var } from "gt-react";
import type { MessageResolver } from "../../i18n/messages";
import {
  deriveAvailableInstanceId,
  deriveInstanceId,
} from "@t3tools/client-runtime/provider-instance-ids";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { ProviderClientDefinition } from "@t3tools/provider-core/client";
import {
  type AcpRegistrySearchAgent,
  AuthProvidersManageScope,
  HOPLITE_ACP_AGENT_ID,
  ProviderInstanceId,
  ProviderDriverKind,
  type EnvironmentId,
  type ProviderInstanceConfig,
  type ProviderInstanceEnvironmentVariable,
  isManagedDriverAllowed,
} from "@t3tools/contracts";

import {
  useEnvironmentSettings,
  usePersistEnvironmentProviderInstanceMutation,
} from "../../hooks/useSettings";

import { cn } from "../../lib/utils";
import { normalizeProviderAccentColor } from "../../providerInstances";
import { managedInstanceLocks, useManagedPolicy } from "../../state/managedPolicy";
import { readEnvironmentScope, useEnvironmentScope } from "../../state/session";
import { Button } from "../ui/button";
import { ChatGptConnectionButton } from "./ChatGptConnectionButton";
import { Dialog } from "../ui/dialog";
import { Badge } from "../ui/badge";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { Input } from "../ui/input";
import { RadioGroup } from "../ui/radio-group";
import { toastManager } from "../ui/toast";
import { providerClients } from "./providerDriverMeta";
import { ProviderAccentColorPicker } from "./ProviderAccentColorPicker";
import { HopliteSettingsRows } from "./HopliteSettingsRows";
import { SettingsGroup } from "./SettingsGroup";
import { SettingsRow } from "./settingsLayout";
import { ProviderSettingsForm, deriveProviderSettingsFields } from "./ProviderSettingsForm";
import { WizardPanel, WizardPopup, WizardHeader, WizardFooter } from "../ui/wizard";
import {
  ADD_PROVIDER_WIZARD_STEPS,
  ACP_REGISTRY_WIZARD_STEPS,
  HOPLITE_LABEL,
  HOPLITE_LOCAL_ACP_CONFIG,
  HOPLITE_PROVIDER_CHOICE,
  HOPLITE_WIZARD_STEPS,
  LOCAL_ACP_WIZARD_STEPS,
  hopliteProjectId,
  resolveAcpRegistryWizardNavigation,
  resolveWizardNavigation,
  updateProviderIdentityDraft,
  type ProviderIdentityDraft,
  type WizardNavigation,
} from "./AddProviderInstanceDialog.logic";
import { AddProviderInstanceWizardSteps } from "./AddProviderInstanceWizardSteps";
import { AcpRegistrySearchStep, useAcpRegistrySearch } from "./AcpRegistrySearchStep";
import { ProviderWizardAuthenticationStep } from "./ProviderWizardAuthenticationStep";
import { resolveOfficialAcpRegistryIconUrl } from "./AcpRegistryIcon";
import { AddManagedCodexAccountDialog } from "./CodexSetupSection";
import { MultipleAccountsNote } from "./MultipleAccountsNote";
import { ProviderEnvironmentSection } from "./ProviderInstanceCard";
import { useSecretSources } from "./SecretSourceInput";

const INSTANCE_ID_PATTERN = /^[a-zA-Z][a-zA-Z0-9_-]*$/;
const DEFAULT_DRIVER_KIND = ProviderDriverKind.make("codex");
const ACP_REGISTRY_DRIVER_KIND = ProviderDriverKind.make("acpRegistry");
const DEFAULT_DRIVER_OPTION = providerClients.definitions[0]!;
const DRIVER_OPTIONS = providerClients.definitions.filter(
  (option) => option.driverKind !== ACP_REGISTRY_DRIVER_KIND,
);
const FEATURED_DRIVER_OPTIONS = DRIVER_OPTIONS.filter((option) => option.featured !== false);
const MORE_DRIVER_OPTIONS = DRIVER_OPTIONS.filter((option) => option.featured === false);
const EMPTY_CONFIG_DRAFT: Record<string, unknown> = {};
function validateInstanceId(
  id: string,
  existing: ReadonlySet<string>,
  resolve: MessageResolver,
): string | null {
  if (id.length === 0) return resolve(msg("Instance ID is required."));
  if (id.length > 64) return resolve(msg("Instance ID must be 64 characters or fewer."));
  if (!INSTANCE_ID_PATTERN.test(id)) {
    return resolve(
      msg("Instance ID must start with a letter and use only letters, digits, '-', or '_'."),
    );
  }
  if (existing.has(id)) return resolve(msg("An instance named ''{id}'' already exists.", { id }));
  return null;
}

/** A card in the Add provider grid; most map a driver kind, Hoplite is its own choice. */
interface ProviderGridOption {
  readonly value: string;
  readonly label: string;
  readonly driverKind: ProviderDriverKind;
  readonly acpRegistryAgentId?: string | undefined;
  readonly badgeLabel?: string | undefined;
}

function ProviderOptionGrid({
  options,
  value,
  disabled,
  onValueChange,
  ...labelProps
}: {
  readonly options: ReadonlyArray<ProviderGridOption>;
  readonly value: string;
  readonly disabled: boolean;
  readonly onValueChange: (value: string) => void;
  readonly "aria-label"?: string;
  readonly "aria-labelledby"?: string;
}) {
  return (
    <RadioGroup
      {...labelProps}
      disabled={disabled}
      value={value}
      onValueChange={onValueChange}
      className="grid grid-cols-1 sm:grid-cols-2"
    >
      {options.map((option) => (
        <RadioPrimitive.Root
          key={option.value}
          value={option.value}
          className="relative flex cursor-pointer items-center gap-3 rounded-lg bg-card px-3 py-3 text-left text-muted-foreground outline-none ring-1 ring-black/5 hover:bg-muted focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring data-checked:bg-primary/8 data-checked:text-foreground data-checked:ring-2 data-checked:ring-inset data-checked:ring-primary data-checked:hover:bg-primary/8 dark:bg-white/3 dark:ring-white/5 dark:hover:bg-white/5 dark:data-checked:bg-primary/15 dark:data-checked:ring-primary dark:data-checked:hover:bg-primary/15"
        >
          <ProviderInstanceIcon
            driverKind={option.driverKind}
            displayName={option.label}
            acpRegistryAgentId={option.acpRegistryAgentId}
            iconClassName="size-4"
          />
          <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
            {option.label}
          </span>
          <RadioPrimitive.Indicator
            className="grid size-5 shrink-0 place-items-center rounded-full bg-primary text-primary-foreground"
            aria-hidden
          >
            <CheckIcon className="size-3.5 shrink-0" />
          </RadioPrimitive.Indicator>
          {option.badgeLabel ? (
            <Badge variant="warning" size="sm">
              {option.badgeLabel}
            </Badge>
          ) : null}
        </RadioPrimitive.Root>
      ))}
    </RadioGroup>
  );
}

interface AddProviderInstanceDialogProps {
  readonly open: boolean;
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly onOpenChange: (open: boolean) => void;
  readonly onCreated?: (instanceId: ProviderInstanceId, driver: ProviderDriverKind) => void;
  /** Opens with "Show more" expanded, so the ACP Registry search is in view. */
  readonly showMoreProviders?: boolean;
}

export function AddProviderInstanceDialog({
  open,
  environmentId,
  environmentLabel,
  onOpenChange,
  onCreated,
  showMoreProviders: initialShowMoreProviders = false,
}: AddProviderInstanceDialogProps) {
  const gt = useGT();
  const m = useMessages();
  const settings = useEnvironmentSettings(environmentId);
  const secretSources = useSecretSources(environmentId);
  const persistProviderInstance = usePersistEnvironmentProviderInstanceMutation(environmentId);
  const canManageProviders = useEnvironmentScope(environmentId, AuthProvidersManageScope);

  const [wizardStep, setWizardStep] = useState(0);
  const [addingChatGptAccount, setAddingChatGptAccount] = useState(false);
  // Drivers the administrator's policy leaves out are not offered at all.
  const managedPolicy = useManagedPolicy(environmentId);
  const acpRegistryAllowed = isManagedDriverAllowed(managedPolicy, ACP_REGISTRY_DRIVER_KIND);
  const toGridOption = (option: ProviderClientDefinition): ProviderGridOption => ({
    value: option.driverKind,
    label: option.label,
    driverKind: option.driverKind,
    badgeLabel: option.badgeLabel,
  });
  const featuredDriverOptions: ReadonlyArray<ProviderGridOption> = [
    ...FEATURED_DRIVER_OPTIONS.filter((option) =>
      isManagedDriverAllowed(managedPolicy, option.driverKind),
    ).map(toGridOption),
    ...(acpRegistryAllowed
      ? [
          {
            value: HOPLITE_PROVIDER_CHOICE,
            label: HOPLITE_LABEL,
            driverKind: ACP_REGISTRY_DRIVER_KIND,
            acpRegistryAgentId: HOPLITE_ACP_AGENT_ID,
          },
        ]
      : []),
  ];
  const moreDriverOptions: ReadonlyArray<ProviderGridOption> = MORE_DRIVER_OPTIONS.filter(
    (option) => isManagedDriverAllowed(managedPolicy, option.driverKind),
  ).map(toGridOption);
  const [driver, setDriver] = useState<ProviderDriverKind>(
    () =>
      (featuredDriverOptions[0] ?? moreDriverOptions[0])?.driverKind ??
      (acpRegistryAllowed ? ACP_REGISTRY_DRIVER_KIND : DEFAULT_DRIVER_KIND),
  );
  const [isHoplite, setIsHoplite] = useState(false);
  const [identityByDriver, setIdentityByDriver] = useState<Record<string, ProviderIdentityDraft>>(
    {},
  );
  const [selectedAcp, setSelectedAcp] = useState<AcpRegistrySearchAgent | null>(null);
  const [localEnvironment, setLocalEnvironment] = useState<
    ReadonlyArray<ProviderInstanceEnvironmentVariable>
  >([]);
  const [isManualAcpConfiguration, setIsManualAcpConfiguration] = useState(false);
  const [showMoreProviders, setShowMoreProviders] = useState(initialShowMoreProviders);
  const [configByDriver, setConfigByDriver] = useState<Record<string, Record<string, unknown>>>({});
  const [hasAttemptedSubmit, setHasAttemptedSubmit] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [createdInstanceId, setCreatedInstanceId] = useState<ProviderInstanceId | null>(null);

  // Reserve Codex/Claude default ids because they run before configuration; other unconfigured slots are
  // available.
  const existingIds = new Set([
    "codex",
    "claudeAgent",
    ...Object.keys(settings.providerInstances ?? {}),
  ]);

  const driverOption = providerClients.get(driver) ?? DEFAULT_DRIVER_OPTION;
  const isAcpRegistry = driver === ACP_REGISTRY_DRIVER_KIND;
  const showRegistrySearch =
    !createdInstanceId &&
    !addingChatGptAccount &&
    wizardStep === 0 &&
    !(isAcpRegistry && isManualAcpConfiguration);
  // Searches while Show more is closed, so the fold opens on results.
  const registry = useAcpRegistrySearch(environmentId, showRegistrySearch);
  const isPreparingRegistryAgent = registry.preparingId !== null;
  // Hoplite shares the acpRegistry driver but has its own drafts, steps, and config rows.
  const draftKey = isHoplite ? HOPLITE_PROVIDER_CHOICE : driver;
  const defaultIdentity: ProviderIdentityDraft = {
    label: isHoplite ? HOPLITE_LABEL : driverOption.label,
    accentColor: "",
    instanceIdOverride: null,
  };
  const { label, accentColor, instanceIdOverride } = identityByDriver[draftKey] ?? defaultIdentity;
  const instanceId =
    instanceIdOverride ??
    deriveAvailableInstanceId(
      (candidateLabel) => {
        if (isHoplite) {
          return !candidateLabel.trim() || candidateLabel === HOPLITE_LABEL
            ? "hoplite"
            : deriveInstanceId(driver, candidateLabel);
        }
        if (!candidateLabel.trim() || candidateLabel === driverOption.label) {
          return isAcpRegistry ? `${driver}_custom` : driver;
        }
        return deriveInstanceId(driver, candidateLabel);
      },
      label,
      existingIds,
    );
  const driverSettingsFields = deriveProviderSettingsFields(driverOption, undefined, m);
  const instanceIdError = validateInstanceId(instanceId, existingIds, m);
  const showInstanceIdError = hasAttemptedSubmit && instanceIdError !== null;
  const identityStep = 1;
  const previewLabel =
    label.trim() ||
    gt("{provider} Workspace", { provider: isHoplite ? HOPLITE_LABEL : driverOption.label });

  const configDraft = configByDriver[draftKey] ?? EMPTY_CONFIG_DRAFT;
  const isLocalAcp = isAcpRegistry && isManualAcpConfiguration && configDraft.source === "local";
  const localCommandPath =
    typeof configDraft.commandPath === "string" ? configDraft.commandPath.trim() : "";
  const localCommandArgs = Array.isArray(configDraft.commandArgs)
    ? configDraft.commandArgs.filter((arg): arg is string => typeof arg === "string")
    : [];
  const manualAgentId = typeof configDraft.agentId === "string" ? configDraft.agentId.trim() : "";
  const acpSelectionError = isHoplite
    ? null
    : isLocalAcp
      ? localCommandPath.length > 0
        ? null
        : gt("Executable is required.")
      : selectedAcp !== null || (isManualAcpConfiguration && manualAgentId.length > 0)
        ? null
        : gt("Select an ACP or configure one manually.");
  const wizardStepSummaries = isHoplite
    ? ([HOPLITE_LABEL, previewLabel, hopliteProjectId(localCommandArgs) || null, null] as const)
    : isAcpRegistry
      ? ([
          isLocalAcp ? gt("Local ACP command") : (selectedAcp?.name ?? (manualAgentId || null)),
          previewLabel,
          null,
        ] as const)
      : ([driverOption.label, previewLabel, null] as const);
  // The step that saves the instance and shows sign-in; the rest of the wizard ends on Add.
  const signInStep = isHoplite ? 3 : isAcpRegistry && !isLocalAcp ? 2 : null;
  const setConfigDraft = (config: Record<string, unknown> | undefined) => {
    setConfigByDriver((existing) => {
      const next = { ...existing };
      if (config === undefined || Object.keys(config).length === 0) {
        delete next[draftKey];
      } else {
        next[draftKey] = config;
      }
      return next;
    });
  };
  const selectDriver = (value: string) => {
    if (value === HOPLITE_PROVIDER_CHOICE) {
      setDriver(ACP_REGISTRY_DRIVER_KIND);
      setIsHoplite(true);
      setSelectedAcp(null);
      setConfigByDriver((existing) =>
        existing[HOPLITE_PROVIDER_CHOICE]
          ? existing
          : {
              ...existing,
              [HOPLITE_PROVIDER_CHOICE]: {
                ...HOPLITE_LOCAL_ACP_CONFIG,
                commandArgs: [...HOPLITE_LOCAL_ACP_CONFIG.commandArgs],
              },
            },
      );
    } else {
      setDriver(ProviderDriverKind.make(value));
      setIsHoplite(false);
    }
    setIsManualAcpConfiguration(false);
    setHasAttemptedSubmit(false);
  };
  const setIdentityDraft = (update: Partial<ProviderIdentityDraft>) => {
    setIdentityByDriver((existing) => ({
      ...existing,
      [draftKey]: { ...(existing[draftKey] ?? defaultIdentity), ...update },
    }));
  };

  const applyWizardNavigation = (navigation: WizardNavigation) => {
    if (isSaving || isPreparingRegistryAgent || createdInstanceId) return;
    if (navigation.kind === "blocked") {
      setHasAttemptedSubmit(true);
    }
    if (signInStep !== null && navigation.kind === "navigate" && navigation.step === signInStep) {
      void handleSave();
      return;
    }
    setWizardStep(navigation.step);
  };

  const navigateToStep = (requestedStep: number) => {
    applyWizardNavigation(
      isHoplite
        ? resolveWizardNavigation(wizardStep, requestedStep, HOPLITE_WIZARD_STEPS.length, {
            instanceIdError,
          })
        : isAcpRegistry
          ? isLocalAcp
            ? resolveWizardNavigation(wizardStep, requestedStep, LOCAL_ACP_WIZARD_STEPS.length, {
                instanceIdError,
                prerequisite: { step: 0, error: acpSelectionError },
              })
            : resolveAcpRegistryWizardNavigation(wizardStep, requestedStep, {
                instanceIdError,
                selectionError: acpSelectionError,
              })
          : resolveWizardNavigation(wizardStep, requestedStep, ADD_PROVIDER_WIZARD_STEPS.length, {
              instanceIdError,
            }),
    );
  };

  const handleAcpPrepared = (agent: AcpRegistrySearchAgent) => {
    setDriver(ACP_REGISTRY_DRIVER_KIND);
    setIsHoplite(false);
    const nextLabel = agent.name;
    const registryIconUrl = resolveOfficialAcpRegistryIconUrl(agent.icon);
    const nextInstanceId = deriveAvailableInstanceId(
      (candidateLabel) => deriveInstanceId(ACP_REGISTRY_DRIVER_KIND, candidateLabel),
      nextLabel,
      existingIds,
    );
    setSelectedAcp(agent);
    setIsManualAcpConfiguration(false);
    setIdentityByDriver((existing) =>
      updateProviderIdentityDraft(existing, ACP_REGISTRY_DRIVER_KIND, {
        label: nextLabel,
        instanceIdOverride: nextInstanceId,
      }),
    );
    setConfigByDriver((existing) => ({
      ...existing,
      [ACP_REGISTRY_DRIVER_KIND]: {
        agentId: agent.id,
        distribution: "auto",
        ...(registryIconUrl ? { registryIconUrl } : {}),
      },
    }));
    setHasAttemptedSubmit(false);
    setWizardStep(1);
  };

  const handleManualAcpConfiguration = () => {
    setDriver(ACP_REGISTRY_DRIVER_KIND);
    setIsHoplite(false);
    setSelectedAcp(null);
    setIsManualAcpConfiguration(true);
    setConfigByDriver((existing) => {
      const next = { ...existing };
      delete next[ACP_REGISTRY_DRIVER_KIND];
      return next;
    });
    setIdentityByDriver((existing) =>
      updateProviderIdentityDraft(existing, ACP_REGISTRY_DRIVER_KIND, {
        label: "",
        instanceIdOverride: null,
      }),
    );
    setHasAttemptedSubmit(false);
  };

  const handleLocalAcpConfiguration = () => {
    setDriver(ACP_REGISTRY_DRIVER_KIND);
    setIsHoplite(false);
    setSelectedAcp(null);
    setIsManualAcpConfiguration(true);
    setConfigByDriver((existing) => ({
      ...existing,
      [ACP_REGISTRY_DRIVER_KIND]: { source: "local", commandArgs: [] },
    }));
    setIdentityByDriver((existing) =>
      updateProviderIdentityDraft(existing, ACP_REGISTRY_DRIVER_KIND, {
        label: gt("Local ACP"),
        instanceIdOverride: null,
      }),
    );
    setLocalEnvironment([]);
    setHasAttemptedSubmit(false);
  };

  // A policy that owns this driver's launch settings also rules out ChatGPT's own runtime.
  const driverLocks = managedInstanceLocks(managedPolicy, driver, m);

  const handleSave = async () => {
    if (!readEnvironmentScope(environmentId, AuthProvidersManageScope)) return;
    if (isSaving || createdInstanceId) return;
    setHasAttemptedSubmit(true);
    if (instanceIdError !== null || (isAcpRegistry && acpSelectionError !== null)) return;

    const config =
      driver === "codex"
        ? { ...configByDriver[draftKey], setupMode: "existing" }
        : (configByDriver[draftKey] ?? {});
    const hasConfig = Object.keys(config).length > 0;
    const normalizedAccentColor = normalizeProviderAccentColor(accentColor);

    const nextInstance: ProviderInstanceConfig = {
      driver,
      enabled: true,
      ...(label.trim().length > 0 ? { displayName: label.trim() } : {}),
      ...(normalizedAccentColor ? { accentColor: normalizedAccentColor } : {}),
      ...(hasConfig ? { config } : {}),
      ...(isLocalAcp && localEnvironment.length > 0 ? { environment: localEnvironment } : {}),
    };
    const brandedId = ProviderInstanceId.make(instanceId);
    setIsSaving(true);
    const result = await persistProviderInstance({
      operation: "create",
      instanceId: brandedId,
      instance: nextInstance,
    });
    if (result._tag === "Failure") {
      const error = squashAtomCommandFailure(result);
      setIsSaving(false);
      toastManager.add({
        type: "error",
        title: gt("Could not add provider instance"),
        description:
          error instanceof Error
            ? (thrownErrorMessage(error, resolveMessage) ?? error.message)
            : gt("The settings update failed."),
      });
      return;
    }
    onCreated?.(brandedId, driver);
    if (signInStep !== null) {
      setCreatedInstanceId(brandedId);
      setIsSaving(false);
      setWizardStep(signInStep);
      return;
    }
    toastManager.add({
      type: "success",
      title: gt("Provider instance added"),
      description: gt("{provider} instance ''{instanceId}'' was added.", {
        provider: driverOption.label,
        instanceId,
      }),
    });
    onOpenChange(false);
  };

  if (addingChatGptAccount) {
    return (
      <AddManagedCodexAccountDialog
        environmentId={environmentId}
        onClose={() => onOpenChange(false)}
        onAccountCreated={(instanceId) => onCreated?.(instanceId, ProviderDriverKind.make("codex"))}
      />
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <WizardPopup size="wide">
        <WizardHeader
          title={gt("Add provider")}
          description={
            <T>
              Add an account or configure a provider on <Var>{environmentLabel}</Var>.
            </T>
          }
        >
          {isAcpRegistry ? (
            <AddProviderInstanceWizardSteps
              currentStep={wizardStep}
              summaries={wizardStepSummaries}
              instanceIdError={instanceIdError}
              steps={
                isHoplite
                  ? HOPLITE_WIZARD_STEPS
                  : isLocalAcp
                    ? LOCAL_ACP_WIZARD_STEPS
                    : ACP_REGISTRY_WIZARD_STEPS
              }
              disabled={isSaving || isPreparingRegistryAgent || createdInstanceId !== null}
              identityStep={1}
              prerequisite={{ step: 0, error: acpSelectionError }}
              onNavigation={applyWizardNavigation}
            />
          ) : (
            <AddProviderInstanceWizardSteps
              currentStep={wizardStep}
              summaries={wizardStepSummaries}
              instanceIdError={instanceIdError}
              disabled={isSaving || isPreparingRegistryAgent}
              onNavigation={applyWizardNavigation}
            />
          )}
        </WizardHeader>

        {createdInstanceId ? (
          <ProviderWizardAuthenticationStep
            environmentId={environmentId}
            environmentLabel={environmentLabel}
            instanceId={createdInstanceId}
            onFinish={() => onOpenChange(false)}
          />
        ) : (
          <>
            <WizardPanel className={cn(isAcpRegistry && wizardStep === identityStep && "min-h-72")}>
              <div className={cn("grid gap-2", wizardStep !== 0 && "hidden")}>
                <div id="add-instance-driver-label" className="text-sm font-medium text-foreground">
                  {gt("Provider", { $context: "wizard step" })}
                </div>
                <ProviderOptionGrid
                  options={featuredDriverOptions}
                  value={isHoplite ? HOPLITE_PROVIDER_CHOICE : driver}
                  disabled={isPreparingRegistryAgent}
                  onValueChange={selectDriver}
                  aria-labelledby="add-instance-driver-label"
                />
                <MultipleAccountsNote environmentId={environmentId} driver={driver} />
              </div>

              {wizardStep === 0 && (moreDriverOptions.length > 0 || acpRegistryAllowed) ? (
                <Collapsible open={showMoreProviders} onOpenChange={setShowMoreProviders}>
                  <div className="flex pt-2">
                    <CollapsibleTrigger render={<Button variant="ghost-muted" size="xs" />}>
                      {showMoreProviders ? gt("Show less") : gt("Show more")}
                      <ChevronDownIcon
                        aria-hidden
                        className={cn("transition-transform", showMoreProviders && "rotate-180")}
                      />
                    </CollapsibleTrigger>
                  </div>
                  {/* WizardPanel already animates its height, so the fold opens without its own. */}
                  <CollapsiblePanel animate={false}>
                    <div className="space-y-4 pt-4">
                      <ProviderOptionGrid
                        options={moreDriverOptions}
                        value={isHoplite ? HOPLITE_PROVIDER_CHOICE : driver}
                        disabled={isPreparingRegistryAgent}
                        onValueChange={selectDriver}
                        aria-label={gt("More providers")}
                      />
                      {!acpRegistryAllowed ? null : (
                        <div className="flex items-center gap-3 text-xs text-muted-foreground">
                          <div aria-hidden className="flex-1 border-t border-border/70" />
                          <span>
                            <T>Or choose from ACP Registry</T>
                          </span>
                          <div aria-hidden className="flex-1 border-t border-border/70" />
                        </div>
                      )}
                      {!acpRegistryAllowed ? null : isAcpRegistry && isManualAcpConfiguration ? (
                        <div className="grid gap-4">
                          <div className="flex items-start justify-between gap-3">
                            <div>
                              <h3 className="text-sm font-medium text-foreground">
                                {isLocalAcp ? gt("Local ACP command") : gt("Enter manually")}
                              </h3>
                              <p className="mt-0.5 text-xs text-muted-foreground">
                                {isLocalAcp
                                  ? gt("Run an installed ACP executable on {environment}.", {
                                      environment: environmentLabel,
                                    })
                                  : gt(
                                      "Enter an official registry ID and any local executable or auth override.",
                                    )}
                              </p>
                            </div>
                            <Button
                              onClick={() => {
                                setIsManualAcpConfiguration(false);
                                setHasAttemptedSubmit(false);
                              }}
                              size="xs"
                              variant="ghost"
                            >
                              <T>Search registry</T>
                            </Button>
                          </div>
                          <SettingsGroup variant="plain">
                            <ProviderSettingsForm
                              definition={driverOption}
                              value={configDraft}
                              idPrefix="add-provider-acpRegistry-manual"
                              variant="settings"
                              onChange={setConfigDraft}
                              environmentId={environmentId}
                            />
                            {isLocalAcp ? (
                              <ProviderEnvironmentSection
                                environment={localEnvironment}
                                onChange={setLocalEnvironment}
                                secretSources={secretSources}
                                environmentId={environmentId}
                              />
                            ) : null}
                          </SettingsGroup>
                          {isAcpRegistry && hasAttemptedSubmit && acpSelectionError ? (
                            <p className="text-2xs text-destructive">{acpSelectionError}</p>
                          ) : null}
                        </div>
                      ) : (
                        <>
                          <AcpRegistrySearchStep
                            environmentId={environmentId}
                            registry={registry}
                            providerInstances={settings.providerInstances}
                            onPrepared={handleAcpPrepared}
                            onManualConfiguration={handleManualAcpConfiguration}
                            onLocalConfiguration={() => handleLocalAcpConfiguration()}
                          />
                          {isAcpRegistry && hasAttemptedSubmit && acpSelectionError ? (
                            <p className="mt-2 text-2xs text-destructive">{acpSelectionError}</p>
                          ) : null}
                        </>
                      )}
                    </div>
                  </CollapsiblePanel>
                </Collapsible>
              ) : null}

              {isAcpRegistry && wizardStep === 1 && selectedAcp ? (
                <div className="mb-4 flex items-start justify-between gap-3 border-b border-border/70 pb-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-foreground">
                      {selectedAcp.name}
                    </p>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      v{selectedAcp.version} · {selectedAcp.distribution}
                    </p>
                  </div>
                  <div className="flex shrink-0 gap-2 text-2xs">
                    {selectedAcp.website ? (
                      <a
                        aria-label={gt("Open documentation for {name} ({id})", {
                          name: selectedAcp.name,
                          id: selectedAcp.id,
                        })}
                        className="text-muted-foreground hover:text-foreground"
                        href={selectedAcp.website}
                        rel="noreferrer"
                        target="_blank"
                      >
                        <T>Docs</T>
                      </a>
                    ) : null}
                    {selectedAcp.repository ? (
                      <a
                        aria-label={gt("Open source for {name} ({id})", {
                          name: selectedAcp.name,
                          id: selectedAcp.id,
                        })}
                        className="text-muted-foreground hover:text-foreground"
                        href={selectedAcp.repository}
                        rel="noreferrer"
                        target="_blank"
                      >
                        {gt("Source", { $context: "link to source code" })}
                      </a>
                    ) : null}
                  </div>
                </div>
              ) : null}

              <SettingsGroup
                variant="plain"
                className={cn(wizardStep !== identityStep && "hidden")}
              >
                <SettingsRow
                  title={
                    <label htmlFor="add-provider-label">
                      {gt("Label", { $context: "noun, display name" })}
                    </label>
                  }
                  description={
                    <span id="add-provider-label-description">
                      <T>Shown in the provider list.</T>
                    </span>
                  }
                  control={
                    <Input
                      id="add-provider-label"
                      aria-describedby="add-provider-label-description"
                      size="sm"
                      className="w-full @min-[32rem]/settings-row:w-56"
                      placeholder={gt("e.g. Work")}
                      value={label}
                      onChange={(event) => setIdentityDraft({ label: event.target.value })}
                    />
                  }
                />
                <SettingsRow
                  title={
                    <label htmlFor="add-provider-instance-id">
                      <T>Instance ID</T>
                    </label>
                  }
                  description={
                    <span id="add-provider-instance-id-description">
                      <T>Letters, digits, '-', or '_'.</T>
                    </span>
                  }
                  status={
                    showInstanceIdError ? (
                      <span
                        id="add-provider-instance-id-error"
                        role="alert"
                        className="text-destructive"
                      >
                        {instanceIdError}
                      </span>
                    ) : undefined
                  }
                  control={
                    <Input
                      id="add-provider-instance-id"
                      aria-describedby={
                        showInstanceIdError
                          ? "add-provider-instance-id-description add-provider-instance-id-error"
                          : "add-provider-instance-id-description"
                      }
                      size="sm"
                      className="w-full @min-[32rem]/settings-row:w-56"
                      placeholder={`${driver}_work`}
                      value={instanceId}
                      onChange={(event) => {
                        setIdentityDraft({ instanceIdOverride: event.target.value });
                      }}
                      aria-invalid={showInstanceIdError}
                    />
                  }
                />
                <SettingsRow
                  title={gt("Accent color")}
                  description={gt("Optional marker shown in the picker.")}
                  control={
                    <ProviderAccentColorPicker
                      displayName={label || driverOption.label}
                      value={accentColor || undefined}
                      onCommit={(value) => setIdentityDraft({ accentColor: value })}
                      layout="inline"
                    />
                  }
                />
              </SettingsGroup>

              {isHoplite && wizardStep === 2 ? (
                <SettingsGroup variant="plain">
                  <HopliteSettingsRows
                    value={configDraft}
                    onChange={setConfigDraft}
                    idPrefix="add-provider-hoplite"
                    disabled={
                      driverLocks !== undefined &&
                      (driverLocks.configKeys.has("commandPath") ||
                        driverLocks.configKeys.has("commandArgs"))
                    }
                  />
                </SettingsGroup>
              ) : null}

              {!isAcpRegistry && driverSettingsFields.length > 0 ? (
                <SettingsGroup variant="plain" className={cn(wizardStep !== 2 && "hidden")}>
                  <ProviderSettingsForm
                    definition={driverOption}
                    value={configDraft}
                    idPrefix={`add-provider-${driver}`}
                    variant="settings"
                    onChange={setConfigDraft}
                    managed={
                      driverLocks && { keys: driverLocks.configKeys, reason: driverLocks.reason }
                    }
                    environmentId={environmentId}
                  />
                </SettingsGroup>
              ) : !isAcpRegistry && wizardStep === 2 ? (
                <div className="grid gap-2">
                  <p className="text-sm text-muted-foreground">
                    <T>This driver has no required configuration. You can add the instance now.</T>
                  </p>
                </div>
              ) : null}
            </WizardPanel>

            <WizardFooter>
              <Button
                variant={wizardStep === 0 ? "ghost-muted" : "outline"}
                size="sm"
                disabled={isSaving || isPreparingRegistryAgent}
                onClick={() => {
                  if (wizardStep === 0) {
                    onOpenChange(false);
                    return;
                  }
                  setWizardStep((step) => Math.max(0, step - 1));
                }}
              >
                {wizardStep === 0 ? gt("Cancel") : gt("Back")}
              </Button>
              {wizardStep === 0 && driver === "codex" ? (
                <>
                  <Button variant="outline" size="sm" onClick={() => navigateToStep(1)}>
                    <T>Configure manually</T>
                  </Button>
                  {driverLocks?.configKeys.has("setupMode") ? null : (
                    <ChatGptConnectionButton
                      size="sm"
                      onClick={() => setAddingChatGptAccount(true)}
                    />
                  )}
                </>
              ) : wizardStep < (isHoplite ? 2 : isAcpRegistry ? 1 : 2) ? (
                <Button
                  size="sm"
                  disabled={isPreparingRegistryAgent}
                  onClick={() => navigateToStep(wizardStep + 1)}
                >
                  <T>Next</T>
                </Button>
              ) : (
                <Button
                  size="sm"
                  disabled={isSaving || !canManageProviders}
                  onClick={() => void handleSave()}
                >
                  {isSaving
                    ? gt("Adding...")
                    : signInStep !== null
                      ? gt("Continue to sign-in")
                      : gt("Add instance")}
                </Button>
              )}
            </WizardFooter>
          </>
        )}
      </WizardPopup>
    </Dialog>
  );
}
