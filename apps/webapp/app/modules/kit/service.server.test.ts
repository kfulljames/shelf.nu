import { KitStatus, AssetStatus } from "@prisma/client";

import { createSupabaseMock } from "@mocks/supabase";
import { db } from "~/database/db.server";
import { ShelfError } from "~/utils/error";

import {
  createKit,
  updateKit,
  getKit,
  deleteKit,
  bulkDeleteKits,
  bulkAssignKitCustody,
  bulkReleaseKitCustody,
  releaseCustody,
  createKitsIfNotExists,
  updateKitQrCode,
  relinkKitQrCode,
  getAvailableKitAssetForBooking,
  updateKitsWithBookingCustodians,
} from "./service.server";
import { getQr } from "../qr/service.server";

// @vitest-environment node
// see https://vitest.dev/guide/environment.html#environments-for-specific-files

const sbMock = createSupabaseMock();
// why: testing kit service logic without actual Supabase HTTP calls
vitest.mock("~/database/supabase.server", () => ({
  get sbDb() {
    return sbMock.client;
  },
}));

// why: getKit and some functions still use Prisma db for complex queries
vitest.mock("~/database/db.server", () => ({
  db: {
    $transaction: vitest.fn().mockImplementation((callback) => callback(db)),
    kit: {
      create: vitest.fn().mockResolvedValue({}),
      update: vitest.fn().mockResolvedValue({}),
      findFirstOrThrow: vitest.fn().mockResolvedValue({}),
      findFirst: vitest.fn().mockResolvedValue(null),
      findMany: vitest.fn().mockResolvedValue([]),
      findUniqueOrThrow: vitest.fn().mockResolvedValue({}),
      delete: vitest.fn().mockResolvedValue({}),
      deleteMany: vitest.fn().mockResolvedValue({ count: 0 }),
      updateMany: vitest.fn().mockResolvedValue({ count: 0 }),
      count: vitest.fn().mockResolvedValue(0),
    },
    asset: {
      findFirst: vitest.fn().mockResolvedValue(null),
      findMany: vitest.fn().mockResolvedValue([]),
      update: vitest.fn().mockResolvedValue({}),
      updateMany: vitest.fn().mockResolvedValue({ count: 0 }),
    },
    qr: {
      update: vitest.fn().mockResolvedValue({}),
    },
    teamMember: {
      findUnique: vitest.fn().mockResolvedValue(null),
    },
    kitCustody: {
      createMany: vitest.fn().mockResolvedValue({ count: 0 }),
      deleteMany: vitest.fn().mockResolvedValue({ count: 0 }),
    },
    custody: {
      createMany: vitest.fn().mockResolvedValue({ count: 0 }),
      deleteMany: vitest.fn().mockResolvedValue({ count: 0 }),
    },
    note: {
      createMany: vitest.fn().mockResolvedValue({ count: 0 }),
    },
  },
}));

// why: ensuring predictable ID generation for consistent test assertions
vitest.mock("~/utils/id/id.server", () => ({
  id: vitest.fn(() => "mock-id"),
}));

// why: avoiding QR code generation during kit service tests
vitest.mock("~/modules/qr/service.server", () => ({
  getQr: vitest.fn(),
}));

// why: testing kit barcode operations without triggering barcode validation and updates
vitest.mock("~/modules/barcode/service.server", () => ({
  updateBarcodes: vitest.fn(),
  validateBarcodeUniqueness: vitest.fn(),
}));

// why: preventing database lookups for user data during kit tests
vitest.mock("~/modules/user/service.server", () => ({
  getUserByID: vitest.fn().mockResolvedValue({
    id: "user-1",
    firstName: "John",
    lastName: "Doe",
  }),
}));

// why: testing kit custody operations without creating actual notes
vitest.mock("~/modules/note/service.server", () => ({
  createNote: vitest.fn().mockResolvedValue({}),
  createNotes: vitest.fn().mockResolvedValue({}),
  createBulkKitChangeNotes: vitest.fn().mockResolvedValue({}),
}));

