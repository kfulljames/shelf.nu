import { makeShelfError } from "~/utils/error";
import { requirePermission } from "~/utils/roles.server";
import { loader } from "~/routes/api+/kits";
import { createLoaderArgs } from "@mocks/remix";
import { createSupabaseMock } from "@mocks/supabase";

// @vitest-environment node
// see https://vitest.dev/guide/environment.html#environments-for-specific-files

const sbMock = createSupabaseMock();

// why: mocking Remix's data() function to return Response objects for React Router v7 single fetch
const createDataMock = vitest.hoisted(() => {
  return () =>
    vitest.fn((data: unknown, init?: ResponseInit) => {
      return new Response(JSON.stringify(data), {
        status: init?.status || 200,
        headers: {
          "Content-Type": "application/json",
          ...(init?.headers || {}),
        },
      });
    });
});

vitest.mock("react-router", async () => {
  const actual = await vitest.importActual("react-router");
  return {
    ...actual,
    data: createDataMock(),
  };
});

// why: testing route handler without actual Supabase HTTP calls
vitest.mock("~/database/supabase.server", () => ({
  get sbDb() {
    return sbMock.client;
  },
}));

vitest.mock("~/utils/roles.server", () => ({
  requirePermission: vitest.fn(),
}));

vitest.mock("~/utils/error", () => ({
  makeShelfError: vitest.fn(),
}));

const mockContext = {
  getSession: () => ({ userId: "user-1" }),
  appVersion: "test",
  isAuthenticated: true,
  setSession: vi.fn(),
  destroySession: vi.fn(),
  errorMessage: null,
} as any;

const mockKitRows = [
  {
    id: "kit-1",
    name: "Photography Kit",
    image: "kit-image-1.jpg",
    imageExpiration: "2024-12-31T23:59:59Z",
  },
  {
    id: "kit-2",
    name: "Video Production Kit",
    image: "kit-image-2.jpg",
    imageExpiration: "2024-12-31T23:59:59Z",
  },
];

const mockAssetRows = [
  {
    id: "asset-1",
    title: "Canon Camera",
    mainImage: "camera.jpg",
    mainImageExpiration: "2024-12-31T23:59:59Z",
    kitId: "kit-1",
    category: { name: "Cameras" },
  },
  {
    id: "asset-2",
    title: "Tripod",
    mainImage: "tripod.jpg",
    mainImageExpiration: "2024-12-31T23:59:59Z",
    kitId: "kit-1",
    category: { name: "Accessories" },
  },
  {
    id: "asset-3",
    title: "Video Camera",
    mainImage: "video-camera.jpg",
    mainImageExpiration: "2024-12-31T23:59:59Z",
    kitId: "kit-2",
    category: { name: "Cameras" },
  },
];

