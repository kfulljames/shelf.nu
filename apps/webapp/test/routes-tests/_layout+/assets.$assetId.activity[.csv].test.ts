import type { LoaderFunctionArgs } from "react-router";
import {
  PermissionAction,
  PermissionEntity,
} from "~/utils/permissions/permission.data";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createLoaderArgs } from "@mocks/remix";
import { locationDescendantsMock } from "@mocks/location-descendants";
import { createSupabaseMock } from "@mocks/supabase";

// why: mocking location descendants to avoid database queries during tests
vi.mock("~/modules/location/descendants.server", () => locationDescendantsMock);

const sbMock = createSupabaseMock();

// why: testing service logic without actual Supabase HTTP calls
vi.mock("~/database/supabase.server", () => ({
  get sbDb() {
    return sbMock.client;
  },
}));

import { requirePermission } from "~/utils/roles.server";

// why: verifying CSV loader behavior without executing real permission checks
vi.mock("~/utils/roles.server", () => ({
  requirePermission: vi.fn(),
}));

// why: suppress lottie animation initialization during route import
vi.mock("lottie-react", () => ({
  __esModule: true,
  default: vi.fn(() => null),
}));

let loader: (typeof import("~/routes/_layout+/assets.$assetId.activity[.csv]"))["loader"];
const requirePermissionMock = vi.mocked(requirePermission);

beforeAll(async () => {
  ({ loader } = await import(
    "~/routes/_layout+/assets.$assetId.activity[.csv]"
  ));
});

describe("app/routes/_layout+/assets.$assetId.activity[.csv] loader", () => {
  const context = {
    getSession: () => ({ userId: "user-123" }),
  } as LoaderFunctionArgs["context"];

  beforeEach(() => {
    vi.clearAllMocks();
    sbMock.reset();
    requirePermissionMock.mockResolvedValue({
      organizationId: "org-1",
    } as any);
  });

  it("returns a CSV response with formatted asset notes", async () => {
    // First sbDb call: asset lookup (from route)
    sbMock.enqueueData({ title: "Test Asset" });
    // Second sbDb call: note fetch (from exportAssetNotesToCsv in csv.server)
    sbMock.enqueueData([
      {
        content: 'Line with "quotes"\nand newline',
        type: "COMMENT",
        createdAt: "2024-01-02T10:00:00.000Z",
        user: { firstName: "Carlos", lastName: "Virreira" },
      },
      {
        content: "System note",
        type: "UPDATE",
        createdAt: "2024-01-01T09:30:00.000Z",
        user: null,
      },
    ]);

    const response = await loader(
      createLoaderArgs({
        context,
        request: new Request(
          "https://example.com/assets/asset-123/activity.csv",
          {
            headers: {
              "accept-language": "en-US",
              Cookie: "CH-time-zone=UTC",
            },
          }
        ),
        params: { assetId: "asset-123" },
      })
    );

    expect(requirePermissionMock).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        userId: "user-123",
        request: expect.any(Request),
        entity: PermissionEntity.asset,
        action: PermissionAction.read,
      })
    );
    expect(requirePermissionMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        userId: "user-123",
        request: expect.any(Request),
        entity: PermissionEntity.note,
        action: PermissionAction.read,
      })
    );

    // Loader returns Response for success
    expect(response instanceof Response).toBe(true);
    expect((response as unknown as Response).status).toBe(200);
    expect((response as unknown as Response).headers.get("content-type")).toBe(
      "text/csv"
    );
    expect(
      (response as unknown as Response).headers.get("content-disposition")
    ).toContain("Test Asset-activity");

    const csv = await (response as unknown as Response).text();
    const rows = csv.trim().split("\n");
    expect(rows[0]).toBe("Date,Author,Type,Content");
    // Verify CSV content has the expected data (date format depends on
    // getDateTimeFormat which uses request hints)
    expect(rows.length).toBe(3); // header + 2 notes
    expect(rows[1]).toContain("Carlos Virreira");
    expect(rows[1]).toContain("COMMENT");
    expect(rows[2]).toContain("UPDATE");
    expect(rows[2]).toContain("System note");
  });
});
