import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSupabaseMock } from "@mocks/supabase";

const sbMock = createSupabaseMock();
// why: testing service logic without actual Supabase HTTP calls
vi.mock("~/database/supabase.server", () => ({
  get sbDb() {
    return sbMock.client;
  },
}));

// Mock helper functions
vi.mock("~/modules/note/helpers.server", () => ({
  // why: Helper functions are tested separately, we just need them to return predictable values
  buildCategoryChangeNote: vi.fn(),
  buildDescriptionChangeNote: vi.fn(),
  buildNameChangeNote: vi.fn(),
  buildValuationChangeNote: vi.fn(),
  resolveUserLink: vi.fn(),
}));

vi.mock("~/utils/markdoc-wrappers", () => ({
  // why: These are formatting utilities, we just need them to return formatted strings
  wrapKitsWithDataForNote: vi.fn((kit) => `kit:${kit?.name || "unknown"}`),
  wrapUserLinkForNote: vi.fn((user) => `@${user.firstName}`),
  wrapTagForNote: vi.fn((tag) => `#${tag.name}`),
  wrapLinkForNote: vi.fn((to, text) => `[${text}](${to})`),
}));

import {
  buildCategoryChangeNote,
  buildDescriptionChangeNote,
  buildNameChangeNote,
  buildValuationChangeNote,
  resolveUserLink,
} from "~/modules/note/helpers.server";
import { ShelfError } from "~/utils/error";

import {
  createAssetCategoryChangeNote,
  createAssetDescriptionChangeNote,
  createAssetNameChangeNote,
  createAssetNotesForAuditAddition,
  createAssetNotesForAuditRemoval,
  createAssetValuationChangeNote,
  createBulkKitChangeNotes,
  createNote,
  createNotes,
  deleteNote,
} from "./service.server";