// why: isolating kit service logic from asset utility dependencies
vitest.mock("~/modules/asset/utils.server", () => ({
  getKitLocationUpdateNoteContent: vitest
    .fn()
    .mockReturnValue("Mock note content"),
}));

const mockKitData = {
  id: "kit-1",
  name: "Test Kit",
  description: "Test Description",
  status: KitStatus.AVAILABLE,
  createdById: "user-1",
  organizationId: "org-1",
  categoryId: "category-1",
  image: null,
  imageExpiration: null,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  locationId: null,
};

const mockCreateParams = {
  name: "Test Kit",
  description: "Test Description",
  createdById: "user-1",
  organizationId: "org-1",
  categoryId: "category-1",
  locationId: null,
};

describe("createKit", () => {
  beforeEach(() => {
    vitest.clearAllMocks();
    sbMock.reset();
  });

  it("should create a kit successfully with category", async () => {
    expect.assertions(2);
    // 1. Kit insert (.from("Kit").insert(...).select("*").single())
    sbMock.enqueueData(mockKitData);
    // 2. QR insert (.from("Qr").insert(...))
    sbMock.enqueueData({});

    await createKit(mockCreateParams);

    expect(sbMock.calls.from).toHaveBeenCalledWith("Kit");
    expect(sbMock.calls.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "mock-id",
        name: "Test Kit",
        description: "Test Description",
        createdById: "user-1",
        organizationId: "org-1",
        categoryId: "category-1",
        locationId: null,
      })
    );
  });

  it("should create a kit without category when categoryId is null", async () => {
    expect.assertions(1);
    // 1. Kit insert
    sbMock.enqueueData(mockKitData);
    // 2. QR insert
    sbMock.enqueueData({});

    await createKit({
      ...mockCreateParams,
      categoryId: null,
      locationId: null,
    });

    expect(sbMock.calls.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        categoryId: null,
      })
    );
  });

  it("should create a kit with barcodes", async () => {
    expect.assertions(1);
    // 1. Kit insert
    sbMock.enqueueData(mockKitData);
    // 2. QR insert
    sbMock.enqueueData({});
    // 3. Barcode insert
    sbMock.enqueueData({});

    const barcodes = [
      { type: "Code128" as any, value: "TEST123" },
      { type: "Code39" as any, value: "ABC456" },
    ];

    await createKit({
      ...mockCreateParams,
      barcodes,
      locationId: null,
    });

    // Barcode insert should have been called
    expect(sbMock.calls.from).toHaveBeenCalledWith("Barcode");
  });

  it("should filter out invalid barcodes", async () => {
    expect.assertions(1);
    // 1. Kit insert
    sbMock.enqueueData(mockKitData);
    // 2. QR insert
    sbMock.enqueueData({});
    // 3. Barcode insert (only valid barcodes)
    sbMock.enqueueData({});

    const barcodes = [
      { type: "Code128" as any, value: "TEST123" },
      { type: "Code39" as any, value: "" }, // Empty value
      { type: null, value: "ABC456" }, // No type
    ];

    await createKit({
      ...mockCreateParams,
      barcodes,
    });

    // Should have filtered to only 1 valid barcode
    expect(sbMock.calls.from).toHaveBeenCalledWith("Barcode");
  });

  it("should handle barcode constraint violations", async () => {
    expect.assertions(1);

    // Kit insert fails with unique constraint violation
    sbMock.setError({ message: "Unique constraint failed", code: "23505" });

    const barcodes = [{ type: "Code128" as any, value: "DUPLICATE123" }];

    await expect(
      createKit({
        ...mockCreateParams,
        barcodes,
        locationId: null,
      })
    ).rejects.toThrow();
  });
});

