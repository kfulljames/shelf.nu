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

// why: verifying booking note CSV loader without triggering actual permission checks
vi.mock("~/utils/roles.server", () => ({
  requirePermission: vi.fn(),
}));

// why: suppress lottie animation initialization during route import
vi.mock("lottie-react", () => ({
  __esModule: true,
  default: vi.fn(() => null),
}));
// why: prevent eager Prisma client initialization via csv.server imports
vi.mock("~/database/db.server", () => ({
  db: {},
}));

let loader: (typeof import("~/routes/_layout+/bookings.$bookingId.activity[.csv]"))["loader"];
const requirePermissionMock = vi.mocked(requirePermission);

beforeAll(async () => {
  ({ loader } = await import(
    "~/routes/_layout+/bookings.$bookingId.activity[.csv]"
  ));
});

describe("app/routes/_layout+/bookings.$bookingId.activity[.csv] loader", () => {
  const context = {
    getSession: () => ({ userId: "user-456" }),
  } as LoaderFunctionArgs["context"];

  beforeEach(() => {
    vi.clearAllMocks();
    sbMock.reset();
    requirePermissionMock.mockResolvedValue({
      organizationId: "org-9",
    } as any);
  });

  it("returns a CSV response with formatted booking notes", async () => {
    // First sbDb call: booking lookup (from route)
    sbMock.enqueueData({ name: "Field Shoot" });
    // Second sbDb call: booking note fetch (from exportBookingNotesToCsv in csv.server)
    sbMock.enqueueData([
      {
        content: 'Packed "Lens" set\nVerify inventory',
        type: "COMMENT",
        createdAt: "2024-02-10T08:15:00.000Z",
        user: { firstName: "Alex", lastName: "Stone" },
      },
      {
        content: "System update",
        type: "UPDATE",
        createdAt: "2024-02-09T12:00:00.000Z",
        user: null,
      },
    ]);

    const response = await loader(
      createLoaderArgs({
        context,
        request: new Request(
          "https://example.com/bookings/booking-789/activity.csv",
          {
            headers: {
              "accept-language": "en-US",
              Cookie: "CH-time-zone=UTC",
            },
          }
        ),
        params: { bookingId: "booking-789" },
      })
    );

    expect(requirePermissionMock).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        userId: "user-456",
        request: expect.any(Request),
        entity: PermissionEntity.booking,
        action: PermissionAction.read,
      })
    );
    expect(requirePermissionMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        userId: "user-456",
        request: expect.any(Request),
        entity: PermissionEntity.bookingNote,
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
    ).toContain("Field Shoot-activity");

    const csv = await (response as unknown as Response).text();
    const rows = csv.trim().split("\n");
    expect(rows[0]).toBe("Date,Author,Type,Content");
    expect(rows.length).toBe(3); // header + 2 notes
    expect(rows[1]).toContain("Alex Stone");
    expect(rows[1]).toContain("COMMENT");
    expect(rows[2]).toContain("UPDATE");
    expect(rows[2]).toContain("System update");
  });
});