describe("note service", () => {
  beforeEach(() => {
    sbMock.reset();
    vi.mocked(resolveUserLink).mockReset();
    vi.mocked(buildNameChangeNote).mockReset();
    vi.mocked(buildDescriptionChangeNote).mockReset();
    vi.mocked(buildCategoryChangeNote).mockReset();
    vi.mocked(buildValuationChangeNote).mockReset();
  });

  describe("createNote", () => {
    it("creates a single note with COMMENT type by default", async () => {
      const mockNote = {
        id: "note-1",
        content: "This is a test note",
        type: "COMMENT",
        userId: "user-1",
        assetId: "asset-1",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      sbMock.setData(mockNote);

      const result = await createNote({
        content: "This is a test note",
        userId: "user-1",
        assetId: "asset-1",
      });

      expect(sbMock.calls.from).toHaveBeenCalledWith("Note");
      expect(sbMock.calls.insert).toHaveBeenCalledWith({
        content: "This is a test note",
        type: "COMMENT",
        userId: "user-1",
        assetId: "asset-1",
      });
      expect(sbMock.calls.select).toHaveBeenCalled();
      expect(sbMock.calls.single).toHaveBeenCalled();

      expect(result).toEqual(mockNote);
    });

    it("creates a note with UPDATE type when specified", async () => {
      const mockNote = {
        id: "note-1",
        content: "Asset was updated",
        type: "UPDATE",
        userId: "user-1",
        assetId: "asset-1",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      sbMock.setData(mockNote);

      await createNote({
        content: "Asset was updated",
        type: "UPDATE",
        userId: "user-1",
        assetId: "asset-1",
      });

      expect(sbMock.calls.insert).toHaveBeenCalledWith(
        expect.objectContaining({ type: "UPDATE" })
      );
    });

    it("throws ShelfError when database operation fails", async () => {
      sbMock.setError({ message: "Database connection failed" });

      await expect(
        createNote({
          content: "Test note",
          userId: "user-1",
          assetId: "asset-1",
        })
      ).rejects.toThrow(ShelfError);

      sbMock.setError({ message: "Database connection failed" });

      await expect(
        createNote({
          content: "Test note",
          userId: "user-1",
          assetId: "asset-1",
        })
      ).rejects.toThrow("Something went wrong while creating a note");
    });
  });

  describe("createNotes", () => {
    it("creates multiple notes with the same content", async () => {
      sbMock.setResponse({ data: null, error: null, count: 3 } as any);

      const result = await createNotes({
        content: "Bulk operation note",
        userId: "user-1",
        assetIds: ["asset-1", "asset-2", "asset-3"],
      });

      expect(sbMock.calls.from).toHaveBeenCalledWith("Note");
      expect(sbMock.calls.insert).toHaveBeenCalledWith(
        [
          {
            content: "Bulk operation note",
            type: "COMMENT",
            userId: "user-1",
            assetId: "asset-1",
          },
          {
            content: "Bulk operation note",
            type: "COMMENT",
            userId: "user-1",
            assetId: "asset-2",
          },
          {
            content: "Bulk operation note",
            type: "COMMENT",
            userId: "user-1",
            assetId: "asset-3",
          },
        ],
        { count: "exact" }
      );

      expect(result.count).toBe(3);
    });

    it("creates notes with UPDATE type when specified", async () => {
      sbMock.setResponse({ data: null, error: null, count: 2 } as any);

      await createNotes({
        content: "Bulk update note",
        type: "UPDATE",
        userId: "user-1",
        assetIds: ["asset-1", "asset-2"],
      });

      expect(sbMock.calls.insert).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({ type: "UPDATE" }),
          expect.objectContaining({ type: "UPDATE" }),
        ]),
        { count: "exact" }
      );
    });

    it("handles empty asset IDs array", async () => {
      sbMock.setResponse({ data: null, error: null, count: 0 } as any);

      const result = await createNotes({
        content: "Test note",
        userId: "user-1",
        assetIds: [],
      });

      expect(sbMock.calls.insert).toHaveBeenCalledWith([], {
        count: "exact",
      });

      expect(result.count).toBe(0);
    });

    it("throws ShelfError when database operation fails", async () => {
      sbMock.setError({ message: "Database timeout" });

      await expect(
        createNotes({
          content: "Test note",
          userId: "user-1",
          assetIds: ["asset-1"],
        })
      ).rejects.toThrow(ShelfError);

      sbMock.setError({ message: "Database timeout" });

      await expect(
        createNotes({
          content: "Test note",
          userId: "user-1",
          assetIds: ["asset-1"],
        })
      ).rejects.toThrow("Something went wrong while creating notes");
    });
  });

  describe("deleteNote", () => {
    it("deletes a note for a specific user", async () => {
      sbMock.setResponse({ data: null, error: null, count: 1 } as any);

      const result = await deleteNote({
        id: "note-1",
        userId: "user-1",
      });

      expect(sbMock.calls.from).toHaveBeenCalledWith("Note");
      expect(sbMock.calls.delete).toHaveBeenCalledWith({ count: "exact" });
      expect(sbMock.calls.eq).toHaveBeenCalledWith("id", "note-1");
      expect(sbMock.calls.eq).toHaveBeenCalledWith("userId", "user-1");

      expect(result.count).toBe(1);
    });

    it("returns count of 0 when note doesn't exist or user doesn't own it", async () => {
      sbMock.setResponse({ data: null, error: null, count: 0 } as any);

      const result = await deleteNote({
        id: "nonexistent-note",
        userId: "user-1",
      });

      expect(result.count).toBe(0);
    });

    it("throws ShelfError when database operation fails", async () => {
      sbMock.setError({ message: "Database error" });

      await expect(
        deleteNote({
          id: "note-1",
          userId: "user-1",
        })
      ).rejects.toThrow(ShelfError);

      sbMock.setError({ message: "Database error" });

      await expect(
        deleteNote({
          id: "note-1",
          userId: "user-1",
        })
      ).rejects.toThrow("Something went wrong while deleting the note");
    });
  });

  describe("createBulkKitChangeNotes", () => {
    it("creates notes for newly added assets to kit", async () => {
      // First call: user lookup via .single()
      // Subsequent calls: createNote inserts via .single()
      sbMock.enqueue({
        data: { firstName: "John", lastName: "Doe" },
        error: null,
      });
      // createNote calls for each asset (2 assets)
      sbMock.enqueueData({ id: "note-1" });
      sbMock.enqueueData({ id: "note-2" });

      const kit = {
        id: "kit-1",
        name: "Camera Kit",
      };

      const result = await createBulkKitChangeNotes({
        newlyAddedAssets: [
          { id: "asset-1", title: "Camera", kit: null } as any,
          { id: "asset-2", title: "Lens", kit: null } as any,
        ],
        removedAssets: [],
        userId: "user-1",
        kit: kit as any,
      });

      // User lookup
      expect(sbMock.calls.from).toHaveBeenCalledWith("User");
      // Note inserts
      expect(sbMock.calls.from).toHaveBeenCalledWith("Note");

      // Verify insert was called for notes (2 assets added)
      expect(sbMock.calls.insert).toHaveBeenCalledTimes(2);

      // Verify the first insert contains "added" and correct data
      const firstInsertCall = sbMock.calls.insert.mock.calls[0][0];
      expect(firstInsertCall.type).toBe("UPDATE");
      expect(firstInsertCall.content).toContain("added");
      expect(firstInsertCall.assetId).toBe("asset-1");
      expect(firstInsertCall.userId).toBe("user-1");

      expect(result).toBeUndefined();
    });

    it("creates notes for assets removed from kit", async () => {
      sbMock.enqueue({
        data: { firstName: "John", lastName: "Doe" },
        error: null,
      });
      sbMock.enqueueData({ id: "note-1" });

      const kit = {
        id: "kit-1",
        name: "Camera Kit",
      };

      await createBulkKitChangeNotes({
        newlyAddedAssets: [],
        removedAssets: [{ id: "asset-3", title: "Tripod", kit: kit as any }],
        userId: "user-1",
        kit: kit as any,
      });

      // Expect insert to be called once for the removed asset
      expect(sbMock.calls.insert).toHaveBeenCalledTimes(1);

      // Verify the call has correct structure
      const call = sbMock.calls.insert.mock.calls[0][0];
      expect(call.type).toBe("UPDATE");
      expect(call.content).toContain("removed asset from");
      expect(call.assetId).toBe("asset-3");
      expect(call.userId).toBe("user-1");
    });

    it("creates notes for both added and removed assets", async () => {
      sbMock.enqueue({
        data: { firstName: "John", lastName: "Doe" },
        error: null,
      });
      // 3 createNote calls (2 added + 1 removed)
      sbMock.enqueueData({ id: "note-1" });
      sbMock.enqueueData({ id: "note-2" });
      sbMock.enqueueData({ id: "note-3" });

      const kit = {
        id: "kit-1",
        name: "Camera Kit",
      };

      await createBulkKitChangeNotes({
        newlyAddedAssets: [
          { id: "asset-1", title: "Camera", kit: null } as any,
          { id: "asset-2", title: "Lens", kit: null } as any,
        ],
        removedAssets: [{ id: "asset-3", title: "Tripod", kit: kit as any }],
        userId: "user-1",
        kit: kit as any,
      });

      // Expect insert to be called 3 times (2 added + 1 removed)
      expect(sbMock.calls.insert).toHaveBeenCalledTimes(3);
    });

    it("does nothing when no assets are added or removed", async () => {
      sbMock.enqueue({
        data: { firstName: "John", lastName: "Doe" },
        error: null,
      });
      const kit = {
        id: "kit-1",
        name: "Camera Kit",
      };

      await createBulkKitChangeNotes({
        newlyAddedAssets: [],
        removedAssets: [],
        userId: "user-1",
        kit: kit as any,
      });

      // Should not create any notes (no insert calls for Note table)
      expect(sbMock.calls.insert).not.toHaveBeenCalled();
    });
  });

  describe("createAssetNameChangeNote", () => {
    const mockLoadUserForNotes = vi.fn().mockResolvedValue({
      firstName: "John",
      lastName: "Doe",
    });

    it("creates note when name is changed", async () => {
      vi.mocked(resolveUserLink).mockResolvedValue("@John");
      vi.mocked(buildNameChangeNote).mockReturnValue(
        "@John updated the asset name from **Old Name** to **New Name**."
      );
      sbMock.setData({ id: "note-1" });

      await createAssetNameChangeNote({
        assetId: "asset-1",
        userId: "user-1",
        previousName: "Old Name",
        newName: "New Name",
        loadUserForNotes: mockLoadUserForNotes,
      });

      expect(resolveUserLink).toHaveBeenCalledWith({
        userId: "user-1",
        loadUserForNotes: mockLoadUserForNotes,
      });

      expect(buildNameChangeNote).toHaveBeenCalledWith({
        userLink: "@John",
        previous: "Old Name",
        next: "New Name",
      });

      expect(sbMock.calls.from).toHaveBeenCalledWith("Note");
      expect(sbMock.calls.insert).toHaveBeenCalledWith({
        content:
          "@John updated the asset name from **Old Name** to **New Name**.",
        type: "UPDATE",
        userId: "user-1",
        assetId: "asset-1",
      });
    });

    it("does not create note when buildNameChangeNote returns null", async () => {
      vi.mocked(resolveUserLink).mockResolvedValue("@John");
      vi.mocked(buildNameChangeNote).mockReturnValue(null);

      await createAssetNameChangeNote({
        assetId: "asset-1",
        userId: "user-1",
        previousName: "Same Name",
        newName: "Same Name",
        loadUserForNotes: mockLoadUserForNotes,
      });

      expect(sbMock.calls.insert).not.toHaveBeenCalled();
    });
  });

  describe("createAssetDescriptionChangeNote", () => {
    const mockLoadUserForNotes = vi.fn().mockResolvedValue({
      firstName: "Jane",
      lastName: "Smith",
    });

    it("creates note when description is added", async () => {
      vi.mocked(resolveUserLink).mockResolvedValue("@Jane");
      vi.mocked(buildDescriptionChangeNote).mockReturnValue(
        "@Jane added an asset description."
      );
      sbMock.setData({ id: "note-1" });

      await createAssetDescriptionChangeNote({
        assetId: "asset-1",
        userId: "user-1",
        previousDescription: null,
        newDescription: "New description",
        loadUserForNotes: mockLoadUserForNotes,
      });

      expect(sbMock.calls.insert).toHaveBeenCalled();
    });

    it("creates note when description is removed", async () => {
      vi.mocked(resolveUserLink).mockResolvedValue("@Jane");
      vi.mocked(buildDescriptionChangeNote).mockReturnValue(
        "@Jane removed the asset description."
      );
      sbMock.setData({ id: "note-1" });

      await createAssetDescriptionChangeNote({
        assetId: "asset-1",
        userId: "user-1",
        previousDescription: "Old description",
        newDescription: null,
        loadUserForNotes: mockLoadUserForNotes,
      });

      expect(sbMock.calls.insert).toHaveBeenCalled();
    });

    it("does not create note when description is unchanged", async () => {
      vi.mocked(resolveUserLink).mockResolvedValue("@Jane");
      vi.mocked(buildDescriptionChangeNote).mockReturnValue(null);

      await createAssetDescriptionChangeNote({
        assetId: "asset-1",
        userId: "user-1",
        previousDescription: "Same description",
        newDescription: "Same description",
        loadUserForNotes: mockLoadUserForNotes,
      });

      expect(sbMock.calls.insert).not.toHaveBeenCalled();
    });
  });

  describe("createAssetCategoryChangeNote", () => {
    const mockLoadUserForNotes = vi.fn().mockResolvedValue({
      firstName: "Bob",
      lastName: "Johnson",
    });

    it("creates note when category is changed", async () => {
      vi.mocked(resolveUserLink).mockResolvedValue("@Bob");
      vi.mocked(buildCategoryChangeNote).mockReturnValue(
        "@Bob changed the asset category from Electronics to Furniture."
      );
      sbMock.setData({ id: "note-1" });

      await createAssetCategoryChangeNote({
        assetId: "asset-1",
        userId: "user-1",
        previousCategory: {
          id: "cat-1",
          name: "Electronics",
          color: "#FF0000",
        },
        newCategory: { id: "cat-2", name: "Furniture", color: "#00FF00" },
        loadUserForNotes: mockLoadUserForNotes,
      });

      expect(buildCategoryChangeNote).toHaveBeenCalledWith({
        userLink: "@Bob",
        previous: { id: "cat-1", name: "Electronics", color: "#FF0000" },
        next: { id: "cat-2", name: "Furniture", color: "#00FF00" },
      });

      expect(sbMock.calls.insert).toHaveBeenCalled();
    });

    it("creates note when category is added", async () => {
      vi.mocked(resolveUserLink).mockResolvedValue("@Bob");
      vi.mocked(buildCategoryChangeNote).mockReturnValue(
        "@Bob set the asset category to Electronics."
      );
      sbMock.setData({ id: "note-1" });

      await createAssetCategoryChangeNote({
        assetId: "asset-1",
        userId: "user-1",
        previousCategory: null,
        newCategory: { id: "cat-1", name: "Electronics", color: "#FF0000" },
        loadUserForNotes: mockLoadUserForNotes,
      });

      expect(sbMock.calls.insert).toHaveBeenCalled();
    });

    it("does not create note when category is unchanged", async () => {
      vi.mocked(resolveUserLink).mockResolvedValue("@Bob");
      vi.mocked(buildCategoryChangeNote).mockReturnValue(null);

      await createAssetCategoryChangeNote({
        assetId: "asset-1",
        userId: "user-1",
        previousCategory: {
          id: "cat-1",
          name: "Electronics",
          color: "#FF0000",
        },
        newCategory: { id: "cat-1", name: "Electronics", color: "#FF0000" },
        loadUserForNotes: mockLoadUserForNotes,
      });

      expect(sbMock.calls.insert).not.toHaveBeenCalled();
    });
  });

  describe("createAssetValuationChangeNote", () => {
    const mockLoadUserForNotes = vi.fn().mockResolvedValue({
      firstName: "Alice",
      lastName: "Williams",
    });

    it("creates note when valuation is changed", async () => {
      vi.mocked(resolveUserLink).mockResolvedValue("@Alice");
      vi.mocked(buildValuationChangeNote).mockReturnValue(
        "@Alice changed the asset value from $100.00 to $150.00."
      );
      sbMock.setData({ id: "note-1" });

      await createAssetValuationChangeNote({
        assetId: "asset-1",
        userId: "user-1",
        previousValuation: 100,
        newValuation: 150,
        currency: "USD" as any,
        locale: "en-US",
        loadUserForNotes: mockLoadUserForNotes,
      });

      expect(buildValuationChangeNote).toHaveBeenCalledWith({
        userLink: "@Alice",
        previous: 100,
        next: 150,
        currency: "USD",
        locale: "en-US",
      });

      expect(sbMock.calls.insert).toHaveBeenCalled();
    });

    it("creates note when valuation is set for the first time", async () => {
      vi.mocked(resolveUserLink).mockResolvedValue("@Alice");
      vi.mocked(buildValuationChangeNote).mockReturnValue(
        "@Alice set the asset value to $200.00."
      );
      sbMock.setData({ id: "note-1" });

      await createAssetValuationChangeNote({
        assetId: "asset-1",
        userId: "user-1",
        previousValuation: null,
        newValuation: 200,
        currency: "USD" as any,
        locale: "en-US",
        loadUserForNotes: mockLoadUserForNotes,
      });

      expect(sbMock.calls.insert).toHaveBeenCalled();
    });

    it("does not create note when valuation is unchanged", async () => {
      vi.mocked(resolveUserLink).mockResolvedValue("@Alice");
      vi.mocked(buildValuationChangeNote).mockReturnValue(null);

      await createAssetValuationChangeNote({
        assetId: "asset-1",
        userId: "user-1",
        previousValuation: 100,
        newValuation: 100,
        currency: "USD" as any,
        locale: "en-US",
        loadUserForNotes: mockLoadUserForNotes,
      });

      expect(sbMock.calls.insert).not.toHaveBeenCalled();
    });
  });

  describe("createAssetNotesForAuditAddition", () => {
    it("creates notes for assets added to audit", async () => {
      // First: user lookup via maybeSingle
      sbMock.enqueue({
        data: { id: "user-1", firstName: "John", lastName: "Doe" },
        error: null,
      });
      // Second: createNotes insert (thenable, no .single())
      sbMock.enqueue({ data: null, error: null, count: 3 } as any);

      const audit = {
        id: "audit-1",
        name: "Q1 Audit",
      };

      await createAssetNotesForAuditAddition({
        assetIds: ["asset-1", "asset-2", "asset-3"],
        userId: "user-1",
        audit,
      });

      // User lookup
      expect(sbMock.calls.from).toHaveBeenCalledWith("User");
      expect(sbMock.calls.select).toHaveBeenCalledWith(
        "id, firstName, lastName"
      );
      expect(sbMock.calls.eq).toHaveBeenCalledWith("id", "user-1");
      expect(sbMock.calls.maybeSingle).toHaveBeenCalled();

      // Note creation
      expect(sbMock.calls.from).toHaveBeenCalledWith("Note");
      expect(sbMock.calls.insert).toHaveBeenCalledWith(
        [
          {
            content:
              "@John added asset to audit [Q1 Audit](/audits/audit-1/overview).",
            type: "UPDATE",
            userId: "user-1",
            assetId: "asset-1",
          },
          {
            content:
              "@John added asset to audit [Q1 Audit](/audits/audit-1/overview).",
            type: "UPDATE",
            userId: "user-1",
            assetId: "asset-2",
          },
          {
            content:
              "@John added asset to audit [Q1 Audit](/audits/audit-1/overview).",
            type: "UPDATE",
            userId: "user-1",
            assetId: "asset-3",
          },
        ],
        { count: "exact" }
      );
    });

    it("does not create notes when user is not found", async () => {
      sbMock.enqueue({ data: null, error: null });

      const audit = {
        id: "audit-1",
        name: "Q1 Audit",
      };

      await createAssetNotesForAuditAddition({
        assetIds: ["asset-1"],
        userId: "nonexistent-user",
        audit,
      });

      // insert should not have been called since user was not found
      expect(sbMock.calls.insert).not.toHaveBeenCalled();
    });

    it("does not create notes when assetIds array is empty", async () => {
      sbMock.enqueue({
        data: { id: "user-1", firstName: "John", lastName: "Doe" },
        error: null,
      });

      const audit = {
        id: "audit-1",
        name: "Q1 Audit",
      };

      await createAssetNotesForAuditAddition({
        assetIds: [],
        userId: "user-1",
        audit,
      });

      // insert should not have been called since assetIds is empty
      expect(sbMock.calls.insert).not.toHaveBeenCalled();
    });

    it("throws ShelfError when database operation fails", async () => {
      // User lookup succeeds, but createNotes insert returns an error
      sbMock.enqueue({
        data: { id: "user-1", firstName: "John", lastName: "Doe" },
        error: null,
      });
      sbMock.enqueue({ data: null, error: { message: "Database error" } });

      const audit = {
        id: "audit-1",
        name: "Q1 Audit",
      };

      await expect(
        createAssetNotesForAuditAddition({
          assetIds: ["asset-1"],
          userId: "user-1",
          audit,
        })
      ).rejects.toThrow(ShelfError);

      sbMock.enqueue({
        data: { id: "user-1", firstName: "John", lastName: "Doe" },
        error: null,
      });
      sbMock.enqueue({ data: null, error: { message: "Database error" } });

      await expect(
        createAssetNotesForAuditAddition({
          assetIds: ["asset-1"],
          userId: "user-1",
          audit,
        })
      ).rejects.toThrow(
        "Something went wrong while creating asset notes for audit addition"
      );
    });
  });

  describe("createAssetNotesForAuditRemoval", () => {
    it("creates notes for assets removed from audit", async () => {
      // First: user lookup via maybeSingle
      sbMock.enqueue({
        data: { id: "user-1", firstName: "Jane", lastName: "Smith" },
        error: null,
      });
      // Second: createNotes insert (thenable)
      sbMock.enqueue({ data: null, error: null, count: 2 } as any);

      const audit = {
        id: "audit-1",
        name: "Q1 Audit",
      };

      await createAssetNotesForAuditRemoval({
        assetIds: ["asset-1", "asset-2"],
        userId: "user-1",
        audit,
      });

      // User lookup
      expect(sbMock.calls.from).toHaveBeenCalledWith("User");
      expect(sbMock.calls.select).toHaveBeenCalledWith(
        "id, firstName, lastName"
      );
      expect(sbMock.calls.eq).toHaveBeenCalledWith("id", "user-1");
      expect(sbMock.calls.maybeSingle).toHaveBeenCalled();

      // Note creation
      expect(sbMock.calls.from).toHaveBeenCalledWith("Note");
      expect(sbMock.calls.insert).toHaveBeenCalledWith(
        [
          {
            content:
              "@Jane removed asset from audit [Q1 Audit](/audits/audit-1/overview).",
            type: "UPDATE",
            userId: "user-1",
            assetId: "asset-1",
          },
          {
            content:
              "@Jane removed asset from audit [Q1 Audit](/audits/audit-1/overview).",
            type: "UPDATE",
            userId: "user-1",
            assetId: "asset-2",
          },
        ],
        { count: "exact" }
      );
    });

    it("does not create notes when user is not found", async () => {
      sbMock.enqueue({ data: null, error: null });

      const audit = {
        id: "audit-1",
        name: "Q1 Audit",
      };

      await createAssetNotesForAuditRemoval({
        assetIds: ["asset-1"],
        userId: "nonexistent-user",
        audit,
      });

      expect(sbMock.calls.insert).not.toHaveBeenCalled();
    });

    it("does not create notes when assetIds array is empty", async () => {
      sbMock.enqueue({
        data: { id: "user-1", firstName: "Jane", lastName: "Smith" },
        error: null,
      });

      const audit = {
        id: "audit-1",
        name: "Q1 Audit",
      };

      await createAssetNotesForAuditRemoval({
        assetIds: [],
        userId: "user-1",
        audit,
      });

      expect(sbMock.calls.insert).not.toHaveBeenCalled();
    });

    it("throws ShelfError when database operation fails", async () => {
      // User lookup succeeds, but createNotes insert returns an error
      sbMock.enqueue({
        data: { id: "user-1", firstName: "Jane", lastName: "Smith" },
        error: null,
      });
      sbMock.enqueue({ data: null, error: { message: "Database error" } });

      const audit = {
        id: "audit-1",
        name: "Q1 Audit",
      };

      await expect(
        createAssetNotesForAuditRemoval({
          assetIds: ["asset-1"],
          userId: "user-1",
          audit,
        })
      ).rejects.toThrow(ShelfError);

      sbMock.enqueue({
        data: { id: "user-1", firstName: "Jane", lastName: "Smith" },
        error: null,
      });
      sbMock.enqueue({ data: null, error: { message: "Database error" } });

      await expect(
        createAssetNotesForAuditRemoval({
          assetIds: ["asset-1"],
          userId: "user-1",
          audit,
        })
      ).rejects.toThrow(
        "Something went wrong while creating asset notes for audit removal"
      );
    });
  });
});
