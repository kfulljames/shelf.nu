import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSupabaseMock } from "@mocks/supabase";

// why: Mock the helper functions that create automatic notes to avoid database dependencies in unit tests
vi.mock("./helpers.server", () => ({
  createAuditCreationNote: vi.fn(),
  createAssetScanNote: vi.fn(),
  createAssetsAddedToAuditNote: vi.fn(),
  createAssetRemovedFromAuditNote: vi.fn(),
  createAssetsRemovedFromAuditNote: vi.fn(),
}));

// why: Mock the note service to avoid database dependencies in unit tests
vi.mock("~/modules/note/service.server", () => ({
  createAssetNotesForAuditAddition: vi.fn(),
  createAssetNotesForAuditRemoval: vi.fn(),
}));

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
  createAuditSession,
  addAssetsToAudit,
  removeAssetFromAudit,
  removeAssetsFromAudit,
  getPendingAuditsForOrganization,
} from "./service.server";

describe("audit service", () => {
  const defaultInput = {
    name: "Quarterly warehouse audit",
    description: "Check top 10 cameras",
    assetIds: ["asset-1", "asset-2"],
    organizationId: "org-1",
    createdById: "user-1",
    assignee: "user-2",
    scopeMeta: {
      contextType: "SELECTION",
      contextName: "Quarterly warehouse audit",
    },
  };

  it("creates an audit session with expected assets and assignments", async () => {
    // 1. Asset lookup: sbDb.from("Asset").select("id, title").eq(...).in(...)
    sbMock.enqueueData([
      { id: "asset-1", title: "Camera A" },
      { id: "asset-2", title: "Camera B" },
    ]);

    // 2. Session insert: sbDb.from("AuditSession").insert(...).select().single()
    sbMock.enqueueData({
      id: "audit-1",
      name: defaultInput.name,
      description: defaultInput.description,
      organizationId: defaultInput.organizationId,
      createdById: defaultInput.createdById,
      expectedAssetCount: 2,
      foundAssetCount: 0,
      missingAssetCount: 2,
      unexpectedAssetCount: 0,
      startedAt: null,
      completedAt: null,
      cancelledAt: null,
      status: "PENDING",
      scopeMeta: defaultInput.scopeMeta,
      targetId: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    // 3. AuditAsset insert (no return needed, just no error)
    sbMock.enqueueData(null);

    // 4. AuditAssignment insert (no return needed)
    sbMock.enqueueData(null);

    // 5. Session re-fetch with assignments: .select("*, assignments:AuditAssignment(*)").eq("id",...).single()
    sbMock.enqueueData({
      id: "audit-1",
      name: defaultInput.name,
      description: defaultInput.description,
      organizationId: defaultInput.organizationId,
      createdById: defaultInput.createdById,
      expectedAssetCount: 2,
      foundAssetCount: 0,
      missingAssetCount: 2,
      unexpectedAssetCount: 0,
      startedAt: null,
      completedAt: null,
      cancelledAt: null,
      status: "PENDING",
      scopeMeta: defaultInput.scopeMeta,
      targetId: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      assignments: [
        {
          id: "assignment-1",
          auditSessionId: "audit-1",
          userId: "user-2",
          role: null,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      ],
    });

    // 6. Fetch created audit assets: sbDb.from("AuditAsset").select("id, assetId").eq(...).eq(...)
    sbMock.enqueueData([
      { id: "audit-asset-1", assetId: "asset-1" },
      { id: "audit-asset-2", assetId: "asset-2" },
    ]);

    const result = await createAuditSession(defaultInput);

    expect(sbMock.calls.from).toHaveBeenCalledWith("Asset");
    expect(sbMock.calls.from).toHaveBeenCalledWith("AuditSession");
    expect(sbMock.calls.from).toHaveBeenCalledWith("AuditAsset");
    expect(sbMock.calls.from).toHaveBeenCalledWith("AuditAssignment");

    expect(sbMock.calls.in).toHaveBeenCalledWith("id", ["asset-1", "asset-2"]);

    expect(sbMock.calls.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        name: defaultInput.name,
        description: defaultInput.description,
        organizationId: defaultInput.organizationId,
        createdById: defaultInput.createdById,
        expectedAssetCount: 2,
        missingAssetCount: 2,
      })
    );

    expect(result.expectedAssets).toEqual([
      { id: "asset-1", name: "Camera A", auditAssetId: "audit-asset-1" },
      { id: "asset-2", name: "Camera B", auditAssetId: "audit-asset-2" },
    ]);
    expect(result.session.assignments).toHaveLength(1);
  });

  it("throws when no assets are provided", async () => {
    await expect(
      createAuditSession({ ...defaultInput, assetIds: [] })
    ).rejects.toBeInstanceOf(ShelfError);
  });

  it("throws when assets are missing", async () => {
    // Asset lookup returns only 1 of the 2 requested assets
    sbMock.enqueueData([{ id: "asset-1", title: "Camera A" }]);

    await expect(createAuditSession(defaultInput)).rejects.toBeInstanceOf(
      ShelfError
    );
  });

  it("deduplicates asset and assignee ids", async () => {
    // 1. Asset lookup (deduplicated to just asset-1)
    sbMock.enqueueData([{ id: "asset-1", title: "Camera A" }]);

    // 2. Session insert
    sbMock.enqueueData({
      id: "audit-1",
      name: defaultInput.name,
      description: defaultInput.description,
      organizationId: defaultInput.organizationId,
      createdById: defaultInput.createdById,
      expectedAssetCount: 1,
      missingAssetCount: 1,
      status: "PENDING",
      scopeMeta: defaultInput.scopeMeta,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    // 3. AuditAsset insert
    sbMock.enqueueData(null);

    // 4. AuditAssignment insert
    sbMock.enqueueData(null);

    // 5. Session re-fetch with assignments
    sbMock.enqueueData({
      id: "audit-1",
      name: defaultInput.name,
      assignments: [
        {
          id: "assignment-1",
          auditSessionId: "audit-1",
          userId: "user-2",
        },
      ],
    });

    // 6. Fetch created audit assets
    sbMock.enqueueData([{ id: "audit-asset-1", assetId: "asset-1" }]);

    await createAuditSession({
      ...defaultInput,
      assetIds: ["asset-1", "asset-1"],
    });

    expect(sbMock.calls.in).toHaveBeenCalledWith("id", ["asset-1"]);
  });

  describe("getPendingAuditsForOrganization", () => {
    it("returns pending audits for organization", async () => {
      const mockAudits = [
        {
          id: "audit-1",
          name: "Warehouse Audit Q1",
          createdAt: "2025-01-15T00:00:00.000Z",
          expectedAssetCount: 50,
          createdBy: { firstName: "John", lastName: "Doe" },
          assignments: [{ user: { firstName: "Jane", lastName: "Smith" } }],
        },
        {
          id: "audit-2",
          name: "Office Audit",
          createdAt: "2025-01-20T00:00:00.000Z",
          expectedAssetCount: 25,
          createdBy: { firstName: "Bob", lastName: "Wilson" },
          assignments: [],
        },
      ];

      sbMock.setData(mockAudits);

      const result = await getPendingAuditsForOrganization({
        organizationId: "org-1",
      });

      expect(sbMock.calls.from).toHaveBeenCalledWith("AuditSession");
      expect(sbMock.calls.select).toHaveBeenCalledWith(
        "id, name, createdAt, expectedAssetCount, createdBy:User!createdById(firstName, lastName), assignments:AuditAssignment(user:User!userId(firstName, lastName))"
      );
      expect(sbMock.calls.eq).toHaveBeenCalledWith("organizationId", "org-1");
      expect(sbMock.calls.eq).toHaveBeenCalledWith("status", "PENDING");
      expect(sbMock.calls.order).toHaveBeenCalledWith("createdAt", {
        ascending: false,
      });

      expect(result).toEqual(mockAudits);
    });
  });

  describe("addAssetsToAudit", () => {
    it("adds new assets to pending audit", async () => {
      // 1. Audit lookup: maybeSingle
      sbMock.enqueueData({
        id: "audit-1",
        name: "Test Audit",
        status: "PENDING",
      });

      // 2. Existing audit assets lookup (none)
      sbMock.enqueueData([]);

      // 3. AuditAsset insert
      sbMock.enqueueData(null);

      // 4. Read current session counts: single
      sbMock.enqueueData({
        expectedAssetCount: 0,
        missingAssetCount: 0,
      });

      // 5. Update session counts
      sbMock.enqueueData(null);

      const result = await addAssetsToAudit({
        auditId: "audit-1",
        assetIds: ["asset-1", "asset-2"],
        organizationId: "org-1",
        userId: "user-1",
      });

      expect(sbMock.calls.from).toHaveBeenCalledWith("AuditSession");
      expect(sbMock.calls.from).toHaveBeenCalledWith("AuditAsset");

      expect(sbMock.calls.insert).toHaveBeenCalledWith([
        {
          auditSessionId: "audit-1",
          assetId: "asset-1",
          expected: true,
          status: "PENDING",
        },
        {
          auditSessionId: "audit-1",
          assetId: "asset-2",
          expected: true,
          status: "PENDING",
        },
      ]);

      expect(sbMock.calls.update).toHaveBeenCalledWith({
        expectedAssetCount: 2,
        missingAssetCount: 2,
      });

      expect(result).toEqual({
        addedCount: 2,
        skippedCount: 0,
      });
    });

    it("filters out duplicate assets", async () => {
      // 1. Audit lookup: maybeSingle
      sbMock.enqueueData({
        id: "audit-1",
        name: "Test Audit",
        status: "PENDING",
      });

      // 2. Existing audit assets (asset-1 already exists)
      sbMock.enqueueData([{ assetId: "asset-1" }]);

      // 3. AuditAsset insert (only asset-2 and asset-3)
      sbMock.enqueueData(null);

      // 4. Read current session counts
      sbMock.enqueueData({
        expectedAssetCount: 1,
        missingAssetCount: 1,
      });

      // 5. Update session counts
      sbMock.enqueueData(null);

      const result = await addAssetsToAudit({
        auditId: "audit-1",
        assetIds: ["asset-1", "asset-2", "asset-3"],
        organizationId: "org-1",
        userId: "user-1",
      });

      expect(sbMock.calls.insert).toHaveBeenCalledWith([
        {
          auditSessionId: "audit-1",
          assetId: "asset-2",
          expected: true,
          status: "PENDING",
        },
        {
          auditSessionId: "audit-1",
          assetId: "asset-3",
          expected: true,
          status: "PENDING",
        },
      ]);

      expect(result).toEqual({
        addedCount: 2,
        skippedCount: 1,
      });
    });

    it("throws error when audit not found", async () => {
      // maybeSingle returns null
      sbMock.setData(null);

      await expect(
        addAssetsToAudit({
          auditId: "nonexistent-audit",
          assetIds: ["asset-1"],
          organizationId: "org-1",
          userId: "user-1",
        })
      ).rejects.toThrow(ShelfError);
    });

    it("throws error when audit is not PENDING", async () => {
      sbMock.enqueueData({
        id: "audit-1",
        name: "Test Audit",
        status: "COMPLETED",
      });

      await expect(
        addAssetsToAudit({
          auditId: "audit-1",
          assetIds: ["asset-1"],
          organizationId: "org-1",
          userId: "user-1",
        })
      ).rejects.toThrow(ShelfError);
    });
  });

  describe("removeAssetFromAudit", () => {
    it("removes expected asset from pending audit", async () => {
      // 1. Audit lookup: maybeSingle
      sbMock.enqueueData({
        id: "audit-1",
        name: "Test Audit",
        status: "PENDING",
      });

      // 2. AuditAsset lookup: maybeSingle
      sbMock.enqueueData({
        assetId: "asset-1",
        expected: true,
      });

      // 3. AuditAsset delete
      sbMock.enqueueData(null);

      // 4. Read current session counts: single
      sbMock.enqueueData({
        expectedAssetCount: 2,
        missingAssetCount: 2,
      });

      // 5. Update session counts
      sbMock.enqueueData(null);

      await removeAssetFromAudit({
        auditId: "audit-1",
        auditAssetId: "audit-asset-1",
        organizationId: "org-1",
        userId: "user-1",
      });

      expect(sbMock.calls.from).toHaveBeenCalledWith("AuditSession");
      expect(sbMock.calls.from).toHaveBeenCalledWith("AuditAsset");
      expect(sbMock.calls.delete).toHaveBeenCalled();
      expect(sbMock.calls.update).toHaveBeenCalledWith({
        expectedAssetCount: 1,
        missingAssetCount: 1,
      });
    });

    it("removes unexpected asset without decrementing counts", async () => {
      // 1. Audit lookup: maybeSingle
      sbMock.enqueueData({
        id: "audit-1",
        name: "Test Audit",
        status: "PENDING",
      });

      // 2. AuditAsset lookup: maybeSingle (not expected)
      sbMock.enqueueData({
        assetId: "asset-1",
        expected: false,
      });

      // 3. AuditAsset delete
      sbMock.enqueueData(null);

      await removeAssetFromAudit({
        auditId: "audit-1",
        auditAssetId: "audit-asset-1",
        organizationId: "org-1",
        userId: "user-1",
      });

      expect(sbMock.calls.delete).toHaveBeenCalled();
      expect(sbMock.calls.update).not.toHaveBeenCalled();
    });

    it("throws error when audit not found", async () => {
      // maybeSingle returns null
      sbMock.setData(null);

      await expect(
        removeAssetFromAudit({
          auditId: "nonexistent-audit",
          auditAssetId: "audit-asset-1",
          organizationId: "org-1",
          userId: "user-1",
        })
      ).rejects.toThrow(ShelfError);
    });

    it("throws error when audit is not PENDING", async () => {
      sbMock.enqueueData({
        id: "audit-1",
        name: "Test Audit",
        status: "ACTIVE",
      });

      await expect(
        removeAssetFromAudit({
          auditId: "audit-1",
          auditAssetId: "audit-asset-1",
          organizationId: "org-1",
          userId: "user-1",
        })
      ).rejects.toThrow(ShelfError);
    });

    it("throws error when audit asset not found", async () => {
      // 1. Audit lookup: maybeSingle (found, PENDING)
      sbMock.enqueueData({
        id: "audit-1",
        name: "Test Audit",
        status: "PENDING",
      });

      // 2. AuditAsset lookup: maybeSingle (not found)
      sbMock.enqueueData(null);

      await expect(
        removeAssetFromAudit({
          auditId: "audit-1",
          auditAssetId: "nonexistent-asset",
          organizationId: "org-1",
          userId: "user-1",
        })
      ).rejects.toThrow(ShelfError);
    });
  });

  describe("removeAssetsFromAudit", () => {
    it("removes multiple assets from pending audit", async () => {
      // 1. Audit lookup: maybeSingle
      sbMock.enqueueData({
        id: "audit-1",
        name: "Test Audit",
        status: "PENDING",
      });

      // 2. Fetch audit assets to get details
      sbMock.enqueueData([
        { id: "audit-asset-1", assetId: "asset-1", expected: true },
        { id: "audit-asset-2", assetId: "asset-2", expected: true },
        { id: "audit-asset-3", assetId: "asset-3", expected: false },
      ]);

      // 3. Delete audit assets
      sbMock.enqueueData(null);

      // 4. Read current session counts: single
      sbMock.enqueueData({
        expectedAssetCount: 5,
        missingAssetCount: 5,
      });

      // 5. Update session counts
      sbMock.enqueueData(null);

      const result = await removeAssetsFromAudit({
        auditId: "audit-1",
        auditAssetIds: ["audit-asset-1", "audit-asset-2", "audit-asset-3"],
        organizationId: "org-1",
        userId: "user-1",
      });

      expect(sbMock.calls.delete).toHaveBeenCalled();
      expect(sbMock.calls.in).toHaveBeenCalledWith("id", [
        "audit-asset-1",
        "audit-asset-2",
        "audit-asset-3",
      ]);

      expect(sbMock.calls.update).toHaveBeenCalledWith({
        expectedAssetCount: 3,
        missingAssetCount: 3,
      });

      expect(result).toEqual({ removedCount: 3 });
    });

    it("returns zero when no assets found", async () => {
      // 1. Audit lookup: maybeSingle
      sbMock.enqueueData({
        id: "audit-1",
        name: "Test Audit",
        status: "PENDING",
      });

      // 2. Fetch audit assets (none found)
      sbMock.enqueueData([]);

      const result = await removeAssetsFromAudit({
        auditId: "audit-1",
        auditAssetIds: ["nonexistent-1", "nonexistent-2"],
        organizationId: "org-1",
        userId: "user-1",
      });

      expect(sbMock.calls.delete).not.toHaveBeenCalled();
      expect(result).toEqual({ removedCount: 0 });
    });

    it("throws error when audit not found", async () => {
      // maybeSingle returns null
      sbMock.setData(null);

      await expect(
        removeAssetsFromAudit({
          auditId: "nonexistent-audit",
          auditAssetIds: ["audit-asset-1"],
          organizationId: "org-1",
          userId: "user-1",
        })
      ).rejects.toThrow(ShelfError);
    });

    it("throws error when audit is not PENDING", async () => {
      sbMock.enqueueData({
        id: "audit-1",
        name: "Test Audit",
        status: "COMPLETED",
      });

      await expect(
        removeAssetsFromAudit({
          auditId: "audit-1",
          auditAssetIds: ["audit-asset-1"],
          organizationId: "org-1",
          userId: "user-1",
        })
      ).rejects.toThrow(ShelfError);
    });
  });
});
