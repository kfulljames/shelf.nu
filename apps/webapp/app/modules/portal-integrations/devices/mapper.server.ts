/**
 * Vendor-agnostic normalized device shape. Every vendor-specific adapter
 * (ImmyBot, NinjaRMM, ...) projects its raw API payload into this shape,
 * and this mapper turns it into a Shelf `Asset` + `ExternalAssetLink`
 * bundle.
 *
 * Keeping the normalization step in the adapter — rather than letting
 * the mapper know every vendor's schema — means we can add a new vendor
 * by writing one adapter and reusing this mapper unchanged.
 */
export type NormalizedDevice = {
  /** Slug of the vendor this device came from, e.g. "immybot" / "ninja". */
  source: string;
  /** Vendor's primary identifier for this device (often a UUID or int). */
  sourceRecordId: string;
  /** Preferred display name. */
  name: string;
  serialNumber?: string | null;
  manufacturer?: string | null;
  model?: string | null;
  /** All known MAC addresses across adapters on this device. */
  macAddresses?: string[];
  /** Operating system / OS version, if available. */
  operatingSystem?: string | null;
  /** Any extra fields the vendor returns — preserved in metadata for
   * later conflict resolution without widening the mapper signature. */
  metadata?: Record<string, unknown>;
};

export type DeviceAssetBundle = {
  asset: {
    title: string;
    description: string | null;
  };
  externalLink: {
    sourceName: string;
    sourceRecordId: string;
    goldenRecordId: string;
    metadata: Record<string, unknown>;
  };
};

function deriveDescription(device: NormalizedDevice): string | null {
  const parts: string[] = [];

  const hardware = [device.manufacturer, device.model]
    .filter(Boolean)
    .join(" ");
  if (hardware) parts.push(hardware);
  if (device.serialNumber) parts.push(`Serial: ${device.serialNumber}`);
  if (device.operatingSystem) parts.push(`OS: ${device.operatingSystem}`);

  if (device.macAddresses && device.macAddresses.length > 0) {
    const dedup = Array.from(
      new Set(
        device.macAddresses
          .map((m) => m?.trim())
          .filter((m): m is string => Boolean(m))
      )
    );
    if (dedup.length > 0) {
      parts.push(`MAC: ${dedup.join(", ")}`);
    }
  }

  return parts.length > 0 ? parts.join("\n") : null;
}

function buildMetadata(device: NormalizedDevice): Record<string, unknown> {
  const metadata: Record<string, unknown> = { ...(device.metadata ?? {}) };

  // Surface the canonical fields we extracted in metadata too, so future
  // readers can see what the mapper used without digging through adapter
  // code. Only set non-empty values.
  if (device.serialNumber) metadata.serialNumber = device.serialNumber;
  if (device.manufacturer) metadata.manufacturer = device.manufacturer;
  if (device.model) metadata.model = device.model;
  if (device.operatingSystem) metadata.operatingSystem = device.operatingSystem;
  if (device.macAddresses && device.macAddresses.length > 0) {
    metadata.macAddresses = device.macAddresses;
  }

  return metadata;
}

export function deriveGoldenRecordId(device: NormalizedDevice): string {
  return `${device.source}:${device.sourceRecordId}`;
}

export function mapDeviceToAssetBundle(
  device: NormalizedDevice,
  options: { goldenRecordId?: string } = {}
): DeviceAssetBundle {
  if (!device.source) {
    throw new Error("NormalizedDevice.source is required");
  }
  if (!device.sourceRecordId) {
    throw new Error("NormalizedDevice.sourceRecordId is required");
  }
  if (!device.name || !device.name.trim()) {
    throw new Error("NormalizedDevice.name is required");
  }

  return {
    asset: {
      title: device.name.trim(),
      description: deriveDescription(device),
    },
    externalLink: {
      sourceName: device.source,
      sourceRecordId: device.sourceRecordId,
      goldenRecordId: options.goldenRecordId ?? deriveGoldenRecordId(device),
      metadata: buildMetadata(device),
    },
  };
}
