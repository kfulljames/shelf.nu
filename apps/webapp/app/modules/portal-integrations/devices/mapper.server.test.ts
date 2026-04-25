// @vitest-environment node

import { describe, expect, it } from "vitest";
import {
  deriveGoldenRecordId,
  mapDeviceToAssetBundle,
  type NormalizedDevice,
} from "./mapper.server";

const BASE: NormalizedDevice = {
  source: "immybot",
  sourceRecordId: "computer-42",
  name: "DESKTOP-ACME-01",
};

describe("mapDeviceToAssetBundle", () => {
  it("returns a bundle with title, null description and default golden id for a minimal device", () => {
    const bundle = mapDeviceToAssetBundle(BASE);

    expect(bundle.asset.title).toBe("DESKTOP-ACME-01");
    expect(bundle.asset.description).toBeNull();
    expect(bundle.externalLink).toEqual({
      sourceName: "immybot",
      sourceRecordId: "computer-42",
      goldenRecordId: "immybot:computer-42",
      metadata: {},
    });
  });

  it("trims whitespace from the name before using it as title", () => {
    const bundle = mapDeviceToAssetBundle({ ...BASE, name: "  laptop  " });
    expect(bundle.asset.title).toBe("laptop");
  });

  it("builds a multi-line description from hardware and identity fields", () => {
    const bundle = mapDeviceToAssetBundle({
      ...BASE,
      manufacturer: "Dell",
      model: "Latitude 7430",
      serialNumber: "SN-ABC",
      operatingSystem: "Windows 11 Pro",
      macAddresses: ["00:11:22:33:44:55"],
    });

    expect(bundle.asset.description).toBe(
      "Dell Latitude 7430\nSerial: SN-ABC\nOS: Windows 11 Pro\nMAC: 00:11:22:33:44:55"
    );
  });

  it("dedupes, trims, and drops empty MAC addresses", () => {
    const bundle = mapDeviceToAssetBundle({
      ...BASE,
      macAddresses: [
        "00:11:22:33:44:55",
        " 00:11:22:33:44:55 ",
        "",
        "AA:BB:CC:DD:EE:FF",
      ],
    });

    expect(bundle.asset.description).toBe(
      "MAC: 00:11:22:33:44:55, AA:BB:CC:DD:EE:FF"
    );
    expect(bundle.externalLink.metadata.macAddresses).toEqual([
      "00:11:22:33:44:55",
      " 00:11:22:33:44:55 ",
      "",
      "AA:BB:CC:DD:EE:FF",
    ]);
  });

  it("preserves vendor metadata and surfaces canonical fields into it", () => {
    const bundle = mapDeviceToAssetBundle({
      ...BASE,
      serialNumber: "SN-ABC",
      manufacturer: "Dell",
      metadata: { domain: "acme.local", lastLoginUser: "alice" },
    });

    expect(bundle.externalLink.metadata).toEqual({
      domain: "acme.local",
      lastLoginUser: "alice",
      serialNumber: "SN-ABC",
      manufacturer: "Dell",
    });
  });

  it("allows the caller to override the goldenRecordId", () => {
    const bundle = mapDeviceToAssetBundle(BASE, {
      goldenRecordId: "asset-mesh-uuid",
    });
    expect(bundle.externalLink.goldenRecordId).toBe("asset-mesh-uuid");
  });

  it.each([
    ["source", { ...BASE, source: "" }],
    ["sourceRecordId", { ...BASE, sourceRecordId: "" }],
    ["name", { ...BASE, name: "" }],
    ["name (whitespace only)", { ...BASE, name: "   " }],
  ])("throws when %s is missing", (_label, device) => {
    expect(() => mapDeviceToAssetBundle(device as NormalizedDevice)).toThrow();
  });
});

describe("deriveGoldenRecordId", () => {
  it("joins the source slug and record id with a colon", () => {
    expect(deriveGoldenRecordId(BASE)).toBe("immybot:computer-42");
  });
});
