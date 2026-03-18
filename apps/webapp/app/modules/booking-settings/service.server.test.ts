import { createSupabaseMock } from "@mocks/supabase";
import { ShelfError } from "~/utils/error";

import {
  getBookingSettingsForOrganization,
  updateBookingSettings,
} from "./service.server";

// @vitest-environment node
// 👋 see https://vitest.dev/guide/environment.html#environments-for-specific-files

const sbMock = createSupabaseMock();
// why: testing booking settings service logic without actual Supabase HTTP calls
vitest.mock("~/database/supabase.server", () => ({
  get sbDb() {
    return sbMock.client;
  },
}));

const mockBookingSettingsData = {
  id: "booking-settings-1",
  bufferStartTime: 24,
  tagsRequired: true,
  maxBookingLength: 168,
  organizationId: "org-1",
  createdAt: new Date("2024-01-01T00:00:00.000Z"),
  updatedAt: new Date("2024-01-01T00:00:00.000Z"),
};

const mockOrganizationId = "org-1";

describe("getBookingSettingsForOrganization", () => {
  beforeEach(() => {
    sbMock.reset();
  });

  it("should get existing booking settings successfully", async () => {
    expect.assertions(2);
    // maybeSingle returns existing settings
    sbMock.setData(mockBookingSettingsData);

    const result = await getBookingSettingsForOrganization(mockOrganizationId);

    expect(sbMock.calls.from).toHaveBeenCalledWith("BookingSettings");
    expect(result).toEqual(mockBookingSettingsData);
  });

  it("should create new booking settings with default values when none exist", async () => {
    expect.assertions(3);
    const defaultSettings = {
      id: "booking-settings-new",
      bufferStartTime: 0,
      tagsRequired: false,
      maxBookingLength: null,
      organizationId: mockOrganizationId,
    };

    // First call (maybeSingle): no existing record found
    sbMock.enqueueData(null);
    // Second call (single after insert): returns the newly created record
    sbMock.enqueueData(defaultSettings);

    const result = await getBookingSettingsForOrganization(mockOrganizationId);

    expect(sbMock.calls.from).toHaveBeenCalledWith("BookingSettings");
    expect(sbMock.calls.insert).toHaveBeenCalledWith({
      bufferStartTime: 0,
      maxBookingLength: null,
      maxBookingLengthSkipClosedDays: false,
      tagsRequired: false,
      autoArchiveBookings: false,
      autoArchiveDays: 2,
      requireExplicitCheckinForAdmin: false,
      requireExplicitCheckinForSelfService: false,
      organizationId: mockOrganizationId,
    });
    expect(result).toEqual(defaultSettings);
  });

  it("should throw ShelfError when database operation fails", async () => {
    expect.assertions(2);
    sbMock.setError({ message: "Database connection failed" });

    await expect(
      getBookingSettingsForOrganization(mockOrganizationId)
    ).rejects.toThrow(ShelfError);

    sbMock.reset();
    sbMock.setError({ message: "Database connection failed" });

    await expect(
      getBookingSettingsForOrganization(mockOrganizationId)
    ).rejects.toMatchObject({
      message: "Failed to retrieve booking settings configuration",
      additionalData: { organizationId: mockOrganizationId },
    });
  });

  it("should handle missing organization id", async () => {
    expect.assertions(1);
    // The service will try to query with empty string; we simulate an error
    sbMock.setError({ message: "invalid input" });

    await expect(getBookingSettingsForOrganization("")).rejects.toThrow(
      ShelfError
    );
  });
});

