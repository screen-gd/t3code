import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import {
  AcpRegistryManagedBinaryUninstallInput,
  AcpRegistryManagedBinaryUninstallResult,
  isHopliteAcpCommandPath,
  isHopliteAcpConfig,
  officialAcpRegistryIconUrlForAgentId,
  resolveOfficialAcpRegistryIconUrl,
} from "./acpRegistry.ts";

const decodeUninstallInput = Schema.decodeUnknownSync(AcpRegistryManagedBinaryUninstallInput);
const decodeUninstallResult = Schema.decodeUnknownSync(AcpRegistryManagedBinaryUninstallResult);

describe("ACP Registry contracts", () => {
  it("accepts only official Registry icon URLs and safe agent IDs", () => {
    expect(officialAcpRegistryIconUrlForAgentId("antigravity-acp")).toBe(
      "https://cdn.agentclientprotocol.com/registry/v1/latest/antigravity-acp.svg",
    );
    expect(officialAcpRegistryIconUrlForAgentId("../antigravity-acp")).toBeNull();
    expect(
      resolveOfficialAcpRegistryIconUrl(
        "https://cdn.agentclientprotocol.com/registry/v1/latest/pi-acp.svg",
      ),
    ).toBe("https://cdn.agentclientprotocol.com/registry/v1/latest/pi-acp.svg");
    expect(
      resolveOfficialAcpRegistryIconUrl(
        "https://cdn.agentclientprotocol.com.evil/registry/v1/latest/pi-acp.svg",
      ),
    ).toBeNull();
    expect(
      resolveOfficialAcpRegistryIconUrl(
        "https://user@cdn.agentclientprotocol.com/registry/v1/latest/pi-acp.svg",
      ),
    ).toBeNull();
  });

  it("decodes managed binary uninstall payloads and rejects unsafe agent IDs", () => {
    expect(decodeUninstallInput({ agentId: "  example-agent  " })).toEqual({
      agentId: "example-agent",
    });
    expect(decodeUninstallResult({ agentId: "example-agent", removed: false })).toEqual({
      agentId: "example-agent",
      removed: false,
    });
    expect(() => decodeUninstallInput({ agentId: "../example-agent" })).toThrow();
  });
});

describe("isHopliteAcpCommandPath", () => {
  it("matches hoplite binaries by basename only", () => {
    expect(isHopliteAcpCommandPath("hoplite")).toBe(true);
    expect(isHopliteAcpCommandPath(" C:\\tools\\Hoplite.EXE ")).toBe(true);
    expect(isHopliteAcpCommandPath("/usr/local/bin/hoplite.cmd")).toBe(true);
    expect(isHopliteAcpCommandPath("hoplite-dev")).toBe(false);
    expect(isHopliteAcpCommandPath("/hoplite/other")).toBe(false);
  });
});

describe("isHopliteAcpConfig", () => {
  it("matches a local config whose executable is Hoplite", () => {
    expect(isHopliteAcpConfig({ source: "local", commandPath: "hoplite" })).toBe(true);
    expect(
      isHopliteAcpConfig({
        source: "local",
        commandPath: "C:\\tools\\hoplite.exe",
        commandArgs: ["acp"],
      }),
    ).toBe(true);
  });

  it("matches a local config carrying the Hoplite agent marker", () => {
    expect(
      isHopliteAcpConfig({
        source: "local",
        agentId: "hoplite",
        commandPath: "/opt/bin/my-wrapper",
      }),
    ).toBe(true);
    expect(isHopliteAcpConfig({ source: "local", agentId: " hoplite ", commandPath: "dsh" })).toBe(
      true,
    );
  });

  it("rejects registry configs, other executables, and non-objects", () => {
    expect(isHopliteAcpConfig({ source: "registry", commandPath: "hoplite" })).toBe(false);
    expect(isHopliteAcpConfig({ source: "registry", agentId: "hoplite" })).toBe(false);
    expect(isHopliteAcpConfig({ source: "local", commandPath: "dsh" })).toBe(false);
    expect(isHopliteAcpConfig({ source: "local", commandPath: 42 })).toBe(false);
    expect(isHopliteAcpConfig({ source: "local" })).toBe(false);
    expect(isHopliteAcpConfig(null)).toBe(false);
    expect(isHopliteAcpConfig("hoplite")).toBe(false);
  });
});
