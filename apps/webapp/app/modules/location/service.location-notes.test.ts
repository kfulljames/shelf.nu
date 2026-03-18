import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSupabaseMock } from "@mocks/supabase";

const locationNoteMocks = vi.hoisted(() => ({
  createSystemLocationNote: vi.fn(),
  createLocationNote: vi.fn(),
}));

const geolocateMock = vi.hoisted(() => vi.fn());
const createNoteMock = vi.hoisted(() => vi.fn());
const getUserByIDMock = vi.hoisted(() => vi.fn());

const sbMock = createSupabaseMock();
// why: testing service logic without actual Supabase HTTP calls
vi.mock("~/database/supabase.server", () => ({
  get sbDb() {
    return sbMock.client;
  },
}));

vi.mock("~/utils/geolocate.server", () => ({
  geolocate: geolocateMock,
}));

vi.mock("~/modules/location-note/service.server", () => ({
  createSystemLocationNote: locationNoteMocks.createSystemLocationNote,
  createLocationNote: locationNoteMocks.createLocationNote,
}));

vi.mock("~/modules/note/service.server", () => ({
  createNote: createNoteMock,
}));

vi.mock("~/modules/user/service.server", () => ({
  getUserByID: getUserByIDMock,
}));

vi.mock("~/modules/asset/utils.server", () => ({
  getAssetsWhereInput: vi.fn(() => ({})),
  getLocationUpdateNoteContent: vi.fn(() => "asset note"),
  getKitLocationUpdateNoteContent: vi.fn(() => "kit asset note"),
}));

vi.mock("~/modules/kit/utils.server", () => ({
  getKitsWhereInput: vi.fn(() => ({})),
}));

vi.mock("~/utils/http.server", () => ({
  getCurrentSearchParams: () => new URLSearchParams(),
}));

vi.mock("~/utils/list", async () => {
  const actual = await vi.importActual("~/utils/list");
  return { ...actual, ALL_SELECTED_KEY: "__ALL__" };
});

vi.mock("~/utils/error", () => ({
  ShelfError: class ShelfError extends Error {
    constructor(config: any) {
      super(config.message || "ShelfError");
      Object.assign(this, config);
    }
  },
  isLikeShelfError: () => false,
  isNotFoundError: () => false,
  maybeUniqueConstraintViolation: (
    _cause: unknown,
    _label: string,
    _meta?: any
  ) => {
    throw _cause;
  },
}));

const {
  updateLocation,
  updateLocationAssets,
  updateLocationKits,
  createLocationChangeNote,
} = await import("./service.server");

