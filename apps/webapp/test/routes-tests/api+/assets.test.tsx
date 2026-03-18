import { makeShelfError } from "~/utils/error";
import { requirePermission } from "~/utils/roles.server";
import { loader } from "~/routes/api+/assets";
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

const mockAssets = [
  {
    id: "asset-1",
    title: "Laptop Dell",
    mainImage: "https://example.com/laptop.jpg",
  },
  {
    id: "asset-2",
    title: "Mouse Logitech",
    mainImage: "https://example.com/mouse.jpg",
  },
];

describe("/api/assets", () => {
  beforeEach(() => {
    vitest.clearAllMocks();
    sbMock.reset();
    (requirePermission as any).mockResolvedValue({
      organizationId: "org-1",
    });
  });

  describe("loader", () => {
    it("should return assets for valid IDs", async () => {
      const mockRequest = new Request(
        "http://localhost:3000/api/assets?ids=asset-1,asset-2"
      );

      sbMock.setData(mockAssets);

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
        entity: "asset",
        action: "read",
      });

      // Verify sbDb was called with correct table
      expect(sbMock.calls.from).toHaveBeenCalledWith("Asset");
      expect(sbMock.calls.select).toHaveBeenCalled();
      expect(sbMock.calls.in).toHaveBeenCalledWith("id", [
        "asset-1",
        "asset-2",
      ]);
      expect(sbMock.calls.eq).toHaveBeenCalledWith("organizationId", "org-1");

      // Success case returns Response wrapping the payload
      expect(result instanceof Response).toBe(true);
      const responseData = await (result as unknown as Response).json();
      expect(responseData).toEqual({
        error: null,
        assets: mockAssets,
      });
    });

    it("should return empty array when no ids parameter provided", async () => {
      const mockRequest = new Request("http://localhost:3000/api/assets");

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
        assets: [],
      });

      expect(sbMock.calls.from).not.toHaveBeenCalled();
    });

    it("should return empty array when ids parameter is empty", async () => {
      const mockRequest = new Request("http://localhost:3000/api/assets?ids=");

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
        assets: [],
      });

      expect(sbMock.calls.from).not.toHaveBeenCalled();
    });

    it("should filter out empty strings from ids", async () => {
      const mockRequest = new Request(
        "http://localhost:3000/api/assets?ids=asset-1,,asset-2,"
      );

      sbMock.setData(mockAssets);

      await loader(
        createLoaderArgs({
          request: mockRequest,
          context: mockContext,
          params: {},
        })
      );

      expect(sbMock.calls.in).toHaveBeenCalledWith("id", [
        "asset-1",
        "asset-2",
      ]);
    });

    it("should handle single asset ID", async () => {
      const mockRequest = new Request(
        "http://localhost:3000/api/assets?ids=asset-1"
      );

      const singleAsset = [mockAssets[0]];
      sbMock.setData(singleAsset);

      const result = await loader(
        createLoaderArgs({
          request: mockRequest,
          context: mockContext,
          params: {},
        })
      );

      expect(sbMock.calls.in).toHaveBeenCalledWith("id", ["asset-1"]);

      // Success case returns Response wrapping the payload
      expect(result instanceof Response).toBe(true);
      const responseData = await (result as unknown as Response).json();
      expect(responseData).toEqual({
        error: null,
        assets: singleAsset,
      });
    });

    it("should enforce organization-level security", async () => {
      const mockRequest = new Request(
        "http://localhost:3000/api/assets?ids=asset-1,asset-2"
      );

      sbMock.setData(mockAssets);

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
        "http://localhost:3000/api/assets?ids=asset-1"
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
        "http://localhost:3000/api/assets?ids=asset-1"
      );

      // Simulate sbDb error by setting an error response
      const dbError = { message: "Database connection failed", code: "500" };
      sbMock.setError(dbError);

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

    it("should return assets ordered by title", async () => {
      const mockRequest = new Request(
        "http://localhost:3000/api/assets?ids=asset-1,asset-2"
      );

      sbMock.setData(mockAssets);

      await loader(
        createLoaderArgs({
          request: mockRequest,
          context: mockContext,
          params: {},
        })
      );

      expect(sbMock.calls.order).toHaveBeenCalledWith("title", {
        ascending: true,
      });
    });

    it("should only select required fields", async () => {
      const mockRequest = new Request(
        "http://localhost:3000/api/assets?ids=asset-1"
      );

      sbMock.setData([mockAssets[0]]);

      await loader(
        createLoaderArgs({
          request: mockRequest,
          context: mockContext,
          params: {},
        })
      );

      expect(sbMock.calls.select).toHaveBeenCalledWith("id, title, mainImage");
    });
  });
});
