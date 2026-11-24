import type { ReactNode } from "react";
import { EnvironmentId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import "~/index.css";
import { render } from "../../../test/render";
import { HopliteCloudSection } from "./HopliteCloudSetup";

const state = vi.hoisted(() => ({ connect: vi.fn(), disconnect: vi.fn(), refresh: vi.fn() }));
const status = {
  connected: false,
  problem: null,
  providers: [
    { provider: "devin", connected: false, problem: null },
    { provider: "hoplite", connected: false, problem: null },
  ],
};

vi.mock("~/state/environments", () => ({
  usePrimaryEnvironmentId: () => EnvironmentId.make("test-environment"),
}));
vi.mock("~/state/query", () => ({
  useEnvironmentQuery: () => ({ data: status, error: null, refresh: state.refresh }),
}));
vi.mock("~/state/hopliteCloud", async () => {
  const { Atom } = await import("effect/reactivity");
  const permission = Atom.make(true);
  return {
    hopliteCloudEnvironment: {
      status: () => null,
      connect: { permissionAtom: () => permission, run: state.connect },
      disconnect: { run: state.disconnect },
      setAgentCredential: {},
      clearAgentCredential: {},
    },
  };
});
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: { readonly run?: unknown }) => command.run ?? vi.fn(),
}));
vi.mock(import("./settingsLayout"), () => ({
  SettingsSection: ({ children }: { readonly children: ReactNode }) => (
    <section>{children}</section>
  ),
  SettingsRow: ({
    title,
    description,
    control,
  }: {
    readonly title: ReactNode;
    readonly description?: ReactNode;
    readonly control?: ReactNode;
  }) => (
    <div>
      {title}
      {description}
      {control}
    </div>
  ),
}));

it("connects and disconnects Devin Cloud without asking for an API key", async () => {
  state.connect.mockReset();
  state.disconnect.mockReset();
  state.connect.mockResolvedValue({
    _tag: "Success",
    value: {
      ...status,
      providers: [{ provider: "devin", connected: true, problem: null }],
    },
  });
  state.disconnect.mockResolvedValue({ _tag: "Success", value: status });
  await using screen = await render(<HopliteCloudSection />);
  await screen.getByRole("button", { name: "Connect", exact: true }).nth(0).click();
  const dialog = page.getByRole("dialog", { name: "Devin Cloud" });
  await expect.element(dialog).toBeVisible();
  await expect.element(dialog.getByLabelText("Devin Cloud API key")).not.toBeInTheDocument();
  await dialog.getByRole("button", { name: "Connect Devin Cloud", exact: true }).click();
  expect(state.connect).toHaveBeenCalledWith({
    environmentId: "test-environment",
    input: { provider: "devin" },
  });
  await expect.element(dialog.getByText("Devin Cloud connected")).toBeVisible();
  await dialog.getByRole("button", { name: "Disconnect", exact: true }).click();
  expect(state.disconnect).toHaveBeenCalledWith({
    environmentId: "test-environment",
    input: { provider: "devin" },
  });
  await expect
    .element(dialog.getByRole("button", { name: "Connect Devin Cloud", exact: true }))
    .toBeVisible();
});

it("still requires an API key to connect Hoplite", async () => {
  state.connect.mockReset();
  state.connect.mockResolvedValue({ _tag: "Success", value: status });
  await using screen = await render(<HopliteCloudSection />);
  await screen.getByRole("button", { name: "Connect", exact: true }).nth(1).click();
  const dialog = page.getByRole("dialog", { name: "Hoplite", exact: true });
  const connect = dialog.getByRole("button", { name: "Connect Hoplite", exact: true });
  await expect.element(connect).toBeDisabled();
  await dialog.getByLabelText("Hoplite API key").fill("hop_test");
  await connect.click();
  expect(state.connect).toHaveBeenCalledWith({
    environmentId: "test-environment",
    input: { provider: "hoplite", apiKey: "hop_test" },
  });
});
