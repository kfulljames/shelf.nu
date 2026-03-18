import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSupabaseMock } from "@mocks/supabase";

import { ShelfError } from "~/utils/error";

// @vitest-environment node

const sbMock = createSupabaseMock();
// why: testing service logic without actual Supabase HTTP calls
vi.mock("~/database/supabase.server", () => ({
  get sbDb() {
    return sbMock.client;
  },
}));

const { createPreset, deletePreset, listPresetsForUser, renamePreset } =
  await import("./service.server");

const mockPreset = {
  id: "preset-1",
  organizationId: "org-1",
  ownerId: "user-1",
  name: "My preset",
  query: "status=AVAILABLE",
  starred: false,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

describe("asset-filter-presets service", () => {
  beforeEach(() => {
    sbMock.reset();
  });

  describe("listPresetsForUser", () => {
    it("lists presets ordered by name", async () => {
      sbMock.setData([mockPreset]);

      const presets = await listPresetsForUser({
        organizationId: "org-1",
        ownerId: "user-1",
      });

      expect(sbMock.calls.from).toHaveBeenCalledWith("AssetFilterPreset");
      expect(sbMock.calls.select).toHaveBeenCalledWith("*");
      expect(sbMock.calls.eq).toHaveBeenCalledWith("organizationId", "org-1");
      expect(sbMock.calls.eq).toHaveBeenCalledWith("ownerId", "user-1");
      expect(sbMock.calls.order).toHaveBeenCalledWith("starred", {
        ascending: false,
      });
      expect(sbMock.calls.order).toHaveBeenCalledWith("name", {
        ascending: true,
      });
      expect(presets).toEqual([mockPreset]);
    });
  });

  describe("createPreset", () => {
    it("sanitizes query and trims name before creating a preset", async () => {
      // 1st call: count query (select with count: "exact", head: true) -> then
      sbMock.enqueue({ data: null, error: null });
      // 2nd call: duplicate name check -> maybeSingle
      sbMock.enqueue({ data: null, error: null });
      // 3rd call: insert -> single
      sbMock.enqueue({ data: mockPreset, error: null });

      await createPreset({
        organizationId: "org-1",
        ownerId: "user-1",
        name: "  Weekly overview  ",
        query: "page=2&status=AVAILABLE",
      });

      expect(sbMock.calls.insert).toHaveBeenCalledWith(
        expect.objectContaining({
          organizationId: "org-1",
          ownerId: "user-1",
          name: "Weekly overview",
          query: "status=AVAILABLE", // page param should be stripped
        })
      );
    });

    it("throws when the per-user limit is reached", async () => {
      // Count query returns count >= MAX_SAVED_FILTER_PRESETS
      // The service checks `count` from the response, so we need to simulate that
      // The chain resolves via .then, so the response object needs a `count` property
      sbMock.enqueue({ data: null, error: null });

      // We need to mock the count response specially. The service destructures { count, error }.
      // Since our mock returns { data, error }, we need to adjust.
      // Actually, Supabase count queries return { count, data, error } at the top level.
      // Our mock's `then` returns nextResponse() which gives { data, error }.
      // For the count query, the service checks `count` on the result object.
      // We need to add count to the response. Let's use setResponse for this.
      sbMock.reset();
      sbMock.enqueue({ data: null, error: null, count: 20 } as any);

      await expect(
        createPreset({
          organizationId: "org-1",
          ownerId: "user-1",
          name: "Latest",
          query: "status=AVAILABLE",
        })
      ).rejects.toBeInstanceOf(ShelfError);
    });

    it("throws when a preset with the same name already exists", async () => {
      // Count query (under limit)
      sbMock.enqueue({ data: null, error: null, count: 5 } as any);
      // Duplicate name check returns a match
      sbMock.enqueue({ data: { id: "preset-1" }, error: null });

      await expect(
        createPreset({
          organizationId: "org-1",
          ownerId: "user-1",
          name: "My preset",
          query: "status=AVAILABLE",
        })
      ).rejects.toBeInstanceOf(ShelfError);
    });

    it("throws when name is empty", async () => {
      await expect(
        createPreset({
          organizationId: "org-1",
          ownerId: "user-1",
          name: "   ",
          query: "status=AVAILABLE",
        })
      ).rejects.toBeInstanceOf(ShelfError);
    });
  });

  describe("renamePreset", () => {
    it("throws when renaming a preset that does not belong to the user", async () => {
      // Ownership check returns null (not found)
      sbMock.setData(null);

      await expect(
        renamePreset({
          id: "preset-1",
          organizationId: "org-1",
          ownerId: "user-2",
          name: "New name",
        })
      ).rejects.toBeInstanceOf(ShelfError);
    });

    it("updates preset name with trimmed value", async () => {
      // Ownership check returns preset
      sbMock.enqueue({ data: mockPreset, error: null });
      // Duplicate name check returns null
      sbMock.enqueue({ data: null, error: null });
      // Update returns updated preset
      sbMock.enqueue({
        data: { ...mockPreset, name: "Renamed" },
        error: null,
      });

      const result = await renamePreset({
        id: "preset-1",
        organizationId: "org-1",
        ownerId: "user-1",
        name: "  Renamed  ",
      });

      expect(sbMock.calls.update).toHaveBeenCalledWith({ name: "Renamed" });
      expect(result.name).toBe("Renamed");
    });

    it("returns existing preset when name is unchanged", async () => {
      // Ownership check returns preset with same name
      sbMock.enqueue({ data: mockPreset, error: null });

      const result = await renamePreset({
        id: "preset-1",
        organizationId: "org-1",
        ownerId: "user-1",
        name: "My preset",
      });

      expect(sbMock.calls.update).not.toHaveBeenCalled();
      expect(result).toEqual(mockPreset);
    });
  });

  describe("deletePreset", () => {
    it("deletes a preset owned by the user", async () => {
      // assertPresetOwnership returns preset (maybeSingle)
      sbMock.enqueue({ data: mockPreset, error: null });
      // delete call resolves
      sbMock.enqueue({ data: null, error: null });

      await deletePreset({
        id: "preset-1",
        organizationId: "org-1",
        ownerId: "user-1",
      });

      expect(sbMock.calls.delete).toHaveBeenCalled();
      expect(sbMock.calls.eq).toHaveBeenCalledWith("id", "preset-1");
    });

    it("throws when deleting a preset that does not belong to the user", async () => {
      // assertPresetOwnership returns null (not found)
      sbMock.setData(null);

      await expect(
        deletePreset({
          id: "preset-1",
          organizationId: "org-1",
          ownerId: "user-2",
        })
      ).rejects.toBeInstanceOf(ShelfError);
    });
  });
});
