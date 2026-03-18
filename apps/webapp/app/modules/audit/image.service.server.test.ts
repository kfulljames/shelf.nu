import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSupabaseMock } from "@mocks/supabase";

// why: We need to mock storage operations to avoid actually uploading files during tests
vi.mock("~/utils/storage.server", () => ({
  parseFileFormData: vi.fn(),
  removePublicFile: vi.fn(),
  getFileUploadPath: vi.fn(
    (params: { organizationId: string; type: string; typeId: string }) =>
      `${params.organizationId}/${params.type}/${params.typeId}/test.jpg`
  ),
}));

// why: We need to mock the Supabase admin client used for storage public URL generation
vi.mock("~/integrations/supabase/client", () => ({
  getSupabaseAdmin: vi.fn(() => ({
    storage: {
      from: () => ({
        getPublicUrl: (path: string) => ({
          data: { publicUrl: `https://storage.example.com/${path}` },
        }),
      }),
    },
  })),
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
  vi.clearAllMocks();
});

import { parseFileFormData, removePublicFile } from "~/utils/storage.server";

import {
  deleteAuditImage,
  getAuditImageCount,
  getAuditImages,
  uploadAuditImage,
} from "./image.service.server";

describe("audit image service", () => {
  describe("uploadAuditImage", () => {
    it("successfully uploads an image with valid file", async () => {
      const mockFormData = new FormData();
      const mockFile = new File(["test"], "test.jpg", { type: "image/jpeg" });
      mockFormData.append("auditImage", mockFile);

      // Mock parseFileFormData to return FormData with image and thumbnail paths
      const mockReturnFormData = new FormData();
      mockReturnFormData.append(
        "image",
        JSON.stringify({
          originalPath: "org-1/audits/audit-1/image-123.jpg",
          thumbnailPath: "org-1/audits/audit-1/image-123-thumbnail.jpg",
        })
      );
      vi.mocked(parseFileFormData).mockResolvedValue(mockReturnFormData);

      // First call: validateImageLimits count check (resolves via .then)
      sbMock.enqueue({ data: null, error: null, count: 0 } as any);
      // Second call: insert + select + single for creating the record
      sbMock.enqueueData({
        id: "img-1",
        auditSessionId: "audit-1",
        auditAssetId: null,
        organizationId: "org-1",
        imageUrl:
          "https://storage.example.com/org-1/audits/audit-1/image-123.jpg",
        thumbnailUrl:
          "https://storage.example.com/org-1/audits/audit-1/image-123-thumbnail.jpg",
        description: null,
        uploadedById: "user-1",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      const result = await uploadAuditImage({
        request: {
          formData: () => Promise.resolve(mockFormData),
        } as any,
        auditSessionId: "audit-1",
        auditAssetId: undefined,
        organizationId: "org-1",
        uploadedById: "user-1",
      });

      expect(parseFileFormData).toHaveBeenCalledWith(
        expect.objectContaining({
          request: expect.anything(),
          bucketName: "files",
          generateThumbnail: true,
          thumbnailSize: 108,
        })
      );

      expect(sbMock.calls.from).toHaveBeenCalledWith("AuditImage");
      expect(sbMock.calls.insert).toHaveBeenCalled();
      expect(result).toEqual(
        expect.objectContaining({
          id: "img-1",
          imageUrl:
            "https://storage.example.com/org-1/audits/audit-1/image-123.jpg",
        })
      );
    });

    it("throws error when no image file is provided", async () => {
      const mockFormData = new FormData();

      // Mock parseFileFormData to return FormData without image
      const mockReturnFormData = new FormData();
      vi.mocked(parseFileFormData).mockResolvedValue(mockReturnFormData);

      // validateImageLimits count check (general audit, no auditAssetId)
      sbMock.enqueue({ data: null, error: null, count: 0 } as any);

      await expect(
        uploadAuditImage({
          request: {
            formData: () => Promise.resolve(mockFormData),
          } as any,
          auditSessionId: "audit-1",
          auditAssetId: undefined,
          organizationId: "org-1",
          uploadedById: "user-1",
        })
      ).rejects.toThrow();
    });

    it("validates limit for asset-specific images (3 max)", async () => {
      vi.mocked(parseFileFormData).mockResolvedValue(new FormData());

      // validateImageLimits count check returns 3 (at limit)
      sbMock.enqueue({ data: null, error: null, count: 3 } as any);

      await expect(
        uploadAuditImage({
          request: {
            formData: () => Promise.resolve(new FormData()),
          } as any,
          auditSessionId: "audit-1",
          auditAssetId: "asset-1",
          organizationId: "org-1",
          uploadedById: "user-1",
        })
      ).rejects.toThrow();
    });

    it("validates limit for general audit images (5 max)", async () => {
      vi.mocked(parseFileFormData).mockResolvedValue(new FormData());

      // validateImageLimits count check returns 5 (at limit)
      sbMock.enqueue({ data: null, error: null, count: 5 } as any);

      await expect(
        uploadAuditImage({
          request: {
            formData: () => Promise.resolve(new FormData()),
          } as any,
          auditSessionId: "audit-1",
          auditAssetId: undefined,
          organizationId: "org-1",
          uploadedById: "user-1",
        })
      ).rejects.toThrow();
    });
  });

  describe("deleteAuditImage", () => {
    it("successfully deletes image from storage and database", async () => {
      // First call: maybeSingle for finding the image
      sbMock.enqueueData({
        id: "img-1",
        auditSessionId: "audit-1",
        auditAssetId: null,
        organizationId: "org-1",
        imageUrl: "org-1/audits/audit-1/image-123.jpg",
        thumbnailUrl: "org-1/audits/audit-1/image-123-thumbnail.jpg",
        description: null,
        uploadedById: "user-1",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      // Second call: delete (resolves via .then)
      sbMock.enqueueData(null);

      vi.mocked(removePublicFile).mockResolvedValue(undefined);

      await deleteAuditImage({
        imageId: "img-1",
        organizationId: "org-1",
      });

      expect(sbMock.calls.from).toHaveBeenCalledWith("AuditImage");
      expect(sbMock.calls.eq).toHaveBeenCalledWith("id", "img-1");
      expect(sbMock.calls.eq).toHaveBeenCalledWith("organizationId", "org-1");

      expect(removePublicFile).toHaveBeenCalledWith({
        publicUrl: "org-1/audits/audit-1/image-123.jpg",
      });

      expect(removePublicFile).toHaveBeenCalledWith({
        publicUrl: "org-1/audits/audit-1/image-123-thumbnail.jpg",
      });

      expect(sbMock.calls.delete).toHaveBeenCalled();
    });

    it("throws error when image not found", async () => {
      // maybeSingle returns null
      sbMock.setData(null);

      await expect(
        deleteAuditImage({
          imageId: "nonexistent",
          organizationId: "org-1",
        })
      ).rejects.toThrow();

      expect(sbMock.calls.delete).not.toHaveBeenCalled();
    });
  });

  describe("getAuditImages", () => {
    it("fetches all images for an audit", async () => {
      sbMock.setData([
        {
          id: "img-1",
          auditSessionId: "audit-1",
          auditAssetId: null,
          organizationId: "org-1",
          imageUrl: "org-1/audits/audit-1/image-1.jpg",
          thumbnailUrl: "org-1/audits/audit-1/image-1-thumbnail.jpg",
          description: null,
          uploadedById: "user-1",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
        {
          id: "img-2",
          auditSessionId: "audit-1",
          auditAssetId: null,
          organizationId: "org-1",
          imageUrl: "org-1/audits/audit-1/image-2.jpg",
          thumbnailUrl: "org-1/audits/audit-1/image-2-thumbnail.jpg",
          description: null,
          uploadedById: "user-1",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      ]);

      const result = await getAuditImages({
        auditSessionId: "audit-1",
        organizationId: "org-1",
      });

      expect(sbMock.calls.from).toHaveBeenCalledWith("AuditImage");
      expect(sbMock.calls.select).toHaveBeenCalledWith(
        "*, uploadedBy:User!uploadedById(id, firstName, lastName, profilePicture), auditAsset:AuditAsset!auditAssetId(id, asset:Asset!assetId(id, title))"
      );
      expect(sbMock.calls.eq).toHaveBeenCalledWith("auditSessionId", "audit-1");
      expect(sbMock.calls.eq).toHaveBeenCalledWith("organizationId", "org-1");
      expect(sbMock.calls.order).toHaveBeenCalledWith("createdAt", {
        ascending: false,
      });

      expect(result).toHaveLength(2);
    });

    it("filters images by auditAssetId when provided", async () => {
      sbMock.setData([]);

      await getAuditImages({
        auditSessionId: "audit-1",
        organizationId: "org-1",
        auditAssetId: "asset-1",
      });

      expect(sbMock.calls.eq).toHaveBeenCalledWith("auditAssetId", "asset-1");
    });
  });

  describe("getAuditImageCount", () => {
    it("counts all images for an audit", async () => {
      sbMock.setResponse({ data: null, error: null, count: 3 } as any);

      const result = await getAuditImageCount({
        auditSessionId: "audit-1",
        organizationId: "org-1",
      });

      expect(sbMock.calls.from).toHaveBeenCalledWith("AuditImage");
      expect(sbMock.calls.select).toHaveBeenCalledWith("*", {
        count: "exact",
        head: true,
      });
      expect(sbMock.calls.eq).toHaveBeenCalledWith("auditSessionId", "audit-1");
      expect(sbMock.calls.eq).toHaveBeenCalledWith("organizationId", "org-1");

      expect(result).toBe(3);
    });

    it("counts images for specific asset", async () => {
      sbMock.setResponse({ data: null, error: null, count: 2 } as any);

      const result = await getAuditImageCount({
        auditSessionId: "audit-1",
        organizationId: "org-1",
        auditAssetId: "asset-1",
      });

      expect(sbMock.calls.eq).toHaveBeenCalledWith("auditAssetId", "asset-1");

      expect(result).toBe(2);
    });
  });
});