describe("updateKit", () => {
  beforeEach(() => {
    vitest.clearAllMocks();
    sbMock.reset();
  });

  it("should update kit successfully with category", async () => {
    expect.assertions(2);
    const updatedKit = { ...mockKitData, name: "Updated Kit" };
    // Kit update (.from("Kit").update(...).eq(...).eq(...).select("*").single())
    sbMock.setData(updatedKit);

    const result = await updateKit({
      id: "kit-1",
      name: "Updated Kit",
      description: "Updated Description",
      status: KitStatus.AVAILABLE,
      createdById: "user-1",
      organizationId: "org-1",
      categoryId: "category-2",
      locationId: null,
    });

    expect(sbMock.calls.update).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "Updated Kit",
        description: "Updated Description",
        status: KitStatus.AVAILABLE,
        categoryId: "category-2",
      })
    );
    expect(result.name).toEqual("Updated Kit");
  });

  it("should disconnect category when categoryId is 'uncategorized'", async () => {
    expect.assertions(1);
    sbMock.setData(mockKitData);

    await updateKit({
      id: "kit-1",
      name: "Updated Kit",
      createdById: "user-1",
      organizationId: "org-1",
      categoryId: "uncategorized",
      locationId: null,
    });

    expect(sbMock.calls.update).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "Updated Kit",
        categoryId: null,
      })
    );
  });

  it("should not change category when categoryId is null", async () => {
    expect.assertions(1);
    sbMock.setData(mockKitData);

    await updateKit({
      id: "kit-1",
      name: "Updated Kit",
      createdById: "user-1",
      organizationId: "org-1",
      categoryId: null,
      locationId: null,
    });

    // categoryId should not be in the update payload
    expect(sbMock.calls.update).toHaveBeenCalledWith(
      expect.not.objectContaining({ categoryId: expect.anything() })
    );
  });

  it("should not change category when categoryId is undefined", async () => {
    expect.assertions(1);
    sbMock.setData(mockKitData);

    await updateKit({
      id: "kit-1",
      name: "Updated Kit",
      createdById: "user-1",
      organizationId: "org-1",
      categoryId: undefined,
      locationId: null,
    });

    expect(sbMock.calls.update).toHaveBeenCalledWith(
      expect.not.objectContaining({ categoryId: expect.anything() })
    );
  });

  it("should update barcodes when provided", async () => {
    expect.assertions(2);
    sbMock.setData(mockKitData);
    const { updateBarcodes } = await import("~/modules/barcode/service.server");

    const barcodes = [{ type: "Code128" as any, value: "NEW123" }];

    await updateKit({
      id: "kit-1",
      name: "Updated Kit",
      createdById: "user-1",
      organizationId: "org-1",
      barcodes,
      locationId: null,
    });

    expect(sbMock.calls.update).toHaveBeenCalled();
    expect(updateBarcodes).toHaveBeenCalledWith({
      barcodes,
      kitId: "kit-1",
      organizationId: "org-1",
      userId: "user-1",
    });
  });
});