describe("updateBookingSettings", () => {
  beforeEach(() => {
    sbMock.reset();
  });

  it("should update bufferStartTime only", async () => {
    expect.assertions(3);
    const updatedSettings = {
      ...mockBookingSettingsData,
      bufferStartTime: 48,
    };
    sbMock.setData(updatedSettings);

    const result = await updateBookingSettings({
      organizationId: mockOrganizationId,
      bufferStartTime: 48,
    });

    expect(sbMock.calls.from).toHaveBeenCalledWith("BookingSettings");
    expect(sbMock.calls.update).toHaveBeenCalledWith({ bufferStartTime: 48 });
    expect(result).toEqual(updatedSettings);
  });

  it("should update tagsRequired only", async () => {
    expect.assertions(3);
    const updatedSettings = {
      ...mockBookingSettingsData,
      tagsRequired: false,
    };
    sbMock.setData(updatedSettings);

    const result = await updateBookingSettings({
      organizationId: mockOrganizationId,
      tagsRequired: false,
    });

    expect(sbMock.calls.from).toHaveBeenCalledWith("BookingSettings");
    expect(sbMock.calls.update).toHaveBeenCalledWith({ tagsRequired: false });
    expect(result).toEqual(updatedSettings);
  });

  it("should update maxBookingLength only", async () => {
    expect.assertions(3);
    const updatedSettings = {
      ...mockBookingSettingsData,
      maxBookingLength: 72,
    };
    sbMock.setData(updatedSettings);

    const result = await updateBookingSettings({
      organizationId: mockOrganizationId,
      maxBookingLength: 72,
    });

    expect(sbMock.calls.from).toHaveBeenCalledWith("BookingSettings");
    expect(sbMock.calls.update).toHaveBeenCalledWith({
      maxBookingLength: 72,
    });
    expect(result).toEqual(updatedSettings);
  });

  it("should set maxBookingLength to null when passed null", async () => {
    expect.assertions(3);
    const updatedSettings = {
      ...mockBookingSettingsData,
      maxBookingLength: null,
    };
    sbMock.setData(updatedSettings);

    const result = await updateBookingSettings({
      organizationId: mockOrganizationId,
      maxBookingLength: null,
    });

    expect(sbMock.calls.from).toHaveBeenCalledWith("BookingSettings");
    expect(sbMock.calls.update).toHaveBeenCalledWith({
      maxBookingLength: null,
    });
    expect(result).toEqual(updatedSettings);
  });

  it("should update multiple fields at once", async () => {
    expect.assertions(3);
    const updatedSettings = {
      ...mockBookingSettingsData,
      bufferStartTime: 12,
      tagsRequired: false,
      maxBookingLength: 240,
    };
    sbMock.setData(updatedSettings);

    const result = await updateBookingSettings({
      organizationId: mockOrganizationId,
      bufferStartTime: 12,
      tagsRequired: false,
      maxBookingLength: 240,
    });

    expect(sbMock.calls.from).toHaveBeenCalledWith("BookingSettings");
    expect(sbMock.calls.update).toHaveBeenCalledWith({
      bufferStartTime: 12,
      tagsRequired: false,
      maxBookingLength: 240,
    });
    expect(result).toEqual(updatedSettings);
  });

  it("should only update provided fields and ignore undefined values", async () => {
    expect.assertions(3);
    const updatedSettings = {
      ...mockBookingSettingsData,
      bufferStartTime: 36,
    };
    sbMock.setData(updatedSettings);

    const result = await updateBookingSettings({
      organizationId: mockOrganizationId,
      bufferStartTime: 36,
      tagsRequired: undefined,
      maxBookingLength: undefined,
    });

    expect(sbMock.calls.from).toHaveBeenCalledWith("BookingSettings");
    expect(sbMock.calls.update).toHaveBeenCalledWith({
      bufferStartTime: 36,
    });
    expect(result).toEqual(updatedSettings);
  });

  it("should handle zero values correctly", async () => {
    expect.assertions(3);
    const updatedSettings = {
      ...mockBookingSettingsData,
      bufferStartTime: 0,
      maxBookingLength: 0,
    };
    sbMock.setData(updatedSettings);

    const result = await updateBookingSettings({
      organizationId: mockOrganizationId,
      bufferStartTime: 0,
      maxBookingLength: 0,
    });

    expect(sbMock.calls.from).toHaveBeenCalledWith("BookingSettings");
    expect(sbMock.calls.update).toHaveBeenCalledWith({
      bufferStartTime: 0,
      maxBookingLength: 0,
    });
    expect(result).toEqual(updatedSettings);
  });

  it("should handle false values correctly", async () => {
    expect.assertions(3);
    const updatedSettings = {
      ...mockBookingSettingsData,
      tagsRequired: false,
    };
    sbMock.setData(updatedSettings);

    const result = await updateBookingSettings({
      organizationId: mockOrganizationId,
      tagsRequired: false,
    });

    expect(sbMock.calls.from).toHaveBeenCalledWith("BookingSettings");
    expect(sbMock.calls.update).toHaveBeenCalledWith({
      tagsRequired: false,
    });
    expect(result).toEqual(updatedSettings);
  });

  it("should throw ShelfError when database operation fails", async () => {
    expect.assertions(2);
    sbMock.setError({ message: "Database connection failed" });

    await expect(
      updateBookingSettings({
        organizationId: mockOrganizationId,
        bufferStartTime: 24,
      })
    ).rejects.toThrow(ShelfError);

    sbMock.reset();
    sbMock.setError({ message: "Database connection failed" });

    await expect(
      updateBookingSettings({
        organizationId: mockOrganizationId,
        bufferStartTime: 24,
      })
    ).rejects.toMatchObject({
      message: "Failed to update booking settings configuration",
      additionalData: {
        organizationId: mockOrganizationId,
        bufferStartTime: 24,
        tagsRequired: undefined,
        maxBookingLength: undefined,
        maxBookingLengthSkipClosedDays: undefined,
        autoArchiveBookings: undefined,
        autoArchiveDays: undefined,
      },
    });
  });

  it("should handle organization not found error", async () => {
    expect.assertions(2);
    sbMock.setError({ message: "Record not found", code: "PGRST116" });

    await expect(
      updateBookingSettings({
        organizationId: "non-existent-org",
        bufferStartTime: 24,
      })
    ).rejects.toThrow(ShelfError);

    sbMock.reset();
    sbMock.setError({ message: "Record not found", code: "PGRST116" });

    await expect(
      updateBookingSettings({
        organizationId: "non-existent-org",
        bufferStartTime: 24,
      })
    ).rejects.toMatchObject({
      message: "Failed to update booking settings configuration",
      additionalData: {
        organizationId: "non-existent-org",
        bufferStartTime: 24,
        tagsRequired: undefined,
        maxBookingLength: undefined,
        maxBookingLengthSkipClosedDays: undefined,
        autoArchiveBookings: undefined,
        autoArchiveDays: undefined,
      },
    });
  });

  it("should handle missing organization id", async () => {
    expect.assertions(1);
    sbMock.setError({ message: "invalid input" });

    await expect(
      updateBookingSettings({
        organizationId: "",
        bufferStartTime: 24,
      })
    ).rejects.toThrow(ShelfError);
  });

  it("should not call update when no fields are provided", async () => {
    expect.assertions(3);
    const updatedSettings = { ...mockBookingSettingsData };
    sbMock.setData(updatedSettings);

    const result = await updateBookingSettings({
      organizationId: mockOrganizationId,
    });

    expect(sbMock.calls.from).toHaveBeenCalledWith("BookingSettings");
    expect(sbMock.calls.update).toHaveBeenCalledWith({});
    expect(result).toEqual(updatedSettings);
  });

  it("should include all parameters in error additional data", async () => {
    expect.assertions(1);
    sbMock.setError({ message: "Database connection failed" });

    await expect(
      updateBookingSettings({
        organizationId: mockOrganizationId,
        bufferStartTime: 48,
        tagsRequired: true,
        maxBookingLength: 168,
      })
    ).rejects.toMatchObject({
      message: "Failed to update booking settings configuration",
      additionalData: {
        organizationId: mockOrganizationId,
        bufferStartTime: 48,
        tagsRequired: true,
        maxBookingLength: 168,
      },
    });
  });
});