describe("location service activity logging", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sbMock.reset();

    geolocateMock.mockResolvedValue(null);
    locationNoteMocks.createSystemLocationNote.mockResolvedValue(undefined);
    locationNoteMocks.createLocationNote.mockResolvedValue(undefined);
    createNoteMock.mockResolvedValue(undefined);
    getUserByIDMock.mockResolvedValue({ firstName: "Jane", lastName: "Doe" });
  });

  describe("updateLocation", () => {
    it("records a system note when key fields change", async () => {
      // First call: fetch current location (single)
      sbMock.enqueue({
        data: {
          name: "Old Name",
          description: "Old description",
          address: "Old St",
          latitude: null,
          longitude: null,
          parentId: null,
        },
        error: null,
      });

      // Second call: update location (single)
      sbMock.enqueue({
        data: {
          id: "loc-1",
          name: "New Name",
          description: "New description",
          address: "New Ave",
        },
        error: null,
      });

      await updateLocation({
        id: "loc-1",
        name: "New Name",
        description: "New description",
        address: "New Ave",
        userId: "user-1",
        organizationId: "org-1",
      });

      expect(locationNoteMocks.createSystemLocationNote).toHaveBeenCalledWith(
        expect.objectContaining({
          locationId: "loc-1",
          content: expect.stringContaining("New Name"),
        })
      );
    });
  });

  describe("createLocationChangeNote", () => {
    it("creates an asset note for the location change", async () => {
      await createLocationChangeNote({
        currentLocation: { id: "loc-1", name: "Old" },
        newLocation: { id: "loc-2", name: "New" },
        firstName: "Ada",
        lastName: "Lovelace",
        assetId: "asset-1",
        userId: "user-1",
        isRemoving: false,
      });

      expect(createNoteMock).toHaveBeenCalledWith(
        expect.objectContaining({
          assetId: "asset-1",
          type: "UPDATE",
        })
      );
    });
  });

  describe("updateLocationAssets", () => {
    it("records notes when assets are assigned", async () => {
      // First call: fetch location (single)
      sbMock.enqueue({
        data: { id: "loc-1", name: "Office" },
        error: null,
      });

      // Second call: fetch current assets at location (thenable)
      sbMock.enqueue({
        data: [],
        error: null,
      });

      // Third call: fetch modified assets (thenable)
      sbMock.enqueue({
        data: [
          {
            id: "asset-1",
            title: "Camera",
            locationId: "loc-3",
            userId: "user-1",
          },
        ],
        error: null,
      });

      // Fourth call: fetch locations for assets (thenable)
      sbMock.enqueue({
        data: [{ id: "loc-3", name: "Warehouse" }],
        error: null,
      });

      // Fifth call: fetch users for assets (thenable)
      sbMock.enqueue({
        data: [{ id: "user-1", firstName: "Ada", lastName: "Lovelace" }],
        error: null,
      });

      // Sixth call: update assets to set locationId (thenable)
      sbMock.enqueue({
        data: null,
        error: null,
      });

      await updateLocationAssets({
        assetIds: ["asset-1"],
        organizationId: "org-1",
        locationId: "loc-1",
        userId: "user-1",
        request: new Request("https://example.com"),
        removedAssetIds: [],
      });

      expect(locationNoteMocks.createSystemLocationNote).toHaveBeenCalledWith(
        expect.objectContaining({
          locationId: "loc-1",
          content: expect.stringContaining("Camera"),
        })
      );
    });
  });

  describe("updateLocationKits", () => {
    it("records notes when kits are assigned", async () => {
      // First call: fetch location (single)
      sbMock.enqueue({
        data: { id: "loc-1", name: "Office" },
        error: null,
      });

      // Second call: fetch current kits at location (thenable)
      sbMock.enqueue({
        data: [],
        error: null,
      });

      // Third call: fetch kits being added (thenable)
      sbMock.enqueue({
        data: [{ id: "kit-1", name: "Shoot Kit", locationId: "loc-9" }],
        error: null,
      });

      // Fourth call: fetch kit locations (thenable)
      sbMock.enqueue({
        data: [{ id: "loc-9", name: "Main" }],
        error: null,
      });

      // Fifth call: fetch assets belonging to kits (thenable)
      sbMock.enqueue({
        data: [
          {
            id: "asset-1",
            title: "Lens",
            kitId: "kit-1",
            locationId: "loc-9",
          },
        ],
        error: null,
      });

      // Sixth call: fetch asset locations (thenable)
      sbMock.enqueue({
        data: [{ id: "loc-9", name: "Main" }],
        error: null,
      });

      // Seventh call: update kits to set locationId (thenable)
      sbMock.enqueue({
        data: null,
        error: null,
      });

      // Eighth call: update assets to set locationId (thenable)
      sbMock.enqueue({
        data: null,
        error: null,
      });

      await updateLocationKits({
        locationId: "loc-1",
        kitIds: ["kit-1"],
        removedKitIds: [],
        organizationId: "org-1",
        userId: "user-1",
        request: new Request("https://example.com"),
      });

      expect(locationNoteMocks.createSystemLocationNote).toHaveBeenCalledWith(
        expect.objectContaining({
          locationId: "loc-1",
          content: expect.stringContaining("Shoot Kit"),
        })
      );
    });
  });
});