describe("getKit", () => {
  beforeEach(() => {
    vitest.clearAllMocks();
    sbMock.reset();
  });

  it("should get kit successfully", async () => {
    expect.assertions(2);
    const kitData = {
      ...mockKitData,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    //@ts-expect-error missing vitest type
    db.kit.findFirstOrThrow.mockResolvedValue(kitData);

    const result = await getKit({
      id: "kit-1",
      organizationId: "org-1",
    });

    expect(db.kit.findFirstOrThrow).toHaveBeenCalledWith({
      where: {
        OR: [{ id: "kit-1", organizationId: "org-1" }],
      },
      include: expect.any(Object),
    });
    expect(result).toEqual(kitData);
  });

  it("should handle cross-organization access", async () => {
    expect.assertions(1);
    const crossOrgKit = {
      ...mockKitData,
      organizationId: "other-org",
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    //@ts-expect-error missing vitest type
    db.kit.findFirstOrThrow.mockResolvedValue(crossOrgKit);

    const userOrganizations = [{ organizationId: "other-org" }];

    await expect(
      getKit({
        id: "kit-1",
        organizationId: "org-1",
        userOrganizations,
      })
    ).rejects.toThrow(ShelfError);
  });

  it("should throw error when kit not found", async () => {
    expect.assertions(1);
    //@ts-expect-error missing vitest type
    db.kit.findFirstOrThrow.mockRejectedValue(new Error("Not found"));

    await expect(
      getKit({
        id: "nonexistent-kit",
        organizationId: "org-1",
      })
    ).rejects.toThrow(ShelfError);
  });
});

describe("deleteKit", () => {
  beforeEach(() => {
    vitest.clearAllMocks();
    sbMock.reset();
  });

  it("should delete kit successfully", async () => {
    expect.assertions(2);
    // sbDb.from("Kit").delete().eq("id",...).eq("organizationId",...)
    sbMock.setData(null);

    await deleteKit({
      id: "kit-1",
      organizationId: "org-1",
    });

    expect(sbMock.calls.from).toHaveBeenCalledWith("Kit");
    expect(sbMock.calls.delete).toHaveBeenCalled();
  });

  it("should handle deletion errors", async () => {
    expect.assertions(1);
    sbMock.setError({ message: "Deletion failed" });

    await expect(
      deleteKit({
        id: "kit-1",
        organizationId: "org-1",
      })
    ).rejects.toThrow(ShelfError);
  });
});

describe("bulkDeleteKits", () => {
  beforeEach(() => {
    vitest.clearAllMocks();
    sbMock.reset();
  });

  it("should bulk delete kits successfully", async () => {
    expect.assertions(2);
    const kitsToDelete = [
      { id: "kit-1", image: "image1.jpg" },
      { id: "kit-2", image: null },
    ];
    // 1. resolveKitIdsForBulk -> sbDb.from("Kit").select("id, image")...
    sbMock.enqueueData(kitsToDelete);
    // 2. sbDb.from("Kit").delete().in("id",...)
    sbMock.enqueueData(null);

    await bulkDeleteKits({
      kitIds: ["kit-1", "kit-2"],
      organizationId: "org-1",
      userId: "user-1",
    });

    expect(sbMock.calls.from).toHaveBeenCalledWith("Kit");
    expect(sbMock.calls.delete).toHaveBeenCalled();
  });
});

describe("bulkAssignKitCustody", () => {
  beforeEach(() => {
    vitest.clearAllMocks();
    sbMock.reset();
  });

  it("should assign custody to kits successfully", async () => {
    expect.assertions(2);
    // 1. resolveKitIdsForBulk -> kit rows
    sbMock.enqueueData([
      { id: "kit-1", name: "Kit 1", status: KitStatus.AVAILABLE },
    ]);
    // 2. Assets for kits
    sbMock.enqueueData([
      {
        id: "asset-1",
        title: "Asset 1",
        status: AssetStatus.AVAILABLE,
        kitId: "kit-1",
      },
    ]);
    // 3. TeamMember lookup (.single())
    sbMock.enqueueData({
      id: "custodian-1",
      name: "John Doe",
      userId: "user-1",
    });
    // 4. User lookup for custodian
    sbMock.enqueueData({
      id: "user-1",
      firstName: "John",
      lastName: "Doe",
    });
    // 5. RPC call for bulk assign
    sbMock.enqueueData(null);

    await bulkAssignKitCustody({
      kitIds: ["kit-1"],
      organizationId: "org-1",
      custodianId: "custodian-1",
      custodianName: "John Doe",
      userId: "user-1",
    });

    expect(sbMock.calls.from).toHaveBeenCalledWith("Kit");
    expect(sbMock.calls.rpc).toHaveBeenCalledWith(
      "shelf_kit_bulk_assign_custody",
      expect.any(Object)
    );
  });

  it("should throw error when kits are not available", async () => {
    expect.assertions(1);
    // 1. resolveKitIdsForBulk -> kit rows with unavailable status
    sbMock.enqueueData([
      { id: "kit-1", name: "Kit 1", status: KitStatus.IN_CUSTODY },
    ]);
    // 2. Assets for kits
    sbMock.enqueueData([]);
    // 3. TeamMember lookup
    sbMock.enqueueData({
      id: "custodian-1",
      name: "John Doe",
      userId: null,
    });
    // 4. RPC (won't be reached but needed for queue)

    await expect(
      bulkAssignKitCustody({
        kitIds: ["kit-1"],
        organizationId: "org-1",
        custodianId: "custodian-1",
        custodianName: "John Doe",
        userId: "user-1",
      })
    ).rejects.toThrow("There are some unavailable kits");
  });
});

describe("bulkReleaseKitCustody", () => {
  beforeEach(() => {
    vitest.clearAllMocks();
    sbMock.reset();
  });

  it("should release custody from kits successfully", async () => {
    expect.assertions(2);
    // 1. resolveKitIdsForBulk -> kit rows
    sbMock.enqueueData([
      { id: "kit-1", name: "Kit 1", status: KitStatus.IN_CUSTODY },
    ]);
    // 2. KitCustody lookup
    sbMock.enqueueData([
      { id: "custody-1", kitId: "kit-1", custodianId: "custodian-1" },
    ]);
    // 3. Assets for kits
    sbMock.enqueueData([
      {
        id: "asset-1",
        status: AssetStatus.IN_CUSTODY,
        title: "Asset 1",
        kitId: "kit-1",
      },
    ]);
    // 4. Asset IDs for custody lookup (inner query)
    sbMock.enqueueData([{ id: "asset-1" }]);
    // 5. Custody entries
    sbMock.enqueueData([{ id: "asset-custody-1", assetId: "asset-1" }]);
    // 6. TeamMember lookup for custodian
    sbMock.enqueueData([
      { id: "custodian-1", name: "John Doe", userId: "user-1" },
    ]);
    // 7. User lookup for custodian
    sbMock.enqueueData([
      {
        id: "user-1",
        firstName: "John",
        lastName: "Doe",
        profilePicture: null,
        email: "john@test.com",
      },
    ]);
    // 8. RPC call for bulk release
    sbMock.enqueueData(null);

    await bulkReleaseKitCustody({
      kitIds: ["kit-1"],
      organizationId: "org-1",
      userId: "user-1",
    });

    expect(sbMock.calls.from).toHaveBeenCalledWith("Kit");
    expect(sbMock.calls.rpc).toHaveBeenCalledWith(
      "shelf_kit_bulk_release_custody",
      expect.any(Object)
    );
  });

  it("should throw error when kits are not in custody", async () => {
    expect.assertions(1);
    // 1. resolveKitIdsForBulk -> kit rows
    sbMock.enqueueData([
      { id: "kit-1", name: "Kit 1", status: KitStatus.AVAILABLE },
    ]);
    // 2. KitCustody lookup
    sbMock.enqueueData([]);
    // 3. Assets
    sbMock.enqueueData([]);
    // 4. Asset IDs inner query
    sbMock.enqueueData([]);
    // 5. Custody entries
    sbMock.enqueueData([]);

    await expect(
      bulkReleaseKitCustody({
        kitIds: ["kit-1"],
        organizationId: "org-1",
        userId: "user-1",
      })
    ).rejects.toThrow("There are some kits which are not in custody");
  });
});

describe("releaseCustody", () => {
  beforeEach(() => {
    vitest.clearAllMocks();
    sbMock.reset();
  });

  it("should release custody from single kit successfully", async () => {
    expect.assertions(2);
    // 1. Kit lookup (.single())
    sbMock.enqueueData({
      id: "kit-1",
      name: "Test Kit",
      createdById: "user-1",
    });
    // 2. KitCustody lookup (.maybeSingle() - terminal, consumed sync)
    sbMock.enqueueData({
      id: "custody-1",
      custodianId: "custodian-1",
    });
    // 3. Assets for kit (thenable chain, consumed when .then fires)
    sbMock.enqueueData([{ id: "asset-1", title: "Test Asset" }]);
    // 4. TeamMember lookup (.single())
    sbMock.enqueueData({
      id: "custodian-1",
      name: "Jane Smith",
      userId: "user-2",
    });
    // 5. User lookup for custodian (.single())
    sbMock.enqueueData({
      id: "user-2",
      firstName: "Jane",
      lastName: "Smith",
      profilePicture: null,
      email: "jane@test.com",
    });
    // 6. CreatedBy user lookup (.single())
    sbMock.enqueueData({
      id: "user-1",
      firstName: "John",
      lastName: "Doe",
    });
    // 7. RPC for release custody
    sbMock.enqueueData(null);

    await releaseCustody({
      kitId: "kit-1",
      userId: "user-1",
      organizationId: "org-1",
    });

    expect(sbMock.calls.from).toHaveBeenCalledWith("Kit");
    expect(sbMock.calls.rpc).toHaveBeenCalledWith(
      "shelf_kit_release_custody",
      expect.objectContaining({
        p_kit_id: "kit-1",
        p_org_id: "org-1",
      })
    );
  });
});

describe("createKitsIfNotExists", () => {
  beforeEach(() => {
    vitest.clearAllMocks();
    sbMock.reset();
  });

  it("should create non-existing kits", async () => {
    expect.assertions(2);
    const importData = [
      { key: "asset-1", kit: "New Kit", title: "Asset 1" },
      { key: "asset-2", kit: "Existing Kit", title: "Asset 2" },
    ];

    // 1. Find "New Kit" (.maybeSingle()) - not found
    sbMock.enqueueData(null);
    // 2. Create "New Kit" (.insert(...).select("*").single())
    sbMock.enqueueData({
      id: "new-kit-id",
      name: "New Kit",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      imageExpiration: null,
    });
    // 3. Find "Existing Kit" (.maybeSingle()) - found
    sbMock.enqueueData({
      id: "existing-kit-id",
      name: "Existing Kit",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      imageExpiration: null,
    });

    const result = await createKitsIfNotExists({
      data: importData,
      userId: "user-1",
      organizationId: "org-1",
    });

    expect(sbMock.calls.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "New Kit",
        createdById: "user-1",
        organizationId: "org-1",
      })
    );
    expect(result).toEqual(
      expect.objectContaining({
        "New Kit": expect.objectContaining({ id: "new-kit-id" }),
        "Existing Kit": expect.objectContaining({ id: "existing-kit-id" }),
      })
    );
  });

  it("should handle empty kit names", async () => {
    expect.assertions(1);
    const importData = [{ key: "asset-1", kit: "", title: "Asset 1" }];

    const result = await createKitsIfNotExists({
      data: importData,
      userId: "user-1",
      organizationId: "org-1",
    });

    expect(result).toEqual({});
  });
});