describe("/api/kits", () => {
  beforeEach(() => {
    vitest.clearAllMocks();
    sbMock.reset();
    (requirePermission as any).mockResolvedValue({
      organizationId: "org-1",
    });
  });

  describe("loader", () => {
    it("should return kits for valid IDs", async () => {
      const mockRequest = new Request(
        "http://localhost:3000/api/kits?ids=kit-1,kit-2"
      );

      // First sbDb call: kit rows
      sbMock.enqueueData(mockKitRows);
      // Second sbDb call: asset rows for kits
      sbMock.enqueueData(mockAssetRows);

      const result = await loader(
        createLoaderArgs({
          request: mockRequest,
          context: mockContext,
          params: {},
        })
      );

      expect(requirePermission).toHaveBeenCalledWith({
        request: mockRequest,
        userId: "user-1",
        entity: "kit",
        action: "read",
      });

      // Verify sbDb was called
      expect(sbMock.calls.from).toHaveBeenCalledWith("Kit");
      expect(sbMock.calls.from).toHaveBeenCalledWith("Asset");

      // Success case returns Response wrapping the payload
      expect(result instanceof Response).toBe(true);
      const responseData = await (result as unknown as Response).json();
      expect(responseData.error).toBeNull();
      expect(responseData.kits).toHaveLength(2);
      // Verify kit-1 has 2 assets, kit-2 has 1
      expect(responseData.kits[0]._count.assets).toBe(2);
      expect(responseData.kits[1]._count.assets).toBe(1);
    });

    it("should return empty array when no ids parameter provided", async () => {
      const mockRequest = new Request("http://localhost:3000/api/kits");

      const result = await loader(
        createLoaderArgs({
          request: mockRequest,
          context: mockContext,
          params: {},
        })
      );

      // Success case returns Response wrapping the payload
      expect(result instanceof Response).toBe(true);
      const responseData = await (result as unknown as Response).json();
      expect(responseData).toEqual({
        error: null,
        kits: [],
      });

      expect(sbMock.calls.from).not.toHaveBeenCalled();
    });

    it("should return empty array when ids parameter is empty", async () => {
      const mockRequest = new Request("http://localhost:3000/api/kits?ids=");

      const result = await loader(
        createLoaderArgs({
          request: mockRequest,
          context: mockContext,
          params: {},
        })
      );

      // Success case returns Response wrapping the payload
      expect(result instanceof Response).toBe(true);
      const responseData = await (result as unknown as Response).json();
      expect(responseData).toEqual({
        error: null,
        kits: [],
      });

      expect(sbMock.calls.from).not.toHaveBeenCalled();
    });

    it("should filter out empty strings from ids", async () => {
      const mockRequest = new Request(
        "http://localhost:3000/api/kits?ids=kit-1,,kit-2,"
      );

      sbMock.enqueueData(mockKitRows);
      sbMock.enqueueData(mockAssetRows);

      await loader(
        createLoaderArgs({
          request: mockRequest,
          context: mockContext,
          params: {},
        })
      );

      expect(sbMock.calls.in).toHaveBeenCalledWith("id", ["kit-1", "kit-2"]);
    });

    it("should handle single kit ID", async () => {
      const mockRequest = new Request(
        "http://localhost:3000/api/kits?ids=kit-1"
      );

      sbMock.enqueueData([mockKitRows[0]]);
      sbMock.enqueueData(mockAssetRows.filter((a) => a.kitId === "kit-1"));

      const result = await loader(
        createLoaderArgs({
          request: mockRequest,
          context: mockContext,
          params: {},
        })
      );

      // Success case returns Response wrapping the payload
      expect(result instanceof Response).toBe(true);
      const responseData = await (result as unknown as Response).json();
      expect(responseData.error).toBeNull();
      expect(responseData.kits).toHaveLength(1);
      expect(responseData.kits[0]._count.assets).toBe(2);
    });

    it("should enforce organization-level security", async () => {
      const mockRequest = new Request(
        "http://localhost:3000/api/kits?ids=kit-1,kit-2"
      );

      sbMock.enqueueData(mockKitRows);
      sbMock.enqueueData(mockAssetRows);

      await loader(
        createLoaderArgs({
          request: mockRequest,
          context: mockContext,
          params: {},
        })
      );

      expect(sbMock.calls.eq).toHaveBeenCalledWith("organizationId", "org-1");
    });

    it("should handle permission errors", async () => {
      const mockRequest = new Request(
        "http://localhost:3000/api/kits?ids=kit-1"
      );

      const permissionError = new Error("Permission denied");
      (requirePermission as any).mockRejectedValue(permissionError);

      const shelfError = { status: 403, message: "Permission denied" };
      (makeShelfError as any).mockReturnValue(shelfError);

      const result = await loader(
        createLoaderArgs({
          request: mockRequest,
          context: mockContext,
          params: {},
        })
      );

      expect(makeShelfError).toHaveBeenCalledWith(permissionError, {
        userId: "user-1",
      });

      // Error case returns Response
      expect(result instanceof Response).toBe(true);
      expect((result as unknown as Response).status).toBe(403);
      const responseData = await (result as unknown as Response).json();
      expect(responseData).toEqual({
        error: expect.objectContaining({
          message: "Permission denied",
        }),
      });
    });

    it("should handle database errors", async () => {
      const mockRequest = new Request(
        "http://localhost:3000/api/kits?ids=kit-1"
      );

      // Simulate sbDb error
      sbMock.setError({ message: "Database connection failed", code: "500" });

      const shelfError = { status: 500, message: "Database error" };
      (makeShelfError as any).mockReturnValue(shelfError);

      const result = await loader(
        createLoaderArgs({
          request: mockRequest,
          context: mockContext,
          params: {},
        })
      );

      // Error case returns Response
      expect(result instanceof Response).toBe(true);
      expect((result as unknown as Response).status).toBe(500);
      const responseData = await (result as unknown as Response).json();
      expect(responseData).toEqual({
        error: expect.objectContaining({
          message: "Database error",
        }),
      });
    });

    it("should return kits ordered by name", async () => {
      const mockRequest = new Request(
        "http://localhost:3000/api/kits?ids=kit-1,kit-2"
      );

      sbMock.enqueueData(mockKitRows);
      sbMock.enqueueData(mockAssetRows);

      await loader(
        createLoaderArgs({
          request: mockRequest,
          context: mockContext,
          params: {},
        })
      );

      expect(sbMock.calls.order).toHaveBeenCalledWith("name", {
        ascending: true,
      });
    });

    it("should only select required fields", async () => {
      const mockRequest = new Request(
        "http://localhost:3000/api/kits?ids=kit-1"
      );

      sbMock.enqueueData([mockKitRows[0]]);
      sbMock.enqueueData(mockAssetRows.filter((a) => a.kitId === "kit-1"));

      await loader(
        createLoaderArgs({
          request: mockRequest,
          context: mockContext,
          params: {},
        })
      );

      // Verify kit select fields
      expect(sbMock.calls.select).toHaveBeenCalledWith(
        "id, name, image, imageExpiration"
      );
    });
  });
});
