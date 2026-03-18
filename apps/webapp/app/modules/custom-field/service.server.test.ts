import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSupabaseMock } from "@mocks/supabase";
import { ShelfError } from "~/utils/error";

const sbMock = createSupabaseMock();
// why: testing service logic without actual Supabase HTTP calls
vi.mock("~/database/supabase.server", () => ({
  get sbDb() {
    return sbMock.client;
  },
}));

const mockRemoveCustomFieldFromAssetIndexSettings = vi.fn();

vi.mock("../asset-index-settings/service.server", () => ({
  removeCustomFieldFromAssetIndexSettings:
    mockRemoveCustomFieldFromAssetIndexSettings,
  updateAssetIndexSettingsAfterCfUpdate: vi.fn(),
  updateAssetIndexSettingsWithNewCustomFields: vi.fn(),
}));

const { softDeleteCustomField } = await import("./service.server");

describe("softDeleteCustomField", () => {
  beforeEach(() => {
    sbMock.reset();
    vi.clearAllMocks();
  });

  it("successfully soft deletes a custom field by setting deletedAt", async () => {
    const mockCustomField = {
      id: "cf-123",
      name: "Serial Number",
      organizationId: "org-123",
      type: "TEXT",
      active: true,
      required: false,
      userId: "user-123",
      options: [],
      helpText: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      deletedAt: null,
    };

    // First call: maybeSingle for find; second call: single for update
    sbMock.enqueue({ data: mockCustomField, error: null });
    sbMock.enqueue({
      data: {
        ...mockCustomField,
        name: `Serial Number_${Math.floor(Date.now() / 1000)}`,
        deletedAt: new Date().toISOString(),
      },
      error: null,
    });

    const result = await softDeleteCustomField({
      id: "cf-123",
      organizationId: "org-123",
    });

    expect(result.deletedAt).toBeTruthy();
    expect(result.name).toMatch(/^Serial Number_\d+$/);

    // Verify the correct table was queried
    expect(sbMock.calls.from).toHaveBeenCalledWith("CustomField");

    // Verify AssetIndexSettings cleanup was called
    expect(mockRemoveCustomFieldFromAssetIndexSettings).toHaveBeenCalledWith({
      customFieldName: "Serial Number",
      organizationId: "org-123",
    });
  });

  it("throws ShelfError when custom field does not exist or is already deleted", async () => {
    // maybeSingle returns null (no matching custom field)
    sbMock.setData(null);

    await expect(
      softDeleteCustomField({
        id: "non-existent",
        organizationId: "org-123",
      })
    ).rejects.toMatchObject({
      message: "The custom field you are trying to delete does not exist.",
      status: 404,
    });
  });

  it("throws ShelfError when custom field belongs to different organization", async () => {
    // maybeSingle with organizationId filter will return null
    sbMock.setData(null);

    await expect(
      softDeleteCustomField({
        id: "cf-123",
        organizationId: "org-123", // Requesting org
      })
    ).rejects.toMatchObject({
      message: "The custom field you are trying to delete does not exist.",
      status: 404,
    });
  });

  it("preserves AssetCustomFieldValue records (no CASCADE deletion)", async () => {
    const mockCustomField = {
      id: "cf-123",
      name: "Serial Number",
      organizationId: "org-123",
      type: "TEXT",
      active: true,
      required: false,
      userId: "user-123",
      options: [],
      helpText: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      deletedAt: null,
    };

    // First call: maybeSingle for find
    sbMock.enqueue({ data: mockCustomField, error: null });
    // Second call: single for update
    sbMock.enqueue({
      data: {
        ...mockCustomField,
        name: `Serial Number_${Math.floor(Date.now() / 1000)}`,
        deletedAt: new Date().toISOString(),
      },
      error: null,
    });

    const result = await softDeleteCustomField({
      id: "cf-123",
      organizationId: "org-123",
    });

    // Verify correct order: from("CustomField") called for find and then update
    // The service does select -> maybeSingle then update -> single
    // No deleteMany or CASCADE calls should happen
    expect(sbMock.calls.from).toHaveBeenCalledWith("CustomField");
    expect(sbMock.calls.delete).not.toHaveBeenCalled();

    // Verify timestamp was appended to name
    expect(result.name).toMatch(/^Serial Number_\d+$/);
  });

  it("wraps database errors in ShelfError", async () => {
    // Simulate a Supabase error on the find query
    sbMock.setError({ message: "Database connection failed", code: "500" });

    await expect(
      softDeleteCustomField({
        id: "cf-123",
        organizationId: "org-123",
      })
    ).rejects.toBeInstanceOf(ShelfError);
  });

  it("uses correct Supabase chain for find and update", async () => {
    const mockCustomField = {
      id: "cf-123",
      name: "Serial Number",
      organizationId: "org-123",
      type: "TEXT",
      active: true,
      required: false,
      userId: "user-123",
      options: [],
      helpText: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      deletedAt: null,
    };

    sbMock.enqueue({ data: mockCustomField, error: null });
    sbMock.enqueue({
      data: {
        ...mockCustomField,
        name: `Serial Number_${Math.floor(Date.now() / 1000)}`,
        deletedAt: new Date().toISOString(),
      },
      error: null,
    });

    const result = await softDeleteCustomField({
      id: "cf-123",
      organizationId: "org-123",
    });

    // Verify the chain methods were called
    expect(sbMock.calls.select).toHaveBeenCalled();
    expect(sbMock.calls.eq).toHaveBeenCalledWith("id", "cf-123");
    expect(sbMock.calls.eq).toHaveBeenCalledWith("organizationId", "org-123");
    expect(sbMock.calls.is).toHaveBeenCalledWith("deletedAt", null);
    expect(sbMock.calls.maybeSingle).toHaveBeenCalled();
    expect(sbMock.calls.update).toHaveBeenCalled();
    expect(sbMock.calls.single).toHaveBeenCalled();

    // Verify timestamp was appended to name
    expect(result.name).toMatch(/^Serial Number_\d+$/);
  });

  it("appends Unix timestamp to field name when soft deleting", async () => {
    const mockCustomField = {
      id: "cf-123",
      name: "Serial Number",
      organizationId: "org-123",
      type: "TEXT",
      active: true,
      required: false,
      userId: "user-123",
      options: [],
      helpText: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      deletedAt: null,
    };

    const timestamp = Math.floor(Date.now() / 1000);
    sbMock.enqueue({ data: mockCustomField, error: null });
    sbMock.enqueue({
      data: {
        ...mockCustomField,
        name: `Serial Number_${timestamp}`,
        deletedAt: new Date().toISOString(),
      },
      error: null,
    });

    const result = await softDeleteCustomField({
      id: "cf-123",
      organizationId: "org-123",
    });

    // Verify that the name has a timestamp appended
    expect(result.name).toMatch(/^Serial Number_\d+$/);
    expect(result.deletedAt).toBeTruthy();
  });
});