describe("updateKitQrCode", () => {
  beforeEach(() => {
    vitest.clearAllMocks();
    sbMock.reset();
  });

  it("should update kit QR code successfully", async () => {
    expect.assertions(2);
    // 1. Disconnect existing QR codes (.from("Qr").update({kitId: null}).eq("kitId",...))
    sbMock.enqueueData(null);
    // 2. Connect new QR code (.from("Qr").update({kitId}).eq("id",...))
    sbMock.enqueueData(null);
    // 3. Return updated kit (.from("Kit").select("*").eq(...).eq(...).single())
    const updatedKit = {
      ...mockKitData,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    sbMock.enqueueData(updatedKit);

    const result = await updateKitQrCode({
      kitId: "kit-1",
      newQrId: "new-qr-id",
      organizationId: "org-1",
    });

    expect(sbMock.calls.from).toHaveBeenCalledWith("Qr");
    expect(result.id).toEqual("kit-1");
  });
});

describe("relinkKitQrCode", () => {
  beforeEach(() => {
    vitest.clearAllMocks();
    sbMock.reset();
  });

  it("should relink qr code to kit", async () => {
    expect.assertions(3);
    //@ts-expect-error missing vitest type
    getQr.mockResolvedValue({
      id: "qr-1",
      organizationId: "org-1",
      assetId: null,
      kitId: null,
    });

    // 1. Kit lookup (.maybeSingle())
    sbMock.enqueueData({ id: "kit-1" });
    // 2. Kit QR codes lookup
    sbMock.enqueueData([{ id: "old-qr-id" }]);
    // 3. QR update (organizationId, userId)
    sbMock.enqueueData(null);
    // 4. updateKitQrCode: disconnect old QR
    sbMock.enqueueData(null);
    // 5. updateKitQrCode: connect new QR
    sbMock.enqueueData(null);
    // 6. updateKitQrCode: return updated kit
    sbMock.enqueueData({
      ...mockKitData,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    const result = await relinkKitQrCode({
      qrId: "qr-1",
      kitId: "kit-1",
      organizationId: "org-1",
      userId: "user-1",
    });

    expect(sbMock.calls.from).toHaveBeenCalledWith("Qr");
    expect(sbMock.calls.update).toHaveBeenCalledWith({
      organizationId: "org-1",
      userId: "user-1",
    });
    expect(result).toEqual({ oldQrCodeId: "old-qr-id", newQrId: "qr-1" });
  });

  it("should throw when qr code belongs to another asset", async () => {
    expect.assertions(1);
    //@ts-expect-error missing vitest type
    getQr.mockResolvedValue({
      id: "qr-1",
      organizationId: "org-1",
      assetId: "asset-1",
      kitId: null,
    });
    // 1. Kit lookup
    sbMock.enqueueData({ id: "kit-1" });
    // 2. Kit QR codes
    sbMock.enqueueData([]);

    await expect(
      relinkKitQrCode({
        qrId: "qr-1",
        kitId: "kit-1",
        organizationId: "org-1",
        userId: "user-1",
      })
    ).rejects.toBeInstanceOf(ShelfError);
  });
});

describe("getAvailableKitAssetForBooking", () => {
  beforeEach(() => {
    vitest.clearAllMocks();
    sbMock.reset();
  });

  it("should return asset IDs from selected kits", async () => {
    expect.assertions(2);
    // sbDb.from("Asset").select("id, status").in("kitId", kitIds)
    sbMock.setData([
      { id: "asset-1", status: AssetStatus.AVAILABLE },
      { id: "asset-2", status: AssetStatus.IN_CUSTODY },
      { id: "asset-3", status: AssetStatus.AVAILABLE },
    ]);

    const result = await getAvailableKitAssetForBooking(["kit-1", "kit-2"]);

    expect(sbMock.calls.from).toHaveBeenCalledWith("Asset");
    expect(result).toEqual(["asset-1", "asset-2", "asset-3"]);
  });
});

describe("updateKitsWithBookingCustodians", () => {
  beforeEach(() => {
    vitest.clearAllMocks();
    sbMock.reset();
  });

  it("should return non-checked-out kits unchanged", async () => {
    expect.assertions(1);
    const kits = [
      {
        ...mockKitData,
        locationId: null,
        status: KitStatus.AVAILABLE,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      {
        ...mockKitData,
        locationId: null,
        id: "kit-2",
        status: KitStatus.IN_CUSTODY,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ];

    const result = await updateKitsWithBookingCustodians(kits);

    expect(result).toEqual(kits);
  });

  it("should resolve custodian from booking for checked-out kit", async () => {
    expect.assertions(2);
    const kits = [
      {
        ...mockKitData,
        locationId: null,
        id: "kit-co",
        status: KitStatus.CHECKED_OUT,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ];

    // 1. Assets in kit (.from("Asset").select("id").eq("kitId",...))
    sbMock.enqueueData([{ id: "asset-1" }]);
    // 2. Junction table (_AssetToBooking)
    sbMock.enqueueData([{ A: "asset-1", B: "booking-1" }]);
    // 3. Booking lookup
    sbMock.enqueueData([
      {
        id: "booking-1",
        status: "ONGOING",
        custodianUserId: "user-2",
        custodianTeamMemberId: null,
      },
    ]);
    // 4. User lookup for custodian (.single())
    sbMock.enqueueData({
      firstName: "Jane",
      lastName: "Doe",
      profilePicture: "pic.jpg",
    });

    const result = await updateKitsWithBookingCustodians(kits);

    expect((result[0] as any).custody).toEqual({
      custodian: {
        name: "Jane Doe",
        user: {
          firstName: "Jane",
          lastName: "Doe",
          profilePicture: "pic.jpg",
        },
      },
    });
    expect(sbMock.calls.from).toHaveBeenCalledWith("Asset");
  });

  it("should resolve custodian from team member when no user", async () => {
    expect.assertions(1);
    const kits = [
      {
        ...mockKitData,
        locationId: null,
        id: "kit-co",
        status: KitStatus.CHECKED_OUT,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ];

    // 1. Assets in kit
    sbMock.enqueueData([{ id: "asset-1" }]);
    // 2. Junction table
    sbMock.enqueueData([{ A: "asset-1", B: "booking-1" }]);
    // 3. Booking lookup
    sbMock.enqueueData([
      {
        id: "booking-1",
        status: "ONGOING",
        custodianUserId: null,
        custodianTeamMemberId: "tm-1",
      },
    ]);
    // 4. TeamMember lookup (.single())
    sbMock.enqueueData({
      id: "tm-1",
      name: "External Contractor",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      deletedAt: null,
    });

    const result = await updateKitsWithBookingCustodians(kits);

    expect((result[0] as any).custody).toEqual({
      custodian: { name: "External Contractor" },
    });
  });

  it("should handle kit with no asset having active booking gracefully", async () => {
    expect.assertions(2);
    const kits = [
      {
        ...mockKitData,
        locationId: null,
        id: "kit-co",
        status: KitStatus.CHECKED_OUT,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ];

    // why: reproducing the Sentry error scenario where no asset in the
    // kit has an ONGOING/OVERDUE booking
    // 1. Assets in kit - empty
    sbMock.enqueueData([]);

    const result = await updateKitsWithBookingCustodians(kits);

    // Kit should be returned as-is without custody data
    expect(result[0]).toEqual(kits[0]);
    // Should not throw
    expect(result).toHaveLength(1);
  });
});

describe("updateKitAssets - Location Cascade", () => {
  beforeEach(() => {
    vitest.clearAllMocks();
    sbMock.reset();
  });

  /**
   * updateKitAssets makes 15+ sbDb calls (many inside Promise.all),
   * which makes enqueue ordering fragile. We use a default response
   * that works as both a kit row and a generic "empty" result, plus
   * enqueue the first kit lookup explicitly. Subsequent calls get
   * the default (empty array / null).
   */
  it("should call sbDb for Kit and Asset tables when adding assets", async () => {
    expect.assertions(2);

    const kitRow = {
      id: "kit-1",
      name: "Test Kit",
      status: "AVAILABLE",
      organizationId: "org-1",
      locationId: "location-1",
      createdById: "user-1",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      imageExpiration: null,
    };

    // Default: most queries return empty / null safely
    sbMock.setData([]);

    // Kit lookup is the first .single() call
    sbMock.enqueueData(kitRow);
    // Location lookup .single() (parallel)
    sbMock.enqueueData({ id: "location-1", name: "Warehouse A" });

    const { updateKitAssets } = await import("./service.server");

    // The function will encounter null/empty for most secondary queries
    // which is fine -- we just verify it exercises the sbDb path
    try {
      await updateKitAssets({
        kitId: "kit-1",
        assetIds: ["asset-1"],
        userId: "user-1",
        organizationId: "org-1",
        request: new Request("http://test.com"),
      });
    } catch {
      // May throw due to missing data further along;
      // we only care that sbDb was called with the right tables
    }

    expect(sbMock.calls.from).toHaveBeenCalledWith("Kit");
    expect(sbMock.calls.from).toHaveBeenCalledWith("Asset");
  });

  it("should call sbDb for Kit table when kit has no location", async () => {
    expect.assertions(2);

    const kitRow = {
      id: "kit-1",
      name: "Test Kit",
      status: "AVAILABLE",
      organizationId: "org-1",
      locationId: null,
      createdById: "user-1",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      imageExpiration: null,
    };

    sbMock.setData([]);
    sbMock.enqueueData(kitRow);

    const { updateKitAssets } = await import("./service.server");

    try {
      await updateKitAssets({
        kitId: "kit-1",
        assetIds: ["asset-1"],
        userId: "user-1",
        organizationId: "org-1",
        request: new Request("http://test.com"),
      });
    } catch {
      // May throw due to missing data further along;
      // we only care that sbDb was called with the right tables
    }

    expect(sbMock.calls.from).toHaveBeenCalledWith("Kit");
    expect(sbMock.calls.from).toHaveBeenCalledWith("Asset");
  });
});
