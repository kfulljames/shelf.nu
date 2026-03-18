import { BarcodeType } from "@prisma/client";

import { createSupabaseMock } from "@mocks/supabase";
import { ShelfError } from "~/utils/error";

import {
  createBarcode,
  createBarcodes,
  updateBarcode,
  deleteBarcodes,
  getBarcodeByValue,
  getAssetBarcodes,
  updateBarcodes,
  replaceBarcodes,
  validateBarcodeUniqueness,
  parseBarcodesFromImportData,
} from "./service.server";

// @vitest-environment node
// 👋 see https://vitest.dev/guide/environment.html#environments-for-specific-files

const sbMock = createSupabaseMock();

// why: testing barcode service logic without actual Supabase HTTP calls
vitest.mock("~/database/supabase.server", () => ({
  get sbDb() {
    return sbMock.client;
  },
}));

beforeEach(() => {
  sbMock.reset();
});

const mockBarcodeData = {
  id: "barcode-1",
  type: BarcodeType.Code128,
  value: "TEST123",
  organizationId: "org-1",
  assetId: "asset-1",
  kitId: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

const mockCreateParams = {
  type: BarcodeType.Code128,
  value: "TEST123",
  organizationId: "org-1",
  userId: "user-1",
  assetId: "asset-1",
};

describe("createBarcode", () => {
  it("should create a barcode successfully", async () => {
    expect.assertions(3);
    sbMock.setData(mockBarcodeData);

    const result = await createBarcode(mockCreateParams);

    expect(sbMock.calls.from).toHaveBeenCalledWith("Barcode");
    expect(sbMock.calls.insert).toHaveBeenCalled();
    expect(result).toEqual(mockBarcodeData);
  });

  it("should normalize barcode value to uppercase", async () => {
    expect.assertions(2);
    sbMock.setData(mockBarcodeData);

    await createBarcode({
      ...mockCreateParams,
      value: "test123",
    });

    expect(sbMock.calls.from).toHaveBeenCalledWith("Barcode");
    expect(sbMock.calls.insert).toHaveBeenCalled();
  });

  it("should throw error for invalid barcode value", async () => {
    expect.assertions(1);

    await expect(
      createBarcode({
        ...mockCreateParams,
        value: "AB", // Too short for Code128
      })
    ).rejects.toThrow(ShelfError);
  });

  it("should validate DataMatrix barcode length range", async () => {
    expect.assertions(3);

    // Test minimum length (4 characters)
    sbMock.setData(mockBarcodeData);

    await expect(
      createBarcode({
        ...mockCreateParams,
        type: BarcodeType.DataMatrix,
        value: "ABCD", // Minimum valid length
      })
    ).resolves.not.toThrow();

    // Test too short DataMatrix barcode
    await expect(
      createBarcode({
        ...mockCreateParams,
        type: BarcodeType.DataMatrix,
        value: "AB", // Too short for DataMatrix
      })
    ).rejects.toThrow(ShelfError);

    // Test too long DataMatrix barcode
    await expect(
      createBarcode({
        ...mockCreateParams,
        type: BarcodeType.DataMatrix,
        value: "A".repeat(101), // Too long for DataMatrix (max 100)
      })
    ).rejects.toThrow(ShelfError);
  });

  it("should create barcode for kit when kitId provided", async () => {
    expect.assertions(2);
    sbMock.setData(mockBarcodeData);

    await createBarcode({
      type: BarcodeType.Code128,
      value: "TEST123",
      organizationId: "org-1",
      userId: "user-1",
      kitId: "kit-1",
    });

    expect(sbMock.calls.from).toHaveBeenCalledWith("Barcode");
    expect(sbMock.calls.insert).toHaveBeenCalled();
  });

  it("should handle constraint violations with detailed validation", async () => {
    expect.assertions(1);

    // Mock Supabase constraint violation error on insert
    const constraintError = {
      code: "23505",
      message: "duplicate key value violates unique constraint on value",
    };
    // First call: insert fails with constraint error
    sbMock.enqueue({ data: null, error: constraintError });
    // Second call: validateBarcodeUniqueness query returns existing barcode
    sbMock.enqueueData([
      {
        id: "existing-1",
        value: "DUPLICATE123",
        assetId: "other-asset",
        kitId: null,
        asset: { title: "Test Asset" },
        kit: null,
      },
    ]);

    await expect(
      createBarcode({
        type: BarcodeType.Code128,
        value: "DUPLICATE123",
        organizationId: "org-1",
        userId: "user-1",
        assetId: "asset-1",
      })
    ).rejects.toThrow(
      "Some barcode values are already in use. Please use unique values."
    );
  });
});

describe("createBarcodes", () => {
  it("should create multiple barcodes successfully", async () => {
    expect.assertions(2);
    sbMock.setData(null);

    const barcodes = [
      { type: BarcodeType.Code128, value: "TEST123" },
      { type: BarcodeType.Code39, value: "ABC123" },
    ];

    await createBarcodes({
      barcodes,
      organizationId: "org-1",
      userId: "user-1",
      assetId: "asset-1",
    });

    expect(sbMock.calls.from).toHaveBeenCalledWith("Barcode");
    expect(sbMock.calls.insert).toHaveBeenCalled();
  });

  it("should handle empty barcodes array", async () => {
    expect.assertions(1);

    await createBarcodes({
      barcodes: [],
      organizationId: "org-1",
      userId: "user-1",
      assetId: "asset-1",
    });

    expect(sbMock.calls.from).not.toHaveBeenCalled();
  });

  it("should throw error for invalid barcode in batch", async () => {
    expect.assertions(1);

    const barcodes = [
      { type: BarcodeType.Code128, value: "TEST123" },
      { type: BarcodeType.Code128, value: "AB" }, // Invalid
    ];

    await expect(
      createBarcodes({
        barcodes,
        organizationId: "org-1",
        userId: "user-1",
        assetId: "asset-1",
      })
    ).rejects.toThrow(ShelfError);
  });

  it("should handle constraint violations with detailed validation", async () => {
    expect.assertions(1);

    // Mock Supabase constraint violation error on insert
    const constraintError = {
      code: "23505",
      message: "duplicate key value violates unique constraint on value",
    };
    // First call: insert fails with constraint error
    sbMock.enqueue({ data: null, error: constraintError });
    // Second call: validateBarcodeUniqueness query returns existing barcode
    sbMock.enqueueData([
      {
        id: "existing-1",
        value: "DUPLICATE123",
        assetId: "other-asset",
        kitId: null,
        asset: { title: "Test Asset" },
        kit: null,
      },
    ]);

    const barcodes = [{ type: BarcodeType.Code128, value: "DUPLICATE123" }];

    await expect(
      createBarcodes({
        barcodes,
        organizationId: "org-1",
        userId: "user-1",
        kitId: "kit-1",
      })
    ).rejects.toThrow(
      "Some barcode values are already in use. Please use unique values."
    );
  });

  it("should handle constraint violations for kit barcodes", async () => {
    expect.assertions(1);

    // Mock Supabase constraint violation error on insert
    const constraintError = {
      code: "23505",
      message: "duplicate key value violates unique constraint on value",
    };
    // First call: insert fails with constraint error
    sbMock.enqueue({ data: null, error: constraintError });
    // Second call: validateBarcodeUniqueness query returns existing barcode
    sbMock.enqueueData([
      {
        id: "existing-1",
        value: "DUPLICATE123",
        assetId: null,
        kitId: "other-kit",
        asset: null,
        kit: { name: "Test Kit" },
      },
    ]);

    const barcodes = [{ type: BarcodeType.Code128, value: "DUPLICATE123" }];

    await expect(
      createBarcodes({
        barcodes,
        organizationId: "org-1",
        userId: "user-1",
        kitId: "kit-1",
      })
    ).rejects.toThrow(
      "Some barcode values are already in use. Please use unique values."
    );
  });
});

describe("updateBarcode", () => {
  it("should update barcode successfully", async () => {
    expect.assertions(3);
    const updatedBarcode = { ...mockBarcodeData, value: "UPD123" };
    sbMock.setData(updatedBarcode);

    const result = await updateBarcode({
      id: "barcode-1",
      type: BarcodeType.Code39,
      value: "upd123",
      organizationId: "org-1",
      assetId: "asset-1",
    });

    expect(sbMock.calls.from).toHaveBeenCalledWith("Barcode");
    expect(sbMock.calls.update).toHaveBeenCalled();
    expect(result).toEqual(updatedBarcode);
  });

  it("should update only provided fields", async () => {
    expect.assertions(2);
    sbMock.setData(mockBarcodeData);

    await updateBarcode({
      id: "barcode-1",
      type: BarcodeType.Code128,
      value: "upd123",
      organizationId: "org-1",
      assetId: "asset-1",
    });

    expect(sbMock.calls.from).toHaveBeenCalledWith("Barcode");
    expect(sbMock.calls.update).toHaveBeenCalled();
  });

  it("should handle constraint violations with detailed validation", async () => {
    expect.assertions(1);

    // Mock Supabase constraint violation error on update
    const constraintError = {
      code: "23505",
      message: "duplicate key value violates unique constraint on value",
    };
    // First call: update fails with constraint error
    sbMock.enqueue({ data: null, error: constraintError });
    // Second call: validateBarcodeUniqueness query returns existing barcode
    sbMock.enqueueData([
      {
        id: "existing-1",
        value: "DUPLICATE123",
        assetId: "other-asset",
        kitId: null,
        asset: { title: "Test Asset" },
        kit: null,
      },
    ]);

    await expect(
      updateBarcode({
        id: "barcode-1",
        type: BarcodeType.Code128,
        value: "DUPLICATE123",
        organizationId: "org-1",
        assetId: "asset-1",
      })
    ).rejects.toThrow(
      "Some barcode values are already in use. Please use unique values."
    );
  });

  it("should handle constraint violations for kit barcodes", async () => {
    expect.assertions(1);

    // Mock Supabase constraint violation error on update
    const constraintError = {
      code: "23505",
      message: "duplicate key value violates unique constraint on value",
    };
    // First call: update fails with constraint error
    sbMock.enqueue({ data: null, error: constraintError });
    // Second call: validateBarcodeUniqueness query returns existing barcode
    sbMock.enqueueData([
      {
        id: "existing-1",
        value: "DUPLICATE123",
        assetId: null,
        kitId: "other-kit",
        asset: null,
        kit: { name: "Test Kit" },
      },
    ]);

    await expect(
      updateBarcode({
        id: "barcode-1",
        type: BarcodeType.Code128,
        value: "DUPLICATE123",
        organizationId: "org-1",
        kitId: "kit-1",
      })
    ).rejects.toThrow(
      "Some barcode values are already in use. Please use unique values."
    );
  });
});

describe("getBarcodeByValue", () => {
  it("should find barcode by value", async () => {
    expect.assertions(3);
    sbMock.setData(mockBarcodeData);

    const result = await getBarcodeByValue({
      value: "test123",
      organizationId: "org-1",
    });

    expect(sbMock.calls.from).toHaveBeenCalledWith("Barcode");
    expect(sbMock.calls.select).toHaveBeenCalledWith("*, Asset(*), Kit(*)");
    expect(result).toEqual(mockBarcodeData);
  });

  it("should return null when barcode not found", async () => {
    expect.assertions(1);
    sbMock.setData(null);

    const result = await getBarcodeByValue({
      value: "NOTFOUND",
      organizationId: "org-1",
    });

    expect(result).toBeNull();
  });
});

describe("getAssetBarcodes", () => {
  it("should get barcodes for asset", async () => {
    expect.assertions(4);
    const barcodes = [mockBarcodeData];
    sbMock.setData(barcodes);

    const result = await getAssetBarcodes({
      assetId: "asset-1",
      organizationId: "org-1",
    });

    expect(sbMock.calls.from).toHaveBeenCalledWith("Barcode");
    expect(sbMock.calls.select).toHaveBeenCalledWith("*");
    expect(sbMock.calls.order).toHaveBeenCalledWith("createdAt", {
      ascending: true,
    });
    expect(result).toEqual(barcodes);
  });
});

describe("updateBarcodes", () => {
  it("should update existing barcodes and create new ones", async () => {
    expect.assertions(2);
    const existingBarcodes = [
      { id: "barcode-1", type: BarcodeType.Code128, value: "OLD123" },
    ];
    // First call: fetch existing barcodes
    sbMock.enqueueData(existingBarcodes);
    // Subsequent calls: update and insert operations (resolved via .then)
    sbMock.enqueueData(null); // update barcode-1
    sbMock.enqueueData(null); // insert new barcode

    const barcodes = [
      { id: "barcode-1", type: BarcodeType.Code128, value: "UPDATED123" },
      { type: BarcodeType.Code39, value: "NEW123" }, // No ID = new barcode
    ];

    await updateBarcodes({
      barcodes,
      assetId: "asset-1",
      organizationId: "org-1",
      userId: "user-1",
    });

    expect(sbMock.calls.from).toHaveBeenCalledWith("Barcode");
    expect(sbMock.calls.update).toHaveBeenCalled();
  });

  it("should delete barcodes not in new list", async () => {
    expect.assertions(2);
    const existingBarcodes = [
      { id: "barcode-1", type: BarcodeType.Code128, value: "OLD123" },
      { id: "barcode-2", type: BarcodeType.Code39, value: "OLD456" },
    ];
    // First call: fetch existing barcodes
    sbMock.enqueueData(existingBarcodes);
    // Subsequent calls: update barcode-1 + delete barcode-2
    sbMock.enqueueData(null); // update barcode-1
    sbMock.enqueueData(null); // delete barcode-2

    const barcodes = [
      { id: "barcode-1", type: BarcodeType.Code128, value: "UPDATED123" },
      // barcode-2 is missing, so it should be deleted
    ];

    await updateBarcodes({
      barcodes,
      assetId: "asset-1",
      organizationId: "org-1",
      userId: "user-1",
    });

    expect(sbMock.calls.from).toHaveBeenCalledWith("Barcode");
    expect(sbMock.calls.delete).toHaveBeenCalled();
  });

  it("should validate all barcodes before processing", async () => {
    expect.assertions(1);

    const barcodes = [
      { type: BarcodeType.Code128, value: "AB" }, // Invalid - too short
    ];

    await expect(
      updateBarcodes({
        barcodes,
        assetId: "asset-1",
        organizationId: "org-1",
        userId: "user-1",
      })
    ).rejects.toThrow(ShelfError);
  });

  it("should handle constraint violations with detailed validation", async () => {
    expect.assertions(1);

    // First call: fetch existing barcodes (empty)
    sbMock.enqueueData([]);

    // Second call: update operation fails with constraint error
    const constraintError = {
      code: "23505",
      message: "duplicate key value violates unique constraint on value",
    };
    sbMock.enqueue({ data: null, error: constraintError });

    // Third call: insert operation (runs in parallel, may still resolve)
    sbMock.enqueueData(null);

    // Fourth call: validateBarcodeUniqueness query returns existing barcode
    sbMock.enqueueData([
      {
        id: "existing-1",
        value: "DUPLICATE123",
        assetId: "other-asset",
        kitId: null,
        asset: { title: "Test Asset" },
        kit: null,
      },
    ]);

    const barcodes = [
      { id: "barcode-1", type: BarcodeType.Code128, value: "DUPLICATE123" },
      { type: BarcodeType.Code39, value: "NEW456" }, // No ID = new barcode
    ];

    await expect(
      updateBarcodes({
        barcodes,
        assetId: "asset-1",
        organizationId: "org-1",
        userId: "user-1",
      })
    ).rejects.toThrow(
      "Some barcode values are already in use. Please use unique values."
    );
  });

  it("should handle constraint violations for kit updates", async () => {
    expect.assertions(1);

    // First call: fetch existing barcodes (empty)
    sbMock.enqueueData([]);

    // Second call: insert operation fails with constraint error
    const constraintError = {
      code: "23505",
      message: "duplicate key value violates unique constraint on value",
    };
    sbMock.enqueue({ data: null, error: constraintError });

    // Third call: validateBarcodeUniqueness query returns existing barcode
    sbMock.enqueueData([
      {
        id: "existing-1",
        value: "DUPLICATE123",
        assetId: null,
        kitId: "other-kit",
        asset: null,
        kit: { name: "Test Kit" },
      },
    ]);

    const barcodes = [{ type: BarcodeType.Code128, value: "DUPLICATE123" }];

    await expect(
      updateBarcodes({
        barcodes,
        kitId: "kit-1",
        organizationId: "org-1",
        userId: "user-1",
      })
    ).rejects.toThrow(
      "Some barcode values are already in use. Please use unique values."
    );
  });
});

describe("deleteBarcodes", () => {
  it("should delete all barcodes for asset", async () => {
    expect.assertions(3);
    sbMock.setData(null);

    await deleteBarcodes({
      assetId: "asset-1",
      organizationId: "org-1",
    });

    expect(sbMock.calls.from).toHaveBeenCalledWith("Barcode");
    expect(sbMock.calls.delete).toHaveBeenCalled();
    expect(sbMock.calls.eq).toHaveBeenCalledWith("organizationId", "org-1");
  });

  it("should delete all barcodes for kit", async () => {
    expect.assertions(3);
    sbMock.setData(null);

    await deleteBarcodes({
      kitId: "kit-1",
      organizationId: "org-1",
    });

    expect(sbMock.calls.from).toHaveBeenCalledWith("Barcode");
    expect(sbMock.calls.delete).toHaveBeenCalled();
    expect(sbMock.calls.eq).toHaveBeenCalledWith("organizationId", "org-1");
  });
});

describe("replaceBarcodes", () => {
  it("should replace all barcodes for asset", async () => {
    expect.assertions(3);
    // First call: deleteBarcodes
    sbMock.enqueueData(null);
    // Second call: createBarcodes insert
    sbMock.enqueueData(null);

    const barcodes = [
      { type: BarcodeType.Code128, value: "NEW123" },
      { type: BarcodeType.Code39, value: "NEW456" },
    ];

    await replaceBarcodes({
      barcodes,
      assetId: "asset-1",
      organizationId: "org-1",
      userId: "user-1",
    });

    // Should have called from("Barcode") for both delete and insert
    expect(sbMock.calls.from).toHaveBeenCalledWith("Barcode");
    expect(sbMock.calls.delete).toHaveBeenCalled();
    expect(sbMock.calls.insert).toHaveBeenCalled();
  });

  it("should handle empty barcodes array in replace", async () => {
    expect.assertions(2);
    // Only deleteBarcodes call
    sbMock.enqueueData(null);

    await replaceBarcodes({
      barcodes: [],
      assetId: "asset-1",
      organizationId: "org-1",
      userId: "user-1",
    });

    expect(sbMock.calls.delete).toHaveBeenCalled();
    expect(sbMock.calls.insert).not.toHaveBeenCalled();
  });
});

describe("validateBarcodeUniqueness", () => {
  it("should pass when no duplicate barcodes exist", async () => {
    expect.assertions(3);
    sbMock.setData([]);

    const barcodes = [
      { type: BarcodeType.Code128, value: "UNIQUE123" },
      { type: BarcodeType.Code39, value: "UNIQUE456" },
    ];

    await expect(
      validateBarcodeUniqueness(barcodes, "org-1")
    ).resolves.not.toThrow();

    expect(sbMock.calls.from).toHaveBeenCalledWith("Barcode");
    expect(sbMock.calls.in).toHaveBeenCalledWith("value", [
      "UNIQUE123",
      "UNIQUE456",
    ]);
  });

  it("should throw detailed error when duplicate barcode exists", async () => {
    expect.assertions(2);
    const existingBarcode = {
      id: "existing-1",
      value: "DUPLICATE123",
      assetId: "other-asset",
      kitId: null,
      asset: { title: "Existing Asset" },
      kit: null,
    };
    sbMock.setData([existingBarcode]);

    const barcodes = [{ type: BarcodeType.Code128, value: "DUPLICATE123" }];

    const error = await validateBarcodeUniqueness(barcodes, "org-1").catch(
      (e) => e
    );

    expect(error).toBeInstanceOf(ShelfError);
    expect(error.additionalData.validationErrors).toEqual({
      "barcodes[0].value": {
        message: 'This barcode value is already used by "Existing Asset"',
      },
    });
  });

  it("should filter out current item when editing", async () => {
    expect.assertions(2);
    const existingBarcode = {
      id: "existing-1",
      value: "MYBARCODE123",
      assetId: "current-asset",
      kitId: null,
      asset: { title: "Current Asset" },
      kit: null,
    };
    sbMock.setData([existingBarcode]);

    const barcodes = [{ type: BarcodeType.Code128, value: "MYBARCODE123" }];

    // Should not throw because the barcode belongs to the current asset being edited
    await expect(
      validateBarcodeUniqueness(barcodes, "org-1", "current-asset", "asset")
    ).resolves.not.toThrow();

    expect(sbMock.calls.from).toHaveBeenCalledWith("Barcode");
  });

  it("should detect duplicates within submitted barcodes", async () => {
    expect.assertions(2);
    sbMock.setData([]);

    const barcodes = [
      { type: BarcodeType.Code128, value: "DUPLICATE123" },
      { type: BarcodeType.Code39, value: "DUPLICATE123" },
    ];

    const error = await validateBarcodeUniqueness(barcodes, "org-1").catch(
      (e) => e
    );

    expect(error).toBeInstanceOf(ShelfError);
    expect(error.additionalData.validationErrors).toEqual({
      "barcodes[0].value": {
        message: "This barcode value is duplicated in the form",
      },
      "barcodes[1].value": {
        message: "This barcode value is duplicated in the form",
      },
    });
  });

  it("should handle kit relationships correctly", async () => {
    expect.assertions(1);
    const existingBarcode = {
      id: "existing-1",
      value: "KITBARCODE123",
      assetId: null,
      kitId: "other-kit",
      asset: null,
      kit: { name: "Existing Kit" },
    };
    sbMock.setData([existingBarcode]);

    const barcodes = [{ type: BarcodeType.Code128, value: "KITBARCODE123" }];

    const error = await validateBarcodeUniqueness(barcodes, "org-1").catch(
      (e) => e
    );

    expect(error.additionalData.validationErrors).toEqual({
      "barcodes[0].value": {
        message: 'This barcode value is already used by "Existing Kit"',
      },
    });
  });
});

describe("parseBarcodesFromImportData", () => {
  const mockImportData = [
    {
      key: "asset-1",
      title: "Test Asset 1",
      description: "Description 1",
      barcode_Code128: "ABCD1234",
      barcode_Code39: "ABC123",
      barcode_DataMatrix: "WXYZ5678",
    },
    {
      key: "asset-2",
      title: "Test Asset 2",
      description: "Description 2",
      barcode_Code128: "EFGH5678,IJKL9012",
      barcode_Code39: "DEF456",
      barcode_DataMatrix: "",
    },
    {
      key: "asset-3",
      title: "Test Asset 3",
      description: "Description 3",
      // No barcode data
    },
  ];

  it("should parse barcodes from import data successfully", async () => {
    expect.assertions(3);
    sbMock.setData([]);

    const result = await parseBarcodesFromImportData({
      data: mockImportData,
      userId: "user-1",
      organizationId: "org-1",
    });

    expect(result).toHaveLength(2); // Only assets with barcodes
    expect(result[0]).toEqual({
      key: "asset-1",
      title: "Test Asset 1",
      row: 2,
      barcodes: [
        { type: BarcodeType.Code128, value: "ABCD1234", existingId: undefined },
        { type: BarcodeType.Code39, value: "ABC123", existingId: undefined },
        {
          type: BarcodeType.DataMatrix,
          value: "WXYZ5678",
          existingId: undefined,
        },
      ],
    });
    expect(result[1]).toEqual({
      key: "asset-2",
      title: "Test Asset 2",
      row: 3,
      barcodes: [
        { type: BarcodeType.Code128, value: "EFGH5678", existingId: undefined },
        { type: BarcodeType.Code128, value: "IJKL9012", existingId: undefined },
        { type: BarcodeType.Code39, value: "DEF456", existingId: undefined },
      ],
    });
  });

  it("should handle empty import data", async () => {
    expect.assertions(1);

    const result = await parseBarcodesFromImportData({
      data: [],
      userId: "user-1",
      organizationId: "org-1",
    });

    expect(result).toEqual([]);
  });

  it("should handle assets with no barcode data", async () => {
    expect.assertions(1);
    const dataWithNoBarcodes = [
      {
        key: "asset-1",
        title: "Test Asset 1",
        description: "Description 1",
      },
    ];

    const result = await parseBarcodesFromImportData({
      data: dataWithNoBarcodes,
      userId: "user-1",
      organizationId: "org-1",
    });

    expect(result).toEqual([]);
  });

  it("should throw error for invalid barcode format", async () => {
    expect.assertions(1);
    const invalidData = [
      {
        key: "asset-1",
        title: "Test Asset 1",
        barcode_Code128: "AB", // Too short
      },
    ];

    await expect(
      parseBarcodesFromImportData({
        data: invalidData,
        userId: "user-1",
        organizationId: "org-1",
      })
    ).rejects.toThrow('Invalid Code128 barcode "AB" for asset "Test Asset 1"');
  });

  it("should throw error for duplicate barcodes within import data", async () => {
    expect.assertions(2);
    const duplicateData = [
      {
        key: "asset-1",
        title: "Test Asset 1",
        barcode_Code128: "DUPLICATE123",
      },
      {
        key: "asset-2",
        title: "Test Asset 2",
        barcode_Code128: "DUPLICATE123",
      },
    ];

    try {
      await parseBarcodesFromImportData({
        data: duplicateData,
        userId: "user-1",
        organizationId: "org-1",
      });
    } catch (error) {
      expect((error as ShelfError).message).toBe(
        "Some barcodes appear multiple times in the import data. Each barcode must be unique."
      );
      expect((error as ShelfError).additionalData).toMatchObject({
        duplicateBarcodes: [
          {
            value: "DUPLICATE123",
            assets: [
              { title: "Test Asset 1", type: "Code128", row: 2 },
              { title: "Test Asset 2", type: "Code128", row: 3 },
            ],
          },
        ],
      });
    }
  });

  it("should report correct type per asset when same barcode value has different types", async () => {
    expect.assertions(1);
    const mixedTypeData = [
      {
        key: "asset-1",
        title: "Test Asset 1",
        barcode_Code128: "SHARED123",
      },
      {
        key: "asset-2",
        title: "Test Asset 2",
        barcode_Code39: "SHARED123",
      },
    ];

    try {
      await parseBarcodesFromImportData({
        data: mixedTypeData,
        userId: "user-1",
        organizationId: "org-1",
      });
    } catch (error) {
      expect((error as ShelfError).additionalData).toMatchObject({
        duplicateBarcodes: [
          {
            value: "SHARED123",
            assets: [
              { title: "Test Asset 1", type: "Code128", row: 2 },
              { title: "Test Asset 2", type: "Code39", row: 3 },
            ],
          },
        ],
      });
    }
  });

  it("should throw error for barcodes already linked to assets", async () => {
    expect.assertions(1);
    const existingLinkedBarcode = {
      id: "existing-1",
      value: "LINKED123",
      assetId: "other-asset",
      kitId: null,
      asset: { title: "Existing Asset" },
      kit: null,
    };
    sbMock.setData([existingLinkedBarcode]);

    const dataWithLinkedBarcode = [
      {
        key: "asset-1",
        title: "Test Asset 1",
        barcode_Code128: "LINKED123",
      },
    ];

    await expect(
      parseBarcodesFromImportData({
        data: dataWithLinkedBarcode,
        userId: "user-1",
        organizationId: "org-1",
      })
    ).rejects.toThrow(
      "Some barcodes are already linked to other assets or kits in your organization"
    );
  });

  it("should throw error for barcodes already linked to kits", async () => {
    expect.assertions(1);
    const existingLinkedBarcode = {
      id: "existing-1",
      value: "LINKED123",
      assetId: null,
      kitId: "other-kit",
      asset: null,
      kit: { name: "Existing Kit" },
    };
    sbMock.setData([existingLinkedBarcode]);

    const dataWithLinkedBarcode = [
      {
        key: "asset-1",
        title: "Test Asset 1",
        barcode_Code128: "LINKED123",
      },
    ];

    await expect(
      parseBarcodesFromImportData({
        data: dataWithLinkedBarcode,
        userId: "user-1",
        organizationId: "org-1",
      })
    ).rejects.toThrow(
      "Some barcodes are already linked to other assets or kits in your organization"
    );
  });

  it("should handle comma-separated barcode values", async () => {
    expect.assertions(2);
    sbMock.setData([]);

    const dataWithMultipleBarcodes = [
      {
        key: "asset-1",
        title: "Test Asset 1",
        barcode_Code128: "ABC123, DEF456 , GHI789", // With spaces
      },
    ];

    const result = await parseBarcodesFromImportData({
      data: dataWithMultipleBarcodes,
      userId: "user-1",
      organizationId: "org-1",
    });

    expect(result).toHaveLength(1);
    expect(result[0].barcodes).toEqual([
      { type: BarcodeType.Code128, value: "ABC123", existingId: undefined },
      { type: BarcodeType.Code128, value: "DEF456", existingId: undefined },
      { type: BarcodeType.Code128, value: "GHI789", existingId: undefined },
    ]);
  });

  it("should normalize barcode values to uppercase", async () => {
    expect.assertions(2);
    sbMock.setData([]);

    const dataWithLowercaseBarcodes = [
      {
        key: "asset-1",
        title: "Test Asset 1",
        barcode_Code128: "abc123",
        barcode_Code39: "def456",
      },
    ];

    const result = await parseBarcodesFromImportData({
      data: dataWithLowercaseBarcodes,
      userId: "user-1",
      organizationId: "org-1",
    });

    expect(result).toHaveLength(1);
    expect(result[0].barcodes).toEqual([
      { type: BarcodeType.Code128, value: "ABC123", existingId: undefined },
      { type: BarcodeType.Code39, value: "DEF456", existingId: undefined },
    ]);
  });

  it("should filter out empty barcode values", async () => {
    expect.assertions(2);
    sbMock.setData([]);

    const dataWithEmptyValues = [
      {
        key: "asset-1",
        title: "Test Asset 1",
        barcode_Code128: "ABC123,,  ,DEF456", // Empty values and spaces
        barcode_Code39: "", // Empty string
        barcode_DataMatrix: "   ", // Only spaces
      },
    ];

    const result = await parseBarcodesFromImportData({
      data: dataWithEmptyValues,
      userId: "user-1",
      organizationId: "org-1",
    });

    expect(result).toHaveLength(1);
    expect(result[0].barcodes).toEqual([
      { type: BarcodeType.Code128, value: "ABC123", existingId: undefined },
      { type: BarcodeType.Code128, value: "DEF456", existingId: undefined },
    ]);
  });

  it("should handle mix of valid and invalid characters gracefully", async () => {
    expect.assertions(1);
    const dataWithInvalidChars = [
      {
        key: "asset-1",
        title: "Test Asset 1",
        barcode_Code128: "ABC\x00123", // Invalid character (null byte)
      },
    ];

    await expect(
      parseBarcodesFromImportData({
        data: dataWithInvalidChars,
        userId: "user-1",
        organizationId: "org-1",
      })
    ).rejects.toThrow(
      'Invalid Code128 barcode "ABC\x00123" for asset "Test Asset 1"'
    );
  });

  it("should only check barcodes within the same organization", async () => {
    expect.assertions(3);
    sbMock.setData([]);

    const result = await parseBarcodesFromImportData({
      data: mockImportData,
      userId: "user-1",
      organizationId: "org-1",
    });

    expect(result).toHaveLength(2);
    expect(sbMock.calls.in).toHaveBeenCalledWith("value", [
      "ABCD1234",
      "ABC123",
      "WXYZ5678",
      "EFGH5678",
      "IJKL9012",
      "DEF456",
    ]);
    expect(sbMock.calls.eq).toHaveBeenCalledWith("organizationId", "org-1");
  });

  it("should handle different barcode type combinations", async () => {
    expect.assertions(2);
    sbMock.setData([]);

    const mixedData = [
      {
        key: "asset-1",
        title: "Only Code128",
        barcode_Code128: "ABC123",
      },
      {
        key: "asset-2",
        title: "Only Code39",
        barcode_Code39: "DEF456",
      },
      {
        key: "asset-3",
        title: "Only DataMatrix",
        barcode_DataMatrix: "GHIJ7890",
      },
    ];

    const result = await parseBarcodesFromImportData({
      data: mixedData,
      userId: "user-1",
      organizationId: "org-1",
    });

    expect(result).toHaveLength(3);
    expect(result.map((r) => r.barcodes)).toEqual([
      [{ type: BarcodeType.Code128, value: "ABC123", existingId: undefined }],
      [{ type: BarcodeType.Code39, value: "DEF456", existingId: undefined }],
      [
        {
          type: BarcodeType.DataMatrix,
          value: "GHIJ7890",
          existingId: undefined,
        },
      ],
    ]);
  });

  it("should identify and reuse orphaned barcodes", async () => {
    expect.assertions(3);
    const orphanedBarcodes = [
      {
        id: "orphan-1",
        value: "ORPHAN123",
        assetId: null, // Orphaned - no asset
        kitId: null, // Orphaned - no kit
        asset: null,
        kit: null,
      },
      {
        id: "orphan-2",
        value: "ORPHAN456",
        assetId: null, // Orphaned - no asset
        kitId: null, // Orphaned - no kit
        asset: null,
        kit: null,
      },
    ];
    sbMock.setData(orphanedBarcodes);

    const dataWithOrphanedBarcodes = [
      {
        key: "asset-1",
        title: "Test Asset 1",
        barcode_Code128: "ORPHAN123,NEW123", // One orphaned, one new
      },
      {
        key: "asset-2",
        title: "Test Asset 2",
        barcode_Code39: "ORPHAN456", // Reuse orphaned
      },
    ];

    const result = await parseBarcodesFromImportData({
      data: dataWithOrphanedBarcodes,
      userId: "user-1",
      organizationId: "org-1",
    });

    expect(result).toHaveLength(2);
    expect(result[0].barcodes).toEqual([
      { type: BarcodeType.Code128, value: "ORPHAN123", existingId: "orphan-1" }, // Reuse orphaned
      { type: BarcodeType.Code128, value: "NEW123", existingId: undefined }, // Create new
    ]);
    expect(result[1].barcodes).toEqual([
      { type: BarcodeType.Code39, value: "ORPHAN456", existingId: "orphan-2" }, // Reuse orphaned
    ]);
  });

  it("should not reuse barcodes that are linked to assets or kits", async () => {
    expect.assertions(1);
    const linkedBarcodes = [
      {
        id: "linked-1",
        value: "LINKED123",
        assetId: "other-asset", // Linked to an asset
        kitId: null,
        asset: { title: "Other Asset" },
        kit: null,
      },
      {
        id: "linked-2",
        value: "LINKED456",
        assetId: null,
        kitId: "other-kit", // Linked to a kit
        asset: null,
        kit: { name: "Other Kit" },
      },
    ];
    sbMock.setData(linkedBarcodes);

    const dataWithLinkedBarcodes = [
      {
        key: "asset-1",
        title: "Test Asset 1",
        barcode_Code128: "LINKED123",
      },
    ];

    await expect(
      parseBarcodesFromImportData({
        data: dataWithLinkedBarcodes,
        userId: "user-1",
        organizationId: "org-1",
      })
    ).rejects.toThrow(
      "Some barcodes are already linked to other assets or kits in your organization"
    );
  });
});
