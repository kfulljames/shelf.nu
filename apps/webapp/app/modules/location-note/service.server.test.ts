import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSupabaseMock } from "@mocks/supabase";

import {
  createLocationNote,
  createSystemLocationNote,
  deleteLocationNote,
  getLocationNotes,
} from "./service.server";

const sbMock = createSupabaseMock();
// why: testing location note service logic without actual Supabase HTTP calls
vi.mock("~/database/supabase.server", () => ({
  get sbDb() {
    return sbMock.client;
  },
}));

// why: testing error handling behavior without depending on ShelfError implementation
vi.mock("~/utils/error", () => ({
  ShelfError: class ShelfError extends Error {
    constructor(config: any) {
      super(config.message);
      Object.assign(this, config);
    }
  },
}));

describe("location note service", () => {
  beforeEach(() => {
    sbMock.reset();
  });

  describe("createLocationNote", () => {
    it("creates a note associated to the user and location", async () => {
      const note = {
        id: "lnote-1",
        content: "Manual note",
        type: "COMMENT",
        locationId: "loc-1",
        userId: "user-1",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      sbMock.setData(note);

      const result = await createLocationNote({
        content: "Manual note",
        locationId: "loc-1",
        userId: "user-1",
        type: "COMMENT",
      });

      expect(sbMock.calls.from).toHaveBeenCalledWith("LocationNote");
      expect(sbMock.calls.insert).toHaveBeenCalledWith({
        content: "Manual note",
        type: "COMMENT",
        locationId: "loc-1",
        userId: "user-1",
      });
      expect(sbMock.calls.single).toHaveBeenCalled();
      expect(result).toEqual(note);
    });

    it("allows creating a system note without a user", async () => {
      const note = {
        id: "lnote-2",
        content: "System note",
        type: "UPDATE",
        locationId: "loc-1",
        userId: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      sbMock.setData(note);

      const result = await createLocationNote({
        content: "System note",
        locationId: "loc-1",
        type: "UPDATE",
      });

      expect(sbMock.calls.from).toHaveBeenCalledWith("LocationNote");
      expect(sbMock.calls.insert).toHaveBeenCalledWith({
        content: "System note",
        type: "UPDATE",
        locationId: "loc-1",
      });
      expect(sbMock.calls.single).toHaveBeenCalled();
      expect(result).toEqual(note);
    });
  });

  describe("createSystemLocationNote", () => {
    it("forces UPDATE type and omits user linkage", async () => {
      const note = {
        id: "lnote-3",
        content: "Profile updated",
        type: "UPDATE",
        locationId: "loc-1",
        userId: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      sbMock.setData(note);

      const result = await createSystemLocationNote({
        content: "Profile updated",
        locationId: "loc-1",
      });

      expect(sbMock.calls.from).toHaveBeenCalledWith("LocationNote");
      expect(sbMock.calls.insert).toHaveBeenCalledWith({
        content: "Profile updated",
        type: "UPDATE",
        locationId: "loc-1",
      });
      expect(sbMock.calls.single).toHaveBeenCalled();
      expect(result).toEqual(note);
    });
  });

  describe("getLocationNotes", () => {
    it("returns notes when location belongs to organization", async () => {
      const notes = [
        {
          id: "lnote-1",
          content: "Manual",
          type: "COMMENT" as const,
          locationId: "loc-1",
          userId: "user-1",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          user: { firstName: "Jane", lastName: "Doe" },
        },
      ];

      // First call: location lookup (maybeSingle)
      sbMock.enqueue({ data: { id: "loc-1" }, error: null });
      // Second call: notes fetch (thenable)
      sbMock.enqueue({ data: notes, error: null });

      const result = await getLocationNotes({
        locationId: "loc-1",
        organizationId: "org-1",
      });

      expect(sbMock.calls.from).toHaveBeenCalledWith("Location");
      expect(sbMock.calls.from).toHaveBeenCalledWith("LocationNote");
      expect(sbMock.calls.eq).toHaveBeenCalledWith("id", "loc-1");
      expect(sbMock.calls.eq).toHaveBeenCalledWith("organizationId", "org-1");
      expect(sbMock.calls.order).toHaveBeenCalledWith("createdAt", {
        ascending: false,
      });

      expect(result).toEqual(notes);
    });

    it("throws when location does not belong to organization", async () => {
      // Location lookup returns null
      sbMock.enqueue({ data: null, error: null });

      await expect(
        getLocationNotes({ locationId: "loc-2", organizationId: "org-9" })
      ).rejects.toThrow("Location not found or access denied");
    });
  });

  describe("deleteLocationNote", () => {
    it("only deletes notes authored by the user", async () => {
      sbMock.setResponse({ data: null, error: null });

      const result = await deleteLocationNote({
        id: "lnote-1",
        userId: "user-1",
      });

      expect(sbMock.calls.from).toHaveBeenCalledWith("LocationNote");
      expect(sbMock.calls.delete).toHaveBeenCalledWith({ count: "exact" });
      expect(sbMock.calls.eq).toHaveBeenCalledWith("id", "lnote-1");
      expect(sbMock.calls.eq).toHaveBeenCalledWith("userId", "user-1");
      expect(result).toEqual({ count: undefined });
    });
  });
});
