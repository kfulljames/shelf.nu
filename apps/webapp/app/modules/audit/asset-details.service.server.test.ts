import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSupabaseMock } from "@mocks/supabase";

const sbMock = createSupabaseMock();
// why: testing service logic without actual Supabase HTTP calls
vi.mock("~/database/supabase.server", () => ({
  get sbDb() {
    return sbMock.client;
  },
}));

beforeEach(() => {
  sbMock.reset();
});

import { ShelfError } from "~/utils/error";

import {
  createAuditAssetNote,
  deleteAuditAssetNote,
  getAuditAssetDetailsCounts,
  getAuditAssetNotes,
  updateAuditAssetNote,
} from "./asset-details.service.server";

describe("audit asset details service", () => {
  describe("createAuditAssetNote", () => {
    it("successfully creates a note for an audit asset", async () => {
      const mockNote = {
        id: "note-1",
        content: "This asset needs maintenance",
        type: "COMMENT",
        userId: "user-1",
        auditSessionId: "audit-1",
        auditAssetId: "audit-asset-1",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        user: {
          id: "user-1",
          firstName: "John",
          lastName: "Doe",
          email: "john@example.com",
          profilePicture: null,
        },
      };

      sbMock.setData(mockNote);

      const result = await createAuditAssetNote({
        content: "This asset needs maintenance",
        userId: "user-1",
        auditSessionId: "audit-1",
        auditAssetId: "audit-asset-1",
      });

      expect(sbMock.calls.from).toHaveBeenCalledWith("AuditNote");
      expect(sbMock.calls.insert).toHaveBeenCalledWith({
        content: "This asset needs maintenance",
        type: "COMMENT",
        userId: "user-1",
        auditSessionId: "audit-1",
        auditAssetId: "audit-asset-1",
      });
      expect(sbMock.calls.select).toHaveBeenCalledWith(
        "*, user:User!userId(id, firstName, lastName, email, profilePicture)"
      );
      expect(sbMock.calls.single).toHaveBeenCalled();

      expect(result).toEqual(mockNote);
      expect((result as any).user?.firstName).toBe("John");
    });

    it("throws ShelfError when database operation fails", async () => {
      sbMock.setError({ message: "Database connection failed" });

      await expect(
        createAuditAssetNote({
          content: "Test note",
          userId: "user-1",
          auditSessionId: "audit-1",
          auditAssetId: "audit-asset-1",
        })
      ).rejects.toThrow(ShelfError);

      sbMock.reset();
      sbMock.setError({ message: "Database connection failed" });

      await expect(
        createAuditAssetNote({
          content: "Test note",
          userId: "user-1",
          auditSessionId: "audit-1",
          auditAssetId: "audit-asset-1",
        })
      ).rejects.toThrow("Failed to create asset note");
    });
  });

  describe("updateAuditAssetNote", () => {
    it("successfully updates a note owned by the user", async () => {
      const existingNote = {
        id: "note-1",
        content: "Original content",
        type: "COMMENT",
        userId: "user-1",
        auditSessionId: "audit-1",
        auditAssetId: "audit-asset-1",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      const updatedNote = {
        ...existingNote,
        content: "Updated content",
        user: {
          id: "user-1",
          firstName: "John",
          lastName: "Doe",
          email: "john@example.com",
          profilePicture: null,
        },
      };

      // First call: maybeSingle for finding the note
      sbMock.enqueueData(existingNote);
      // Second call: single for the update
      sbMock.enqueueData(updatedNote);

      const result = await updateAuditAssetNote({
        noteId: "note-1",
        content: "Updated content",
        userId: "user-1",
      });

      expect(sbMock.calls.from).toHaveBeenCalledWith("AuditNote");
      expect(sbMock.calls.eq).toHaveBeenCalledWith("id", "note-1");
      expect(sbMock.calls.eq).toHaveBeenCalledWith("userId", "user-1");
      expect(sbMock.calls.not).toHaveBeenCalledWith("auditAssetId", "is", null);
      expect(sbMock.calls.update).toHaveBeenCalledWith({
        content: "Updated content",
      });

      expect(result.content).toBe("Updated content");
    });

    it("throws 404 error when note is not found", async () => {
      // maybeSingle returns null data
      sbMock.setData(null);

      await expect(
        updateAuditAssetNote({
          noteId: "nonexistent-note",
          content: "Updated content",
          userId: "user-1",
        })
      ).rejects.toThrow(ShelfError);

      expect(sbMock.calls.update).not.toHaveBeenCalled();
    });

    it("throws 404 error when user doesn't own the note", async () => {
      // maybeSingle returns null because userId doesn't match
      sbMock.setData(null);

      await expect(
        updateAuditAssetNote({
          noteId: "note-1",
          content: "Updated content",
          userId: "wrong-user",
        })
      ).rejects.toThrow(ShelfError);

      expect(sbMock.calls.update).not.toHaveBeenCalled();
    });

    it("only allows updating asset-specific notes (auditAssetId not null)", async () => {
      // maybeSingle returns null
      sbMock.setData(null);

      await expect(
        updateAuditAssetNote({
          noteId: "note-1",
          content: "Updated content",
          userId: "user-1",
        })
      ).rejects.toThrow();

      // Verify the .not("auditAssetId", "is", null) filter was applied
      expect(sbMock.calls.not).toHaveBeenCalledWith("auditAssetId", "is", null);
    });
  });

  describe("deleteAuditAssetNote", () => {
    it("successfully deletes a note owned by the user", async () => {
      const existingNote = {
        id: "note-1",
        content: "Note to delete",
        type: "COMMENT",
        userId: "user-1",
        auditSessionId: "audit-1",
        auditAssetId: "audit-asset-1",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      // First call: maybeSingle for finding the note
      sbMock.enqueueData(existingNote);
      // Second call: delete (awaited, returns via .then)
      sbMock.enqueueData(null);

      const result = await deleteAuditAssetNote({
        noteId: "note-1",
        userId: "user-1",
      });

      expect(sbMock.calls.from).toHaveBeenCalledWith("AuditNote");
      expect(sbMock.calls.eq).toHaveBeenCalledWith("id", "note-1");
      expect(sbMock.calls.eq).toHaveBeenCalledWith("userId", "user-1");
      expect(sbMock.calls.not).toHaveBeenCalledWith("auditAssetId", "is", null);
      expect(sbMock.calls.delete).toHaveBeenCalled();

      expect(result).toEqual(existingNote);
    });

    it("throws 404 error when note is not found", async () => {
      sbMock.setData(null);

      await expect(
        deleteAuditAssetNote({
          noteId: "nonexistent-note",
          userId: "user-1",
        })
      ).rejects.toThrow(ShelfError);

      expect(sbMock.calls.delete).not.toHaveBeenCalled();
    });

    it("throws 404 error when user doesn't own the note", async () => {
      sbMock.setData(null);

      await expect(
        deleteAuditAssetNote({
          noteId: "note-1",
          userId: "wrong-user",
        })
      ).rejects.toThrow(ShelfError);

      expect(sbMock.calls.delete).not.toHaveBeenCalled();
    });
  });

  describe("getAuditAssetNotes", () => {
    it("fetches notes for a specific audit asset ordered by newest first", async () => {
      const mockNotes = [
        {
          id: "note-2",
          content: "Most recent note",
          type: "COMMENT",
          userId: "user-1",
          auditSessionId: "audit-1",
          auditAssetId: "audit-asset-1",
          createdAt: "2024-01-02T00:00:00.000Z",
          updatedAt: "2024-01-02T00:00:00.000Z",
          user: {
            id: "user-1",
            firstName: "John",
            lastName: "Doe",
            email: "john@example.com",
            profilePicture: null,
          },
        },
        {
          id: "note-1",
          content: "Older note",
          type: "COMMENT",
          userId: "user-2",
          auditSessionId: "audit-1",
          auditAssetId: "audit-asset-1",
          createdAt: "2024-01-01T00:00:00.000Z",
          updatedAt: "2024-01-01T00:00:00.000Z",
          user: {
            id: "user-2",
            firstName: "Jane",
            lastName: "Smith",
            email: "jane@example.com",
            profilePicture: null,
          },
        },
      ];

      sbMock.setData(mockNotes);

      const result = await getAuditAssetNotes({
        auditSessionId: "audit-1",
        auditAssetId: "audit-asset-1",
      });

      expect(sbMock.calls.from).toHaveBeenCalledWith("AuditNote");
      expect(sbMock.calls.select).toHaveBeenCalledWith(
        "*, user:User!userId(id, firstName, lastName, email, profilePicture)"
      );
      expect(sbMock.calls.eq).toHaveBeenCalledWith("auditSessionId", "audit-1");
      expect(sbMock.calls.eq).toHaveBeenCalledWith(
        "auditAssetId",
        "audit-asset-1"
      );
      expect(sbMock.calls.order).toHaveBeenCalledWith("createdAt", {
        ascending: false,
      });

      expect(result).toHaveLength(2);
      expect(result[0].content).toBe("Most recent note");
      expect(result[1].content).toBe("Older note");
    });

    it("returns empty array when no notes exist", async () => {
      sbMock.setData([]);

      const result = await getAuditAssetNotes({
        auditSessionId: "audit-1",
        auditAssetId: "audit-asset-1",
      });

      expect(result).toEqual([]);
    });

    it("throws ShelfError when database operation fails", async () => {
      sbMock.setError({ message: "Database timeout" });

      await expect(
        getAuditAssetNotes({
          auditSessionId: "audit-1",
          auditAssetId: "audit-asset-1",
        })
      ).rejects.toThrow(ShelfError);

      sbMock.reset();
      sbMock.setError({ message: "Database timeout" });

      await expect(
        getAuditAssetNotes({
          auditSessionId: "audit-1",
          auditAssetId: "audit-asset-1",
        })
      ).rejects.toThrow("Failed to fetch asset notes");
    });
  });

  describe("getAuditAssetDetailsCounts", () => {
    it("returns counts of notes and images for an audit asset", async () => {
      // First call: notes count (via .then on the chain)
      sbMock.enqueue({ data: null, error: null, count: 3 } as any);
      // Second call: images count (via .then on the chain)
      sbMock.enqueue({ data: null, error: null, count: 2 } as any);

      const result = await getAuditAssetDetailsCounts({
        auditSessionId: "audit-1",
        auditAssetId: "audit-asset-1",
      });

      expect(sbMock.calls.from).toHaveBeenCalledWith("AuditNote");
      expect(sbMock.calls.from).toHaveBeenCalledWith("AuditImage");
      expect(sbMock.calls.select).toHaveBeenCalledWith("*", {
        count: "exact",
        head: true,
      });

      expect(result).toEqual({
        notesCount: 3,
        imagesCount: 2,
      });
    });

    it("returns zero counts when no notes or images exist", async () => {
      sbMock.enqueue({ data: null, error: null, count: 0 } as any);
      sbMock.enqueue({ data: null, error: null, count: 0 } as any);

      const result = await getAuditAssetDetailsCounts({
        auditSessionId: "audit-1",
        auditAssetId: "audit-asset-1",
      });

      expect(result).toEqual({
        notesCount: 0,
        imagesCount: 0,
      });
    });

    it("executes both count queries in parallel", async () => {
      // Both queries resolve after a delay to verify parallel execution
      sbMock.enqueue({ data: null, error: null, count: 5 } as any);
      sbMock.enqueue({ data: null, error: null, count: 3 } as any);

      const startTime = Date.now();
      await getAuditAssetDetailsCounts({
        auditSessionId: "audit-1",
        auditAssetId: "audit-asset-1",
      });
      const duration = Date.now() - startTime;

      // If queries ran sequentially, it would take ~20ms
      // If parallel (using Promise.all), should be ~10ms
      expect(duration).toBeLessThan(20);
    });

    it("throws ShelfError when database operation fails", async () => {
      sbMock.enqueue({ data: null, error: { message: "Database error" } });
      sbMock.enqueue({ data: null, error: null, count: 0 } as any);

      await expect(
        getAuditAssetDetailsCounts({
          auditSessionId: "audit-1",
          auditAssetId: "audit-asset-1",
        })
      ).rejects.toThrow(ShelfError);

      sbMock.reset();
      sbMock.enqueue({ data: null, error: { message: "Database error" } });
      sbMock.enqueue({ data: null, error: null, count: 0 } as any);

      await expect(
        getAuditAssetDetailsCounts({
          auditSessionId: "audit-1",
          auditAssetId: "audit-asset-1",
        })
      ).rejects.toThrow("Failed to fetch asset details counts");
    });
  });
});
