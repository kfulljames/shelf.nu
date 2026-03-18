import {
  BookingStatus,
  AssetStatus,
  KitStatus,
  OrganizationRoles,
} from "@prisma/client";

import { createSupabaseMock } from "@mocks/supabase";
import { db } from "~/database/db.server";
import * as noteService from "~/modules/note/service.server";
import { ShelfError } from "~/utils/error";
import { wrapBookingStatusForNote } from "~/utils/markdoc-wrappers";
import { scheduler } from "~/utils/scheduler.server";
import { sendBookingUpdatedEmail } from "./email-helpers";
import {
  createBooking,
  partialCheckinBooking,
  hasPartialCheckins,
  getPartialCheckinHistory,
  getTotalPartialCheckinCount,
  getPartiallyCheckedInAssetIds,
  getKitIdsByAssets,
  updateBasicBooking,
  updateBookingAssets,
  reserveBooking,
  checkoutBooking,
  checkinBooking,
  archiveBooking,
  cancelBooking,
  deleteBooking,
  getBooking,
  duplicateBooking,
  revertBookingToDraft,
  extendBooking,
  removeAssets,
  getOngoingBookingForAsset,
  // Test helper functions
  getActionTextFromTransition,
  getSystemActionText,
} from "./service.server";

const sbMock = createSupabaseMock();

// @vitest-environment node
// 👋 see https://vitest.dev/guide/environment.html#environments-for-specific-files

// Setup timezone for consistent test behavior across environments
const originalTZ = process.env.TZ;

beforeAll(() => {
  // Force tests to run in UTC for consistent behavior across environments
  process.env.TZ = "UTC";
});

afterAll(() => {
  // Restore original timezone
  if (originalTZ !== undefined) {
    process.env.TZ = originalTZ;
  } else {
    delete process.env.TZ;
  }
});

// Mock dependencies
// why: testing booking service business logic without executing actual database operations
// Only reserveBooking, checkoutBooking, getBooking still use Prisma db for complex relational queries
vitest.mock("~/database/db.server", () => ({
  db: {
    booking: {
      findUniqueOrThrow: vitest.fn().mockResolvedValue({}),
      findFirstOrThrow: vitest.fn().mockResolvedValue({}),
    },
  },
}));

// why: testing service logic without actual Supabase HTTP calls
vitest.mock("~/database/supabase.server", () => ({
  get sbDb() {
    return sbMock.client;
  },
}));

// why: ensuring predictable ID generation for consistent test assertions
vitest.mock("~/utils/id/id.server", () => ({
  id: vitest.fn(() => "mock-id"),
}));

// why: avoiding QR code generation during booking service tests
vitest.mock("~/modules/qr/service.server", () => ({
  getQr: vitest.fn(),
}));

// why: testing booking workflows without creating actual asset notes
vitest.mock("~/modules/note/service.server", () => ({
  createNotes: vitest.fn(),
}));

// why: avoiding actual booking note creation during service tests
vitest.mock("~/modules/booking-note/service.server", () => ({
  createSystemBookingNote: vitest.fn().mockResolvedValue({}),
}));

// why: preventing database lookups for user data during booking tests
vitest.mock("~/modules/user/service.server", () => ({
  getUserByID: vitest.fn().mockResolvedValue({
    id: "user-1",
    email: "test@example.com",
    firstName: "Test",
    lastName: "User",
  }),
}));

// why: preventing actual email sending during tests
vitest.mock("~/emails/mail.server", () => ({
  sendEmail: vitest.fn(),
}));

// why: spying on booking update email calls without executing
// actual DB lookups or email sends
vitest.mock("./email-helpers", async () => {
  const actual = await vitest.importActual("./email-helpers");
  return {
    ...actual,
    sendBookingUpdatedEmail: vitest.fn().mockResolvedValue(undefined),
  };
});

// why: avoiding organization admin lookups during booking notification tests
vitest.mock("~/modules/organization/service.server", () => ({
  getOrganizationAdminsEmails: vitest
    .fn()
    .mockResolvedValue(["admin@example.com"]),
}));

// why: preventing actual job scheduling and queue operations during tests
vitest.mock("~/utils/scheduler.server", () => ({
  scheduler: {
    cancel: vitest.fn(),
    schedule: vitest.fn(),
    sendAfter: vitest.fn(),
  },
  QueueNames: {
    BOOKING_UPDATES: "booking-updates",
    bookingQueue: "booking-queue",
  },
}));

const HOURS_BETWEEN_FROM_AND_TO = 8;
const futureFromDate = new Date();
futureFromDate.setDate(futureFromDate.getDate() + 30);
const futureToDate = new Date(
  futureFromDate.getTime() + HOURS_BETWEEN_FROM_AND_TO * 60 * 60 * 1000
);
const futureCreatedAt = new Date(futureFromDate.getTime() - 60 * 60 * 1000);

const mockBookingData = {
  id: "booking-1",
  name: "Test Booking",
  description: "Test Description",
  status: BookingStatus.DRAFT,
  creatorId: "user-1",
  organizationId: "org-1",
  custodianUserId: "user-1",
  custodianTeamMemberId: null,
  from: futureFromDate,
  to: futureToDate,
  createdAt: futureCreatedAt,
  updatedAt: futureCreatedAt,
  assets: [
    { id: "asset-1", kitId: null },
    { id: "asset-2", kitId: null },
    { id: "asset-3", kitId: "kit-1" },
  ],
  tags: [{ id: "tag-1", name: "Tag 1", color: "#123456" }],
};

const mockClientHints = {
  timeZone: "America/New_York",
  locale: "en-US",
};

const mockCreateBookingParams = {
  booking: {
    name: "Test Booking",
    description: "Test Description",
    custodianUserId: "user-1",
    custodianTeamMemberId: "team-member-1",
    organizationId: "org-1",
    creatorId: "user-1",
    from: futureFromDate,
    to: futureToDate,
    tags: [],
  },
  assetIds: ["asset-1", "asset-2"],
  hints: mockClientHints,
};

describe("createBooking", () => {
  beforeEach(() => {
    vitest.clearAllMocks();
    sbMock.reset();
  });

  /** Helper to enqueue sbMock responses for createBooking's sbDb calls */
  function setupCreateBookingSbMock(
    createdRow: Record<string, unknown>,
    opts?: {
      custodianTeamMember?: Record<string, unknown> | null;
      custodianUser?: Record<string, unknown> | null;
      organization?: Record<string, unknown> | null;
      tagJoinRows?: Array<{ B: string }>;
      tags?: Array<Record<string, unknown>>;
    }
  ) {
    // 1. sbDb.from("Booking").insert(...).select().single()
    sbMock.enqueueData(createdRow);
    // 2. sbDb.from("_AssetToBooking").insert([...]) - asset join
    sbMock.enqueueData([]);
    // 3-6. Promise.all: TeamMember, User, Organization, _BookingToTag
    sbMock.enqueueData(opts?.custodianTeamMember ?? null);
    sbMock.enqueueData(opts?.custodianUser ?? null);
    sbMock.enqueueData(opts?.organization ?? { id: "org-1", name: "Test Org" });
    sbMock.enqueueData(opts?.tagJoinRows ?? []);
  }

  const mockCreatedRow = {
    id: "booking-1",
    name: "Test Booking",
    description: "Test Description",
    status: BookingStatus.DRAFT,
    creatorId: "user-1",
    organizationId: "org-1",
    custodianUserId: "user-1",
    custodianTeamMemberId: "team-member-1",
    from: futureFromDate.toISOString(),
    to: futureToDate.toISOString(),
    createdAt: futureCreatedAt.toISOString(),
    updatedAt: futureCreatedAt.toISOString(),
    originalFrom: futureFromDate.toISOString(),
    originalTo: futureToDate.toISOString(),
    autoArchivedAt: null,
    activeSchedulerReference: null,
    cancellationReason: null,
  };

  it("should create a booking successfully", async () => {
    setupCreateBookingSbMock(mockCreatedRow);

    const result = await createBooking(mockCreateBookingParams);

    expect(sbMock.calls.from).toHaveBeenCalledWith("Booking");
    expect(result.id).toBe("booking-1");
    expect(result.name).toBe("Test Booking");
    expect(result.status).toBe(BookingStatus.DRAFT);
  });

  it("should create a booking without custodian when custodianUserId is null", async () => {
    const paramsWithoutCustodian = {
      ...mockCreateBookingParams,
      booking: {
        ...mockCreateBookingParams.booking,
        custodianUserId: null,
        custodianTeamMemberId: "team-member-1",
        tags: [],
      },
    };
    const rowWithoutCustodian = { ...mockCreatedRow, custodianUserId: null };
    // 1. insert booking
    sbMock.enqueueData(rowWithoutCustodian);
    // 2. asset join
    sbMock.enqueueData([]);
    // 3-6. Promise.all: TeamMember (yes), User (no - skipped since custodianUserId null),
    //       Organization, _BookingToTag
    sbMock.enqueueData({ id: "team-member-1", name: "TM1" });
    sbMock.enqueueData({ id: "org-1", name: "Test Org" });
    sbMock.enqueueData([]);

    const result = await createBooking(paramsWithoutCustodian);

    expect(result.custodianUserId).toBeNull();
  });

  it("should throw ShelfError when creation fails", async () => {
    // Enqueue an error for the insert call
    sbMock.enqueueError({ message: "Database error", code: "500" });

    await expect(createBooking(mockCreateBookingParams)).rejects.toThrow(
      ShelfError
    );
  });
});

describe("partialCheckinBooking", () => {
  beforeEach(() => {
    vitest.clearAllMocks();
    sbMock.reset();
  });

  const mockPartialCheckinParams = {
    id: "booking-1",
    organizationId: "org-1",
    assetIds: ["asset-1", "asset-2"],
    userId: "user-1",
    hints: mockClientHints,
  };

  const mockBookingRow = {
    id: "booking-1",
    name: "Test Booking",
    status: BookingStatus.ONGOING,
    organizationId: "org-1",
    custodianUserId: "user-1",
    custodianTeamMemberId: null,
    creatorId: "user-1",
    from: futureFromDate.toISOString(),
    to: futureToDate.toISOString(),
    createdAt: futureCreatedAt.toISOString(),
    updatedAt: futureCreatedAt.toISOString(),
    originalFrom: futureFromDate.toISOString(),
    originalTo: futureToDate.toISOString(),
    autoArchivedAt: null,
    description: "Test Description",
    activeSchedulerReference: null,
    cancellationReason: null,
  };

  /** Sets up sbMock queue for partialCheckinBooking with 3 assets (partial check-in path) */
  function setupPartialCheckinSbMock(opts?: {
    bookingRow?: Record<string, unknown>;
    assetJoins?: Array<{ A: string }>;
    assetDetails?: Array<Record<string, unknown>>;
    assetStatuses?: Array<Record<string, unknown>>;
  }) {
    const assetJoins = opts?.assetJoins ?? [
      { A: "asset-1" },
      { A: "asset-2" },
      { A: "asset-3" },
    ];
    const assetDetails = opts?.assetDetails ?? [
      { id: "asset-1", kitId: null },
      { id: "asset-2", kitId: null },
      { id: "asset-3", kitId: null },
    ];
    const assetStatuses = opts?.assetStatuses ?? [
      { id: "asset-1", status: AssetStatus.CHECKED_OUT },
      { id: "asset-2", status: AssetStatus.CHECKED_OUT },
      { id: "asset-3", status: AssetStatus.CHECKED_OUT },
    ];
    // 1. Booking fetch
    sbMock.enqueueData(opts?.bookingRow ?? mockBookingRow);
    // 2. _AssetToBooking join rows
    sbMock.enqueueData(assetJoins);
    // 3. Asset details (kitId)
    sbMock.enqueueData(assetDetails);
    // 4. Asset statuses
    sbMock.enqueueData(assetStatuses);
    // 5. Asset status update (AVAILABLE)
    sbMock.enqueueData([]);
    // 6. PartialBookingCheckin insert
    sbMock.enqueueData({});
  }

  it("should perform partial check-in successfully", async () => {
    setupPartialCheckinSbMock();

    const result = await partialCheckinBooking(mockPartialCheckinParams);

    // Verify notes created
    expect(noteService.createNotes).toHaveBeenCalledWith({
      content:
        '{% link to="/settings/team/users/user-1" text="Test User" /%} checked in via partial check-in.',
      type: "UPDATE",
      userId: "user-1",
      assetIds: ["asset-1", "asset-2"],
    });

    expect(result).toEqual(
      expect.objectContaining({
        checkedInAssetCount: 2,
        remainingAssetCount: 1,
        isComplete: false,
      })
    );
  });

  it("should throw error when asset is not in booking", async () => {
    // Booking only has asset-3, but we're trying to check in asset-1, asset-2
    sbMock.enqueueData(mockBookingRow);
    sbMock.enqueueData([{ A: "asset-3" }]);
    sbMock.enqueueData([{ id: "asset-3", kitId: null }]);
    sbMock.enqueueData([{ id: "asset-3", status: AssetStatus.CHECKED_OUT }]);

    await expect(
      partialCheckinBooking(mockPartialCheckinParams)
    ).rejects.toThrow(ShelfError);
  });

  it("should handle kit check-in when all kit assets are scanned", async () => {
    setupPartialCheckinSbMock({
      assetJoins: [{ A: "asset-1" }, { A: "asset-2" }, { A: "asset-3" }],
      assetDetails: [
        { id: "asset-1", kitId: "kit-1" },
        { id: "asset-2", kitId: "kit-1" },
        { id: "asset-3", kitId: null },
      ],
      assetStatuses: [
        { id: "asset-1", status: AssetStatus.CHECKED_OUT },
        { id: "asset-2", status: AssetStatus.CHECKED_OUT },
        { id: "asset-3", status: AssetStatus.CHECKED_OUT },
      ],
    });
    // Extra responses for kit update
    sbMock.enqueueData([]);

    const result = await partialCheckinBooking({
      ...mockPartialCheckinParams,
      assetIds: ["asset-1", "asset-2"],
    });

    // Verify sbDb was called to update Kit table
    expect(sbMock.calls.from).toHaveBeenCalledWith("Kit");
    expect(result).toEqual(
      expect.objectContaining({
        checkedInAssetCount: 2,
        isComplete: false,
      })
    );
  });
});

describe("hasPartialCheckins", () => {
  beforeEach(() => {
    vitest.clearAllMocks();
    sbMock.reset();
  });

  it("should return true when booking has partial check-ins", async () => {
    // sbDb.from("PartialBookingCheckin").select("id", { count: "exact", head: true }).eq(...)
    // The mock resolves with count property; we simulate count > 0
    sbMock.enqueue({ data: null, error: null, count: 3 });

    const result = await hasPartialCheckins("booking-1");

    expect(sbMock.calls.from).toHaveBeenCalledWith("PartialBookingCheckin");
    expect(result).toBe(true);
  });

  it("should return false when booking has no partial check-ins", async () => {
    sbMock.enqueue({ data: null, error: null, count: 0 });

    const result = await hasPartialCheckins("booking-1");

    expect(result).toBe(false);
  });
});

describe("getPartialCheckinHistory", () => {
  beforeEach(() => {
    vitest.clearAllMocks();
    sbMock.reset();
  });

  it("should return partial check-in history", async () => {
    const now = new Date();
    const mockCheckins = [
      {
        id: "partial-1",
        bookingId: "booking-1",
        assetIds: ["asset-1", "asset-2"],
        checkinCount: 2,
        checkinTimestamp: now.toISOString(),
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
        checkedInById: "user-john",
      },
    ];
    // 1. PartialBookingCheckin select
    sbMock.enqueueData(mockCheckins);
    // 2. User select for checkedInById lookup
    sbMock.enqueueData([
      {
        id: "user-john",
        firstName: "John",
        lastName: "Doe",
        email: "john@example.com",
      },
    ]);

    const result = await getPartialCheckinHistory("booking-1");

    expect(sbMock.calls.from).toHaveBeenCalledWith("PartialBookingCheckin");
    expect(result).toHaveLength(1);
    expect(result[0].checkedInBy).toEqual({
      firstName: "John",
      lastName: "Doe",
      email: "john@example.com",
    });
  });
});

describe("getTotalPartialCheckinCount", () => {
  beforeEach(() => {
    vitest.clearAllMocks();
    sbMock.reset();
  });

  it("should return total count of checked-in assets", async () => {
    // sbDb.from("PartialBookingCheckin").select("checkinCount").eq(...)
    sbMock.enqueueData([{ checkinCount: 10 }, { checkinCount: 5 }]);

    const result = await getTotalPartialCheckinCount("booking-1");

    expect(result).toBe(15);
  });

  it("should return 0 when no partial check-ins exist", async () => {
    sbMock.enqueueData([]);

    const result = await getTotalPartialCheckinCount("booking-1");

    expect(result).toBe(0);
  });
});

describe("getPartiallyCheckedInAssetIds", () => {
  beforeEach(() => {
    vitest.clearAllMocks();
    sbMock.reset();
  });

  it("should return unique asset IDs from partial check-ins", async () => {
    sbMock.enqueueData([
      { assetIds: ["asset-1", "asset-2"] },
      { assetIds: ["asset-2", "asset-3"] },
      { assetIds: ["asset-4"] },
    ]);

    const result = await getPartiallyCheckedInAssetIds("booking-1");

    expect(sbMock.calls.from).toHaveBeenCalledWith("PartialBookingCheckin");
    expect(result).toEqual(["asset-1", "asset-2", "asset-3", "asset-4"]);
  });

  it("should return empty array when no partial check-ins exist", async () => {
    sbMock.enqueueData([]);

    const result = await getPartiallyCheckedInAssetIds("booking-1");

    expect(result).toEqual([]);
  });
});

describe("getKitIdsByAssets", () => {
  it("should return unique kit IDs from assets", () => {
    const assets = [
      { id: "asset-1", kitId: "kit-1" },
      { id: "asset-2", kitId: "kit-1" },
      { id: "asset-3", kitId: "kit-2" },
      { id: "asset-4", kitId: null },
    ];

    const result = getKitIdsByAssets(assets);

    expect(result).toEqual(["kit-1", "kit-2"]);
  });

  it("should return empty array when no kits present", () => {
    const assets = [
      { id: "asset-1", kitId: null },
      { id: "asset-2", kitId: null },
    ];

    const result = getKitIdsByAssets(assets);

    expect(result).toEqual([]);
  });
});

describe("updateBasicBooking", () => {
  beforeEach(() => {
    vitest.clearAllMocks();
    sbMock.reset();
  });

  const mockUpdateBookingParams = {
    id: "booking-1",
    organizationId: "org-1",
    name: "Updated Booking Name",
    description: "Updated Description",
    from: new Date("2024-02-01T09:00:00Z"),
    to: new Date("2024-02-01T17:00:00Z"),
    custodianUserId: "user-2",
    custodianTeamMemberId: "team-member-2",
    tags: [{ id: "tag-1" }, { id: "tag-2" }],
  };

  /**
   * Helper to enqueue sbMock responses for updateBasicBooking's sbDb calls.
   * The function makes these calls:
   * 1. Booking fetch (single)
   * 2. TeamMember fetch (single) - if custodianTeamMemberId exists
   * 3. User fetch (single) - if team member has userId
   * 4. CustodianUser fetch (single) - if custodianUserId exists
   * 5. _BookingToTag select
   * 6. Tag select (if tags exist)
   * 7. Booking update (single)
   * 8. _BookingToTag delete
   * 9. _BookingToTag insert (if tags)
   */
  function setupUpdateBookingSbMock(overrides?: {
    bookingRow?: Record<string, unknown>;
    teamMember?: Record<string, unknown> | null;
    teamMemberUser?: Record<string, unknown> | null;
    custodianUser?: Record<string, unknown> | null;
    tagJoinRows?: Array<{ B: string }>;
    tags?: Array<Record<string, unknown>>;
    updatedRow?: Record<string, unknown>;
  }) {
    const bookingRow = overrides?.bookingRow ?? {
      id: "booking-1",
      status: BookingStatus.DRAFT,
      custodianUserId: "user-1",
      custodianTeamMemberId: null,
      name: "Old Name",
      description: "Old Description",
      from: futureFromDate.toISOString(),
      to: futureToDate.toISOString(),
    };
    // 1. Booking fetch
    sbMock.enqueueData(bookingRow);
    // 2. TeamMember fetch (if custodianTeamMemberId)
    if (bookingRow.custodianTeamMemberId) {
      sbMock.enqueueData(
        overrides?.teamMember ?? {
          id: bookingRow.custodianTeamMemberId,
          name: "TM",
          userId: null,
        }
      );
      // 3. User for team member (if userId)
      if (overrides?.teamMemberUser) {
        sbMock.enqueueData(overrides.teamMemberUser);
      }
    }
    // 4. CustodianUser fetch (if custodianUserId)
    if (bookingRow.custodianUserId) {
      sbMock.enqueueData(
        overrides?.custodianUser ?? {
          id: bookingRow.custodianUserId,
          email: "custodian@example.com",
          firstName: "Custodian",
          lastName: "User",
        }
      );
    }
    // 5. _BookingToTag select
    sbMock.enqueueData(overrides?.tagJoinRows ?? []);
    // 6. Tags (skipped if no join rows)
    if (overrides?.tags) {
      sbMock.enqueueData(overrides.tags);
    }
    // 7. Booking update
    sbMock.enqueueData(
      overrides?.updatedRow ?? { ...bookingRow, name: "Updated Booking Name" }
    );
    // 8. _BookingToTag delete
    sbMock.enqueueData([]);
    // 9. _BookingToTag insert
    sbMock.enqueueData([]);
  }

  it("should update booking successfully when status is DRAFT", async () => {
    setupUpdateBookingSbMock();

    const result = await updateBasicBooking(mockUpdateBookingParams);

    expect(sbMock.calls.from).toHaveBeenCalledWith("Booking");
    expect(result).toBeDefined();
    expect(result.name).toBe("Updated Booking Name");
  });

  it("should throw ShelfError when booking status is COMPLETE", async () => {
    sbMock.enqueueData({
      id: "booking-1",
      status: BookingStatus.COMPLETE,
      custodianUserId: "user-1",
      custodianTeamMemberId: null,
      name: "Test",
      description: null,
      from: futureFromDate.toISOString(),
      to: futureToDate.toISOString(),
    });
    // CustodianUser fetch
    sbMock.enqueueData({
      id: "user-1",
      email: "test@test.com",
      firstName: "Test",
      lastName: "User",
    });
    // Tags
    sbMock.enqueueData([]);

    await expect(updateBasicBooking(mockUpdateBookingParams)).rejects.toThrow(
      ShelfError
    );
  });

  it("should throw ShelfError when booking status is ARCHIVED", async () => {
    sbMock.enqueueData({
      id: "booking-1",
      status: BookingStatus.ARCHIVED,
      custodianUserId: null,
      custodianTeamMemberId: null,
      name: "Test",
      description: null,
      from: futureFromDate.toISOString(),
      to: futureToDate.toISOString(),
    });
    sbMock.enqueueData([]);

    await expect(updateBasicBooking(mockUpdateBookingParams)).rejects.toThrow(
      ShelfError
    );
  });

  it("should throw ShelfError when booking status is CANCELLED", async () => {
    sbMock.enqueueData({
      id: "booking-1",
      status: BookingStatus.CANCELLED,
      custodianUserId: null,
      custodianTeamMemberId: null,
      name: "Test",
      description: null,
      from: futureFromDate.toISOString(),
      to: futureToDate.toISOString(),
    });
    sbMock.enqueueData([]);

    await expect(updateBasicBooking(mockUpdateBookingParams)).rejects.toThrow(
      ShelfError
    );
  });

  it("should throw ShelfError when booking is not found", async () => {
    sbMock.enqueueError({ message: "Booking not found", code: "PGRST116" });

    await expect(updateBasicBooking(mockUpdateBookingParams)).rejects.toThrow(
      ShelfError
    );
  });

  it("should send email when changes are detected and hints are provided", async () => {
    setupUpdateBookingSbMock({
      bookingRow: {
        id: "booking-1",
        status: BookingStatus.DRAFT,
        custodianUserId: "custodian-1",
        custodianTeamMemberId: null,
        name: "Old Name",
        description: "Old Description",
        from: futureFromDate.toISOString(),
        to: futureToDate.toISOString(),
      },
      custodianUser: {
        id: "custodian-1",
        email: "custodian@example.com",
        firstName: "Custodian",
        lastName: "User",
      },
    });

    await updateBasicBooking({
      ...mockUpdateBookingParams,
      name: "New Name",
      userId: "editor-1",
      hints: mockClientHints,
    });

    expect(sendBookingUpdatedEmail).toHaveBeenCalledTimes(1);
    expect(sendBookingUpdatedEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        bookingId: "booking-1",
        organizationId: "org-1",
        userId: "editor-1",
        changes: expect.arrayContaining([
          expect.stringContaining("Booking name changed"),
        ]),
      })
    );
  });

  it("should not send email when no hints are provided", async () => {
    setupUpdateBookingSbMock({
      bookingRow: {
        id: "booking-1",
        status: BookingStatus.DRAFT,
        custodianUserId: "custodian-1",
        custodianTeamMemberId: null,
        name: "Old Name",
        description: null,
        from: futureFromDate.toISOString(),
        to: futureToDate.toISOString(),
      },
      custodianUser: {
        id: "custodian-1",
        email: "custodian@example.com",
        firstName: "Custodian",
        lastName: "User",
      },
    });

    await updateBasicBooking({
      ...mockUpdateBookingParams,
      name: "New Name",
      userId: "editor-1",
      // no hints
    });

    expect(sendBookingUpdatedEmail).not.toHaveBeenCalled();
  });

  it("should not send email when no changes are detected", async () => {
    setupUpdateBookingSbMock({
      bookingRow: {
        id: "booking-1",
        status: BookingStatus.DRAFT,
        custodianUserId: "user-2",
        custodianTeamMemberId: "team-member-2",
        name: "Updated Booking Name",
        description: "Updated Description",
        from: new Date("2024-02-01T09:00:00Z").toISOString(),
        to: new Date("2024-02-01T17:00:00Z").toISOString(),
      },
      teamMember: { id: "team-member-2", name: "TM", userId: "user-2" },
      teamMemberUser: {
        id: "user-2",
        firstName: "Custodian",
        lastName: "User",
      },
      custodianUser: {
        id: "user-2",
        email: "custodian@example.com",
        firstName: "Custodian",
        lastName: "User",
      },
      tagJoinRows: [{ B: "tag-1" }, { B: "tag-2" }],
      tags: [
        { id: "tag-1", name: "Tag 1" },
        { id: "tag-2", name: "Tag 2" },
      ],
    });

    await updateBasicBooking({
      ...mockUpdateBookingParams,
      userId: "editor-1",
      hints: mockClientHints,
    });

    expect(sendBookingUpdatedEmail).not.toHaveBeenCalled();
  });

  it("should pass old custodian email when custodian changes", async () => {
    setupUpdateBookingSbMock({
      bookingRow: {
        id: "booking-1",
        status: BookingStatus.DRAFT,
        custodianUserId: "old-custodian-1",
        custodianTeamMemberId: "old-team-member-1",
        name: "Updated Booking Name",
        description: "Updated Description",
        from: new Date("2024-02-01T09:00:00Z").toISOString(),
        to: new Date("2024-02-01T17:00:00Z").toISOString(),
      },
      teamMember: {
        id: "old-team-member-1",
        name: "Old TM",
        userId: "old-custodian-1",
      },
      teamMemberUser: {
        id: "old-custodian-1",
        firstName: "Old",
        lastName: "Custodian",
      },
      custodianUser: {
        id: "old-custodian-1",
        email: "old-custodian@example.com",
        firstName: "Old",
        lastName: "Custodian",
      },
      tagJoinRows: [{ B: "tag-1" }, { B: "tag-2" }],
      tags: [
        { id: "tag-1", name: "Tag 1" },
        { id: "tag-2", name: "Tag 2" },
      ],
    });
    // Extra: new team member lookup during custodian change detection
    sbMock.enqueueData({
      id: "team-member-2",
      name: "New TM",
      userId: "user-2",
    });
    sbMock.enqueueData({
      id: "user-2",
      firstName: "New",
      lastName: "Custodian",
    });

    await updateBasicBooking({
      ...mockUpdateBookingParams,
      userId: "editor-1",
      hints: mockClientHints,
    });

    expect(sendBookingUpdatedEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        oldCustodianEmail: "old-custodian@example.com",
      })
    );
  });
});

describe("updateBookingAssets", () => {
  beforeEach(() => {
    vitest.clearAllMocks();
    sbMock.reset();
  });

  const mockUpdateBookingAssetsParams = {
    id: "booking-1",
    organizationId: "org-1",
    assetIds: ["asset-1", "asset-2"],
  };

  it("should update booking assets successfully for DRAFT booking", async () => {
    expect.assertions(2);

    // 1. sbDb.rpc("shelf_booking_update_assets") -> success
    sbMock.enqueueData({ success: true });
    // 2. sbDb.from("Booking").select("id, name, status").eq().eq().single()
    sbMock.enqueueData({ id: "booking-1", name: "Test Booking", status: BookingStatus.DRAFT });
    // 3. sbDb.from("Asset").select("id, title").in().eq() - for booking note
    sbMock.enqueueData([
      { id: "asset-1", title: "Asset 1" },
      { id: "asset-2", title: "Asset 2" },
    ]);

    const result = await updateBookingAssets(mockUpdateBookingAssetsParams);

    expect(sbMock.calls.rpc).toHaveBeenCalledWith(
      "shelf_booking_update_assets",
      expect.objectContaining({
        p_asset_ids: ["asset-1", "asset-2"],
        p_booking_id: "booking-1",
        p_org_id: "org-1",
      })
    );
    expect(result).toEqual(
      expect.objectContaining({ id: "booking-1", name: "Test Booking" })
    );
  });

  it("should update asset status to CHECKED_OUT for ONGOING booking", async () => {
    expect.assertions(2);

    // 1. sbDb.rpc
    sbMock.enqueueData({ success: true });
    // 2. Booking fetch
    sbMock.enqueueData({ id: "booking-1", name: "Test Booking", status: BookingStatus.ONGOING });
    // 3. Asset fetch for notes
    sbMock.enqueueData([
      { id: "asset-1", title: "Asset 1" },
      { id: "asset-2", title: "Asset 2" },
    ]);

    const result = await updateBookingAssets(mockUpdateBookingAssetsParams);

    expect(sbMock.calls.rpc).toHaveBeenCalledWith(
      "shelf_booking_update_assets",
      expect.objectContaining({
        p_asset_ids: ["asset-1", "asset-2"],
        p_booking_id: "booking-1",
      })
    );
    expect(result).toEqual(
      expect.objectContaining({ id: "booking-1", status: BookingStatus.ONGOING })
    );
  });

  it("should update asset status to CHECKED_OUT for OVERDUE booking", async () => {
    expect.assertions(2);

    // 1. sbDb.rpc
    sbMock.enqueueData({ success: true });
    // 2. Booking fetch
    sbMock.enqueueData({ id: "booking-1", name: "Test Booking", status: BookingStatus.OVERDUE });
    // 3. Asset fetch for notes
    sbMock.enqueueData([
      { id: "asset-1", title: "Asset 1" },
      { id: "asset-2", title: "Asset 2" },
    ]);

    const result = await updateBookingAssets(mockUpdateBookingAssetsParams);

    expect(sbMock.calls.rpc).toHaveBeenCalled();
    expect(result).toEqual(
      expect.objectContaining({ id: "booking-1", status: BookingStatus.OVERDUE })
    );
  });

  it("should update kit status to CHECKED_OUT when kitIds provided for ONGOING booking", async () => {
    expect.assertions(2);

    // 1. sbDb.rpc - with kitIds
    sbMock.enqueueData({ success: true });
    // 2. Booking fetch
    sbMock.enqueueData({ id: "booking-1", name: "Test Booking", status: BookingStatus.ONGOING });
    // Note: when kitIds are provided, no asset notes are created (kit notes handled separately)

    const params = {
      ...mockUpdateBookingAssetsParams,
      kitIds: ["kit-1", "kit-2"],
    };

    const result = await updateBookingAssets(params);

    expect(sbMock.calls.rpc).toHaveBeenCalledWith(
      "shelf_booking_update_assets",
      expect.objectContaining({
        p_kit_ids: ["kit-1", "kit-2"],
      })
    );
    expect(result).toEqual(
      expect.objectContaining({ id: "booking-1" })
    );
  });

  it("should not update kit status when no kitIds provided", async () => {
    expect.assertions(2);

    // 1. sbDb.rpc
    sbMock.enqueueData({ success: true });
    // 2. Booking fetch
    sbMock.enqueueData({ id: "booking-1", name: "Test Booking", status: BookingStatus.ONGOING });
    // 3. Asset fetch for notes
    sbMock.enqueueData([
      { id: "asset-1", title: "Asset 1" },
      { id: "asset-2", title: "Asset 2" },
    ]);

    await updateBookingAssets(mockUpdateBookingAssetsParams);

    expect(sbMock.calls.rpc).toHaveBeenCalledWith(
      "shelf_booking_update_assets",
      expect.objectContaining({
        p_kit_ids: [],
      })
    );
    expect(sbMock.calls.from).toHaveBeenCalledWith("Booking");
  });

  it("should not update kit status when empty kitIds array provided", async () => {
    expect.assertions(2);

    // 1. sbDb.rpc
    sbMock.enqueueData({ success: true });
    // 2. Booking fetch
    sbMock.enqueueData({ id: "booking-1", name: "Test Booking", status: BookingStatus.ONGOING });
    // 3. Asset fetch for notes
    sbMock.enqueueData([
      { id: "asset-1", title: "Asset 1" },
      { id: "asset-2", title: "Asset 2" },
    ]);

    const params = {
      ...mockUpdateBookingAssetsParams,
      kitIds: [],
    };

    await updateBookingAssets(params);

    expect(sbMock.calls.rpc).toHaveBeenCalledWith(
      "shelf_booking_update_assets",
      expect.objectContaining({
        p_kit_ids: [],
      })
    );
    expect(sbMock.calls.from).toHaveBeenCalledWith("Booking");
  });

  it("should not update asset or kit status for RESERVED booking", async () => {
    expect.assertions(2);

    // 1. sbDb.rpc - RPC handles status logic internally
    sbMock.enqueueData({ success: true });
    // 2. Booking fetch
    sbMock.enqueueData({ id: "booking-1", name: "Test Booking", status: BookingStatus.RESERVED });
    // 3. Asset fetch for notes
    sbMock.enqueueData([
      { id: "asset-1", title: "Asset 1" },
      { id: "asset-2", title: "Asset 2" },
    ]);

    const params = {
      ...mockUpdateBookingAssetsParams,
      kitIds: ["kit-1"],
    };

    await updateBookingAssets(params);

    expect(sbMock.calls.rpc).toHaveBeenCalled();
    expect(sbMock.calls.from).toHaveBeenCalledWith("Booking");
  });

  it("should throw ShelfError when booking lookup fails", async () => {
    expect.assertions(1);

    // sbDb.rpc returns error
    sbMock.enqueueError({ message: "Database error", code: "500" });

    await expect(
      updateBookingAssets(mockUpdateBookingAssetsParams)
    ).rejects.toThrow(ShelfError);
  });

  it("should throw 400 ShelfError when all assets have been deleted", async () => {
    expect.assertions(1);

    // sbDb.rpc returns error about deleted assets
    sbMock.enqueue({
      data: { success: false, error: "None of the selected assets exist. They may have been deleted.", status: 400 },
      error: null,
    });

    await expect(
      updateBookingAssets(mockUpdateBookingAssetsParams)
    ).rejects.toThrow(ShelfError);
  });

  it("should throw 400 ShelfError when some assets have been deleted", async () => {
    expect.assertions(1);

    // sbDb.rpc returns error about deleted assets
    sbMock.enqueue({
      data: { success: false, error: "Some of the selected assets no longer exist. Please reload and try again.", status: 400 },
      error: null,
    });

    await expect(
      updateBookingAssets(mockUpdateBookingAssetsParams)
    ).rejects.toThrow(ShelfError);
  });

  it("should handle duplicate asset IDs without false validation failures", async () => {
    expect.assertions(2);

    // 1. sbDb.rpc - success
    sbMock.enqueueData({ success: true });
    // 2. Booking fetch
    sbMock.enqueueData({ id: "booking-1", name: "Test Booking", status: BookingStatus.DRAFT });
    // 3. Asset fetch for notes
    sbMock.enqueueData([
      { id: "asset-1", title: "Asset 1" },
      { id: "asset-2", title: "Asset 2" },
    ]);

    const params = {
      ...mockUpdateBookingAssetsParams,
      assetIds: ["asset-1", "asset-2", "asset-1"], // duplicate
    };

    const result = await updateBookingAssets(params);

    expect(result).toEqual(
      expect.objectContaining({ id: "booking-1" })
    );
    expect(sbMock.calls.rpc).toHaveBeenCalled();
  });
});

describe("reserveBooking", () => {
  beforeEach(() => {
    vitest.clearAllMocks();
    sbMock.reset();
  });

  const mockReserveParams = {
    id: "booking-1",
    name: "Reserved Booking",
    organizationId: "org-1",
    custodianUserId: "user-1",
    custodianTeamMemberId: "team-1",
    from: futureFromDate,
    to: futureToDate,
    description: "Reserved booking description",
    hints: mockClientHints,
    isSelfServiceOrBase: false,
    tags: [],
  };

  it("should reserve booking successfully with no conflicts", async () => {
    expect.assertions(2);

    const mockBooking = {
      ...mockBookingData,
      status: BookingStatus.DRAFT,
      from: mockReserveParams.from,
      to: mockReserveParams.to,
      assets: [
        {
          id: "asset-1",
          title: "Asset 1",
          status: "AVAILABLE",
          bookings: [], // No conflicting bookings
        },
        {
          id: "asset-2",
          title: "Asset 2",
          status: "AVAILABLE",
          bookings: [], // No conflicting bookings
        },
      ],
    };
    const reservedBooking = { ...mockBooking, status: BookingStatus.RESERVED };

    //@ts-expect-error missing vitest type
    db.booking.findUniqueOrThrow.mockResolvedValue(mockBooking);
    //@ts-expect-error missing vitest type
    db.booking.update.mockResolvedValue(reservedBooking);

    const result = await reserveBooking(mockReserveParams);

    expect(db.booking.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "booking-1" },
        data: expect.objectContaining({
          status: BookingStatus.RESERVED,
          name: "Reserved Booking",
          custodianUser: { connect: { id: "user-1" } },
          custodianTeamMember: { connect: { id: "team-1" } },
          from: futureFromDate,
          to: futureToDate,
          description: "Reserved booking description",
        }),
      })
    );
    expect(result).toEqual(reservedBooking);
  });

  it("should throw error when assets have booking conflicts", async () => {
    expect.assertions(1);

    const mockBooking = {
      ...mockBookingData,
      status: BookingStatus.DRAFT,
      assets: [
        {
          id: "asset-1",
          title: "Asset 1",
          status: "CHECKED_OUT",
          bookings: [
            {
              id: "other-booking",
              status: "ONGOING",
              name: "Conflicting Booking",
            },
          ],
        },
      ],
    };

    //@ts-expect-error missing vitest type
    db.booking.findUniqueOrThrow.mockResolvedValue(mockBooking);

    await expect(reserveBooking(mockReserveParams)).rejects.toThrow(
      "Cannot reserve booking. Some assets are already booked or checked out: Asset 1. Please remove conflicted assets and try again."
    );
  });

  it("should handle booking reservation with different status", async () => {
    expect.assertions(1);

    const mockBooking = {
      ...mockBookingData,
      status: BookingStatus.ONGOING,
      from: mockReserveParams.from,
      to: mockReserveParams.to,
      assets: [], // No assets to conflict
    };
    const reservedBooking = { ...mockBooking, status: BookingStatus.RESERVED };

    //@ts-expect-error missing vitest type
    db.booking.findUniqueOrThrow.mockResolvedValue(mockBooking);
    //@ts-expect-error missing vitest type
    db.booking.update.mockResolvedValue(reservedBooking);

    const result = await reserveBooking(mockReserveParams);
    expect(result).toEqual(reservedBooking);
  });
});

describe("checkoutBooking", () => {
  beforeEach(() => {
    vitest.clearAllMocks();
    sbMock.reset();
  });

  const mockCheckoutParams = {
    id: "booking-1",
    organizationId: "org-1",
    hints: mockClientHints,
    from: futureFromDate,
    to: futureToDate,
  };

  it("should checkout booking successfully with no conflicts", async () => {
    expect.assertions(3);

    const mockBooking = {
      ...mockBookingData,
      status: BookingStatus.RESERVED,
      assets: [
        {
          id: "asset-1",
          kitId: null,
          title: "Asset 1",
          status: "AVAILABLE",
          bookings: [], // No conflicting bookings
        },
        {
          id: "asset-2",
          kitId: "kit-1",
          title: "Asset 2",
          status: "AVAILABLE",
          bookings: [], // No conflicting bookings
        },
      ],
    };
    const checkedOutBooking = { ...mockBooking, status: BookingStatus.ONGOING };

    //@ts-expect-error missing vitest type
    db.booking.findUniqueOrThrow.mockResolvedValue(mockBooking);
    //@ts-expect-error missing vitest type
    db.booking.update.mockResolvedValue(checkedOutBooking);

    const result = await checkoutBooking(mockCheckoutParams);

    expect(db.asset.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ["asset-1", "asset-2"] } },
      data: { status: AssetStatus.CHECKED_OUT },
    });

    expect(db.booking.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "booking-1" },
        data: { status: BookingStatus.ONGOING },
        include: expect.objectContaining({
          _count: { select: { assets: true } },
          assets: true,
          custodianTeamMember: true,
          custodianUser: true,
          organization: expect.objectContaining({
            include: expect.objectContaining({
              owner: expect.objectContaining({
                select: { email: true },
              }),
            }),
          }),
        }),
      })
    );

    expect(result).toEqual(checkedOutBooking);
  });

  it("should throw error when assets have booking conflicts", async () => {
    expect.assertions(1);

    const mockBooking = {
      ...mockBookingData,
      status: BookingStatus.RESERVED,
      assets: [
        {
          id: "asset-1",
          kitId: null,
          title: "Asset 1",
          status: "CHECKED_OUT",
          bookings: [
            {
              id: "other-booking",
              status: "ONGOING",
              name: "Conflicting Booking",
            },
          ],
        },
      ],
    };

    //@ts-expect-error missing vitest type
    db.booking.findUniqueOrThrow.mockResolvedValue(mockBooking);

    await expect(checkoutBooking(mockCheckoutParams)).rejects.toThrow(
      "Cannot check out booking. Some assets are already booked or checked out: Asset 1. Please remove conflicted assets and try again."
    );
  });

  it("should handle checkout for non-reserved booking", async () => {
    expect.assertions(1);

    const mockBooking = {
      ...mockBookingData,
      status: BookingStatus.DRAFT,
      assets: [], // No assets to conflict
    };
    //@ts-expect-error missing vitest type
    db.booking.findUniqueOrThrow.mockResolvedValue(mockBooking);
    //@ts-expect-error missing vitest type
    db.booking.update.mockResolvedValue({
      ...mockBooking,
      status: BookingStatus.ONGOING,
    });

    const result = await checkoutBooking(mockCheckoutParams);
    expect(result).toBeDefined();
  });
});

describe("checkinBooking", () => {
  beforeEach(() => {
    vitest.clearAllMocks();
    sbMock.reset();
  });

  const mockCheckinParams = {
    id: "booking-1",
    organizationId: "org-1",
    hints: mockClientHints,
  };

  it("should checkin booking successfully", async () => {
    expect.assertions(3);

    const mockBooking = {
      ...mockBookingData,
      status: BookingStatus.ONGOING,
      assets: [
        {
          id: "asset-1",
          kitId: null,
          status: AssetStatus.CHECKED_OUT,
          bookings: [{ id: "booking-1", status: BookingStatus.ONGOING }],
        },
        {
          id: "asset-2",
          kitId: "kit-1",
          status: AssetStatus.CHECKED_OUT,
          bookings: [{ id: "booking-1", status: BookingStatus.ONGOING }],
        },
      ],
      partialCheckins: [],
    };
    const checkedInBooking = { ...mockBooking, status: BookingStatus.COMPLETE };

    //@ts-expect-error missing vitest type
    db.booking.findUniqueOrThrow.mockResolvedValue(mockBooking);
    //@ts-expect-error missing vitest type
    db.booking.update.mockResolvedValue(checkedInBooking);

    const result = await checkinBooking(mockCheckinParams);

    expect(db.asset.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ["asset-1", "asset-2"] } },
      data: { status: AssetStatus.AVAILABLE },
    });

    expect(db.booking.update).toHaveBeenCalledWith({
      where: { id: "booking-1" },
      data: { status: BookingStatus.COMPLETE },
      include: expect.any(Object),
    });

    expect(result).toEqual(checkedInBooking);
  });

  it("should reset checked out assets even when partial check-in history exists", async () => {
    expect.assertions(1);

    const mockBooking = {
      ...mockBookingData,
      status: BookingStatus.OVERDUE,
      assets: [
        {
          id: "asset-1",
          kitId: null,
          status: AssetStatus.CHECKED_OUT,
          bookings: [{ id: "booking-1", status: BookingStatus.OVERDUE }],
        },
        {
          id: "asset-2",
          kitId: "kit-1",
          status: AssetStatus.AVAILABLE,
          bookings: [{ id: "booking-1", status: BookingStatus.OVERDUE }],
        },
      ],
      partialCheckins: [
        {
          assetIds: ["asset-1"],
        },
      ],
    };

    //@ts-expect-error missing vitest type
    db.booking.findUniqueOrThrow.mockResolvedValue(mockBooking);
    //@ts-expect-error missing vitest type
    db.booking.update.mockResolvedValue({
      ...mockBooking,
      status: BookingStatus.COMPLETE,
    });

    await checkinBooking(mockCheckinParams);

    expect(db.asset.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ["asset-1"] } },
      data: { status: AssetStatus.AVAILABLE },
    });
  });

  it("should not reset assets that are checked out in another active booking", async () => {
    expect.assertions(1);

    const mockBooking = {
      ...mockBookingData,
      status: BookingStatus.OVERDUE,
      assets: [
        {
          id: "asset-1",
          kitId: null,
          status: AssetStatus.CHECKED_OUT,
          bookings: [
            { id: "booking-1", status: BookingStatus.OVERDUE },
            { id: "booking-2", status: BookingStatus.ONGOING },
          ],
        },
      ],
      partialCheckins: [
        {
          assetIds: ["asset-1"],
        },
      ],
    };

    //@ts-expect-error missing vitest type
    db.booking.findUniqueOrThrow.mockResolvedValue(mockBooking);
    //@ts-expect-error missing vitest type
    db.booking.update.mockResolvedValue({
      ...mockBooking,
      status: BookingStatus.COMPLETE,
    });

    await checkinBooking(mockCheckinParams);

    expect(db.asset.updateMany).not.toHaveBeenCalled();
  });

  it("should reset asset when it was partially checked in from another ongoing booking", async () => {
    // why: Mock database queries to simulate the bug scenario where an asset
    // is partially returned from one booking and then used in another booking
    expect.assertions(1);

    // Scenario:
    // - Booking A (booking-a, ONGOING) has Asset 1 and Asset 2
    // - Asset 2 was partially checked in from Booking A (now AVAILABLE)
    // - Booking B (booking-b, being checked in) has Asset 2 and Asset 3
    // - When Booking B is checked in, Asset 2 should become AVAILABLE
    // - because it's not actively being used in Booking A anymore
    const mockBooking = {
      ...mockBookingData,
      id: "booking-b",
      status: BookingStatus.ONGOING,
      assets: [
        {
          id: "asset-2",
          kitId: null,
          status: AssetStatus.CHECKED_OUT,
          bookings: [
            { id: "booking-b", status: BookingStatus.ONGOING },
            { id: "booking-a", status: BookingStatus.ONGOING },
          ],
        },
        {
          id: "asset-3",
          kitId: null,
          status: AssetStatus.CHECKED_OUT,
          bookings: [{ id: "booking-b", status: BookingStatus.ONGOING }],
        },
      ],
      partialCheckins: [], // No partial check-ins for Booking B
    };

    // Mock partial check-ins for the linked Booking A
    // Asset 2 was already checked in from Booking A
    //@ts-expect-error missing vitest type
    db.partialBookingCheckin.findMany.mockResolvedValue([
      {
        bookingId: "booking-a",
        assetIds: ["asset-2"],
      },
    ]);

    //@ts-expect-error missing vitest type
    db.booking.findUniqueOrThrow.mockResolvedValue(mockBooking);
    //@ts-expect-error missing vitest type
    db.booking.update.mockResolvedValue({
      ...mockBooking,
      status: BookingStatus.COMPLETE,
    });

    await checkinBooking(mockCheckinParams);

    // Both assets should be reset to AVAILABLE because:
    // - Asset 2: was already checked in from Booking A, so no conflict
    // - Asset 3: no other bookings, so no conflict
    expect(db.asset.updateMany).toHaveBeenCalledWith({
      where: {
        id: {
          in: ["asset-2", "asset-3"],
        },
      },
      data: { status: AssetStatus.AVAILABLE },
    });
  });

  it("should reset all assets (kit + singular) even when singular is in partial check-in history", async () => {
    expect.assertions(1);

    const mockBooking = {
      ...mockBookingData,
      status: BookingStatus.OVERDUE,
      assets: [
        // Kit with 3 assets
        {
          id: "kit-asset-1",
          kitId: "kit-1",
          status: AssetStatus.CHECKED_OUT,
          bookings: [{ id: "booking-1", status: BookingStatus.OVERDUE }],
        },
        {
          id: "kit-asset-2",
          kitId: "kit-1",
          status: AssetStatus.CHECKED_OUT,
          bookings: [{ id: "booking-1", status: BookingStatus.OVERDUE }],
        },
        {
          id: "kit-asset-3",
          kitId: "kit-1",
          status: AssetStatus.CHECKED_OUT,
          bookings: [{ id: "booking-1", status: BookingStatus.OVERDUE }],
        },
        // Singular asset that was partially checked in
        {
          id: "singular-asset",
          kitId: null,
          status: AssetStatus.CHECKED_OUT,
          bookings: [{ id: "booking-1", status: BookingStatus.OVERDUE }],
        },
      ],
      partialCheckins: [
        {
          assetIds: ["singular-asset"],
        },
      ],
    };

    //@ts-expect-error missing vitest type
    db.booking.findUniqueOrThrow.mockResolvedValue(mockBooking);
    //@ts-expect-error missing vitest type
    db.booking.update.mockResolvedValue({
      ...mockBooking,
      status: BookingStatus.COMPLETE,
    });

    await checkinBooking(mockCheckinParams);

    expect(db.asset.updateMany).toHaveBeenCalledWith({
      where: {
        id: {
          in: ["kit-asset-1", "kit-asset-2", "kit-asset-3", "singular-asset"],
        },
      },
      data: { status: AssetStatus.AVAILABLE },
    });
  });

  it("should handle checkin for non-ongoing booking", async () => {
    expect.assertions(1);

    const mockBooking = { ...mockBookingData, status: BookingStatus.DRAFT };
    //@ts-expect-error missing vitest type
    db.booking.findUniqueOrThrow.mockResolvedValue(mockBooking);
    //@ts-expect-error missing vitest type
    db.booking.update.mockResolvedValue({
      ...mockBooking,
      status: BookingStatus.COMPLETE,
    });

    const result = await checkinBooking(mockCheckinParams);
    expect(result).toBeDefined();
  });

  it("should schedule auto-archive when enabled", async () => {
    const mockBooking = {
      ...mockBookingData,
      status: BookingStatus.ONGOING,
      assets: [
        {
          id: "asset-1",
          kitId: null,
          status: AssetStatus.CHECKED_OUT,
          bookings: [{ id: "booking-1", status: BookingStatus.ONGOING }],
        },
      ],
      partialCheckins: [],
    };

    //@ts-expect-error missing vitest type
    db.booking.findUniqueOrThrow.mockResolvedValue(mockBooking);
    //@ts-expect-error missing vitest type
    db.booking.update.mockResolvedValue({
      ...mockBooking,
      status: BookingStatus.COMPLETE,
    });
    //@ts-expect-error missing vitest type
    db.bookingSettings.findUnique.mockResolvedValue({
      autoArchiveBookings: true,
      autoArchiveDays: 3,
    });

    await checkinBooking(mockCheckinParams);

    expect(scheduler.sendAfter).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        id: "booking-1",
        eventType: "booking-auto-archive-handler",
      }),
      expect.any(Object),
      expect.any(Date)
    );
  });

  it("should not schedule auto-archive when disabled", async () => {
    const mockBooking = {
      ...mockBookingData,
      status: BookingStatus.ONGOING,
      assets: [
        {
          id: "asset-1",
          kitId: null,
          status: AssetStatus.CHECKED_OUT,
          bookings: [{ id: "booking-1", status: BookingStatus.ONGOING }],
        },
      ],
      partialCheckins: [],
    };

    //@ts-expect-error missing vitest type
    db.booking.findUniqueOrThrow.mockResolvedValue(mockBooking);
    //@ts-expect-error missing vitest type
    db.booking.update.mockResolvedValue({
      ...mockBooking,
      status: BookingStatus.COMPLETE,
    });
    //@ts-expect-error missing vitest type
    db.bookingSettings.findUnique.mockResolvedValue({
      autoArchiveBookings: false,
      autoArchiveDays: 3,
    });

    await checkinBooking(mockCheckinParams);

    expect(scheduler.sendAfter).not.toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        eventType: "booking-auto-archive-handler",
      }),
      expect.any(Object),
      expect.any(Date)
    );
  });

  it("should not schedule auto-archive when settings not found", async () => {
    const mockBooking = {
      ...mockBookingData,
      status: BookingStatus.ONGOING,
      assets: [
        {
          id: "asset-1",
          kitId: null,
          status: AssetStatus.CHECKED_OUT,
          bookings: [{ id: "booking-1", status: BookingStatus.ONGOING }],
        },
      ],
      partialCheckins: [],
    };

    //@ts-expect-error missing vitest type
    db.booking.findUniqueOrThrow.mockResolvedValue(mockBooking);
    //@ts-expect-error missing vitest type
    db.booking.update.mockResolvedValue({
      ...mockBooking,
      status: BookingStatus.COMPLETE,
    });
    //@ts-expect-error missing vitest type
    db.bookingSettings.findUnique.mockResolvedValue(null);

    await checkinBooking(mockCheckinParams);

    expect(scheduler.sendAfter).not.toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        eventType: "booking-auto-archive-handler",
      }),
      expect.any(Object),
      expect.any(Date)
    );
  });
});

describe("archiveBooking", () => {
  beforeEach(() => {
    vitest.clearAllMocks();
    sbMock.reset();
  });

  it("should archive booking successfully", async () => {
    expect.assertions(2);

    const mockBooking = { ...mockBookingData, status: BookingStatus.COMPLETE };
    const archivedBooking = { ...mockBooking, status: BookingStatus.ARCHIVED };

    //@ts-expect-error missing vitest type
    db.booking.findUniqueOrThrow.mockResolvedValue(mockBooking);
    //@ts-expect-error missing vitest type
    db.booking.update.mockResolvedValue(archivedBooking);

    const result = await archiveBooking({
      id: "booking-1",
      organizationId: "org-1",
    });

    expect(db.booking.update).toHaveBeenCalledWith({
      where: { id: "booking-1" },
      data: { status: BookingStatus.ARCHIVED },
    });
    expect(result).toEqual(archivedBooking);
  });

  it("should throw error when booking is not COMPLETE", async () => {
    expect.assertions(1);

    const mockBooking = { ...mockBookingData, status: BookingStatus.ONGOING };
    //@ts-expect-error missing vitest type
    db.booking.findUniqueOrThrow.mockResolvedValue(mockBooking);

    await expect(
      archiveBooking({ id: "booking-1", organizationId: "org-1" })
    ).rejects.toThrow(ShelfError);
  });

  it("should cancel pending auto-archive job on manual archive", async () => {
    const mockBooking = {
      ...mockBookingData,
      status: BookingStatus.COMPLETE,
      activeSchedulerReference: "job-123",
    };
    const archivedBooking = { ...mockBooking, status: BookingStatus.ARCHIVED };

    //@ts-expect-error missing vitest type
    db.booking.findUniqueOrThrow.mockResolvedValue(mockBooking);
    //@ts-expect-error missing vitest type
    db.booking.update.mockResolvedValue(archivedBooking);

    await archiveBooking({ id: "booking-1", organizationId: "org-1" });

    expect(scheduler.cancel).toHaveBeenCalledWith("job-123");
  });

  it("should handle archive when no scheduler reference exists", async () => {
    const mockBooking = {
      ...mockBookingData,
      status: BookingStatus.COMPLETE,
      activeSchedulerReference: null,
    };
    const archivedBooking = { ...mockBooking, status: BookingStatus.ARCHIVED };

    //@ts-expect-error missing vitest type
    db.booking.findUniqueOrThrow.mockResolvedValue(mockBooking);
    //@ts-expect-error missing vitest type
    db.booking.update.mockResolvedValue(archivedBooking);

    await archiveBooking({ id: "booking-1", organizationId: "org-1" });

    expect(scheduler.cancel).not.toHaveBeenCalled();
  });
});

describe("cancelBooking", () => {
  beforeEach(() => {
    vitest.clearAllMocks();
    sbMock.reset();
  });

  it("should cancel booking successfully", async () => {
    expect.assertions(2);

    const mockBooking = {
      ...mockBookingData,
      status: BookingStatus.RESERVED,
      assets: [{ id: "asset-1", kitId: null }],
    };
    const cancelledBooking = {
      ...mockBooking,
      status: BookingStatus.CANCELLED,
    };

    //@ts-expect-error missing vitest type
    db.booking.findUniqueOrThrow.mockResolvedValue(mockBooking);
    //@ts-expect-error missing vitest type
    db.booking.update.mockResolvedValue(cancelledBooking);

    const result = await cancelBooking({
      id: "booking-1",
      organizationId: "org-1",
      hints: mockClientHints,
    });

    expect(db.booking.update).toHaveBeenCalledWith({
      where: { id: "booking-1" },
      data: { status: BookingStatus.CANCELLED },
      include: expect.any(Object),
    });
    expect(result).toEqual(cancelledBooking);
  });

  it("should throw error when booking is already COMPLETE", async () => {
    expect.assertions(1);

    const mockBooking = { ...mockBookingData, status: BookingStatus.COMPLETE };
    //@ts-expect-error missing vitest type
    db.booking.findUniqueOrThrow.mockResolvedValue(mockBooking);

    await expect(
      cancelBooking({
        id: "booking-1",
        organizationId: "org-1",
        hints: mockClientHints,
      })
    ).rejects.toThrow(ShelfError);
  });
});

describe("deleteBooking", () => {
  beforeEach(() => {
    vitest.clearAllMocks();
    sbMock.reset();
  });

  it("should delete booking successfully", async () => {
    expect.assertions(1);

    //@ts-expect-error missing vitest type
    db.booking.findUnique.mockResolvedValue(mockBookingData);
    //@ts-expect-error missing vitest type
    db.booking.delete.mockResolvedValue(mockBookingData);

    await deleteBooking(
      { id: "booking-1", organizationId: "org-1" },
      mockClientHints
    );

    expect(db.booking.findUnique).toHaveBeenCalled();
  });
});

describe("getBooking", () => {
  beforeEach(() => {
    vitest.clearAllMocks();
    sbMock.reset();
  });

  it("should get booking successfully", async () => {
    expect.assertions(1);

    //@ts-expect-error missing vitest type
    db.booking.findFirstOrThrow.mockResolvedValue(mockBookingData);

    const mockRequest = new Request("http://localhost/bookings/booking-1");

    const result = await getBooking({
      id: "booking-1",
      organizationId: "org-1",
      request: mockRequest,
    });

    expect(result).toEqual(mockBookingData);
  });

  it("should handle booking not found", async () => {
    expect.assertions(1);

    //@ts-expect-error missing vitest type
    db.booking.findFirstOrThrow.mockRejectedValue(new Error("Not found"));

    const mockRequest = new Request("http://localhost/bookings/booking-1");

    try {
      await getBooking({
        id: "booking-1",
        organizationId: "org-1",
        request: mockRequest,
      });
    } catch (error) {
      expect(error).toBeDefined();
    }
  });
});

describe("duplicateBooking", () => {
  beforeEach(() => {
    vitest.clearAllMocks();
    sbMock.reset();
  });

  it("should duplicate booking successfully", async () => {
    expect.assertions(2);

    const originalBooking = {
      ...mockBookingData,
      assets: [{ id: "asset-1" }, { id: "asset-2" }],
      tags: [{ id: "tag-1" }],
    };
    const duplicatedBooking = {
      ...originalBooking,
      id: "booking-2",
      name: "Copy of Test Booking",
    };

    //@ts-expect-error missing vitest type
    db.booking.findFirstOrThrow.mockResolvedValue(originalBooking);
    //@ts-expect-error missing vitest type
    db.booking.create.mockResolvedValue(duplicatedBooking);

    const result = await duplicateBooking({
      bookingId: "booking-1",
      organizationId: "org-1",
      userId: "user-1",
      request: new Request("https://example.com"),
    });

    expect(db.booking.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          name: "Test Booking (Copy)",
          status: BookingStatus.DRAFT,
          organizationId: "org-1",
          creatorId: "user-1",
        }),
      })
    );
    expect(result).toEqual(duplicatedBooking);
  });
});

describe("revertBookingToDraft", () => {
  beforeEach(() => {
    vitest.clearAllMocks();
    sbMock.reset();
  });

  it("should revert booking to draft successfully", async () => {
    expect.assertions(2);

    const mockBooking = {
      ...mockBookingData,
      status: BookingStatus.RESERVED,
      assets: [{ id: "asset-1", kitId: null }],
    };
    const draftBooking = { ...mockBooking, status: BookingStatus.DRAFT };

    //@ts-expect-error missing vitest type
    db.booking.findUniqueOrThrow.mockResolvedValue(mockBooking);
    //@ts-expect-error missing vitest type
    db.booking.update.mockResolvedValue(draftBooking);

    const result = await revertBookingToDraft({
      id: "booking-1",
      organizationId: "org-1",
    });

    expect(db.booking.update).toHaveBeenCalledWith({
      where: { id: "booking-1" },
      data: { status: BookingStatus.DRAFT },
    });
    expect(result).toEqual(draftBooking);
  });

  it("should throw error when booking cannot be reverted", async () => {
    expect.assertions(1);

    const mockBooking = { ...mockBookingData, status: BookingStatus.COMPLETE };
    //@ts-expect-error missing vitest type
    db.booking.findUniqueOrThrow.mockResolvedValue(mockBooking);

    await expect(
      revertBookingToDraft({ id: "booking-1", organizationId: "org-1" })
    ).rejects.toThrow(ShelfError);
  });
});

describe("extendBooking", () => {
  beforeEach(() => {
    vitest.clearAllMocks();
    sbMock.reset();
  });

  it("should extend booking successfully", async () => {
    expect.assertions(2);

    const mockBooking = {
      ...mockBookingData,
      status: BookingStatus.ONGOING,
      assets: [
        { id: "asset-1", status: AssetStatus.CHECKED_OUT },
        { id: "asset-2", status: AssetStatus.CHECKED_OUT },
      ],
      partialCheckins: [],
    };
    const extendedBooking = {
      ...mockBooking,
      to: new Date("2025-01-02T17:00:00Z"),
    };

    //@ts-expect-error missing vitest type
    db.booking.findUniqueOrThrow.mockResolvedValue(mockBooking);
    //@ts-expect-error missing vitest type
    db.booking.update.mockResolvedValue(extendedBooking);

    const result = await extendBooking({
      id: "booking-1",
      organizationId: "org-1",
      newEndDate: new Date("2025-01-02T17:00:00Z"),
      hints: mockClientHints,
      userId: "user-1",
      role: OrganizationRoles.ADMIN,
    });

    expect(db.booking.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "booking-1" },
        data: expect.objectContaining({
          to: expect.any(Date),
        }),
        include: expect.any(Object),
      })
    );
    expect(result).toEqual(extendedBooking);
  });

  it("should throw error when booking cannot be extended", async () => {
    expect.assertions(1);

    const mockBooking = { ...mockBookingData, status: BookingStatus.COMPLETE };
    //@ts-expect-error missing vitest type
    db.booking.findUniqueOrThrow.mockResolvedValue(mockBooking);

    await expect(
      extendBooking({
        id: "booking-1",
        organizationId: "org-1",
        newEndDate: new Date("2025-01-02T17:00:00Z"),
        hints: mockClientHints,
        userId: "user-1",
        role: OrganizationRoles.ADMIN,
      })
    ).rejects.toThrow(ShelfError);
  });

  it("should allow self service user to extend their own booking", async () => {
    expect.assertions(1);

    const mockBooking = {
      ...mockBookingData,
      status: BookingStatus.ONGOING,
      creatorId: "user-1",
      custodianUserId: "user-1",
      assets: [{ id: "asset-1", status: AssetStatus.CHECKED_OUT }],
      partialCheckins: [],
    };

    //@ts-expect-error missing vitest type
    db.booking.findUniqueOrThrow.mockResolvedValue(mockBooking);
    //@ts-expect-error missing vitest type
    db.booking.update.mockResolvedValue({
      ...mockBooking,
      to: new Date("2025-01-02T17:00:00Z"),
    });

    await expect(
      extendBooking({
        id: "booking-1",
        organizationId: "org-1",
        newEndDate: new Date("2025-01-02T17:00:00Z"),
        hints: mockClientHints,
        userId: "user-1",
        role: OrganizationRoles.SELF_SERVICE,
      })
    ).resolves.toBeDefined();
  });

  it("should prevent self service user from extending others booking", async () => {
    expect.assertions(1);

    const mockBooking = {
      ...mockBookingData,
      status: BookingStatus.ONGOING,
      creatorId: "user-2",
      custodianUserId: "user-2",
    };

    //@ts-expect-error missing vitest type
    db.booking.findUniqueOrThrow.mockResolvedValue(mockBooking);

    await expect(
      extendBooking({
        id: "booking-1",
        organizationId: "org-1",
        newEndDate: new Date("2025-01-02T17:00:00Z"),
        hints: mockClientHints,
        userId: "user-1",
        role: OrganizationRoles.SELF_SERVICE,
      })
    ).rejects.toThrow(ShelfError);
  });

  it("should prevent base user from extending any booking", async () => {
    expect.assertions(1);

    const mockBooking = {
      ...mockBookingData,
      status: BookingStatus.ONGOING,
    };

    //@ts-expect-error missing vitest type
    db.booking.findUniqueOrThrow.mockResolvedValue(mockBooking);

    await expect(
      extendBooking({
        id: "booking-1",
        organizationId: "org-1",
        newEndDate: new Date("2025-01-02T17:00:00Z"),
        hints: mockClientHints,
        userId: "user-1",
        role: OrganizationRoles.BASE,
      })
    ).rejects.toThrow(ShelfError);
  });

  it("should allow owner to extend any booking", async () => {
    expect.assertions(1);

    const mockBooking = {
      ...mockBookingData,
      status: BookingStatus.ONGOING,
      creatorId: "user-2", // Different user created it
      custodianUserId: "user-2", // Different user is custodian
      assets: [{ id: "asset-1", status: AssetStatus.CHECKED_OUT }],
      partialCheckins: [],
    };

    //@ts-expect-error missing vitest type
    db.booking.findUniqueOrThrow.mockResolvedValue(mockBooking);
    //@ts-expect-error missing vitest type
    db.booking.findMany.mockResolvedValue([]); // No conflicts
    //@ts-expect-error missing vitest type
    db.booking.update.mockResolvedValue({
      ...mockBooking,
      to: new Date("2025-01-02T17:00:00Z"),
    });

    await expect(
      extendBooking({
        id: "booking-1",
        organizationId: "org-1",
        newEndDate: new Date("2025-01-02T17:00:00Z"),
        hints: mockClientHints,
        userId: "user-1", // Different user (OWNER)
        role: OrganizationRoles.OWNER,
      })
    ).resolves.toBeDefined();
  });

  it("should allow self service user who is custodian (not creator) to extend", async () => {
    expect.assertions(1);

    const mockBooking = {
      ...mockBookingData,
      status: BookingStatus.ONGOING,
      creatorId: "user-2", // Different creator
      custodianUserId: "user-1", // But user is custodian
      assets: [{ id: "asset-1", status: AssetStatus.CHECKED_OUT }],
      partialCheckins: [],
    };

    //@ts-expect-error missing vitest type
    db.booking.findUniqueOrThrow.mockResolvedValue(mockBooking);
    //@ts-expect-error missing vitest type
    db.booking.findMany.mockResolvedValue([]); // No conflicts
    //@ts-expect-error missing vitest type
    db.booking.update.mockResolvedValue({
      ...mockBooking,
      to: new Date("2025-01-02T17:00:00Z"),
    });

    await expect(
      extendBooking({
        id: "booking-1",
        organizationId: "org-1",
        newEndDate: new Date("2025-01-02T17:00:00Z"),
        hints: mockClientHints,
        userId: "user-1",
        role: OrganizationRoles.SELF_SERVICE,
      })
    ).resolves.toBeDefined();
  });

  it("should allow self service user who is creator (not custodian) to extend", async () => {
    expect.assertions(1);

    const mockBooking = {
      ...mockBookingData,
      status: BookingStatus.ONGOING,
      creatorId: "user-1", // User is creator
      custodianUserId: "user-2", // But different custodian
      assets: [{ id: "asset-1", status: AssetStatus.CHECKED_OUT }],
      partialCheckins: [],
    };

    //@ts-expect-error missing vitest type
    db.booking.findUniqueOrThrow.mockResolvedValue(mockBooking);
    //@ts-expect-error missing vitest type
    db.booking.findMany.mockResolvedValue([]); // No conflicts
    //@ts-expect-error missing vitest type
    db.booking.update.mockResolvedValue({
      ...mockBooking,
      to: new Date("2025-01-02T17:00:00Z"),
    });

    await expect(
      extendBooking({
        id: "booking-1",
        organizationId: "org-1",
        newEndDate: new Date("2025-01-02T17:00:00Z"),
        hints: mockClientHints,
        userId: "user-1",
        role: OrganizationRoles.SELF_SERVICE,
      })
    ).resolves.toBeDefined();
  });

  it("should prevent extension when clashing bookings exist", async () => {
    expect.assertions(1);

    const mockBooking = {
      ...mockBookingData,
      status: BookingStatus.ONGOING,
      to: new Date("2025-01-01T17:00:00Z"),
      assets: [
        { id: "asset-1", status: AssetStatus.CHECKED_OUT },
        { id: "asset-2", status: AssetStatus.CHECKED_OUT },
      ],
      partialCheckins: [],
    };

    const clashingBooking = {
      id: "booking-2",
      name: "Conflicting Booking",
    };

    //@ts-expect-error missing vitest type
    db.booking.findUniqueOrThrow.mockResolvedValue(mockBooking);
    //@ts-expect-error missing vitest type
    db.booking.findMany.mockResolvedValue([clashingBooking]); // Clashing booking exists

    await expect(
      extendBooking({
        id: "booking-1",
        organizationId: "org-1",
        newEndDate: new Date("2025-01-03T17:00:00Z"),
        hints: mockClientHints,
        userId: "user-1",
        role: OrganizationRoles.ADMIN,
      })
    ).rejects.toThrow(
      "Cannot extend booking because the extended period is overlapping"
    );
  });

  it("should allow extension when no clashing bookings exist", async () => {
    expect.assertions(1);

    const mockBooking = {
      ...mockBookingData,
      status: BookingStatus.ONGOING,
      assets: [{ id: "asset-1", status: AssetStatus.CHECKED_OUT }],
      partialCheckins: [],
    };

    //@ts-expect-error missing vitest type
    db.booking.findUniqueOrThrow.mockResolvedValue(mockBooking);
    //@ts-expect-error missing vitest type
    db.booking.findMany.mockResolvedValue([]); // No clashing bookings
    //@ts-expect-error missing vitest type
    db.booking.update.mockResolvedValue({
      ...mockBooking,
      to: new Date("2025-01-02T17:00:00Z"),
    });

    await expect(
      extendBooking({
        id: "booking-1",
        organizationId: "org-1",
        newEndDate: new Date("2025-01-02T17:00:00Z"),
        hints: mockClientHints,
        userId: "user-1",
        role: OrganizationRoles.ADMIN,
      })
    ).resolves.toBeDefined();
  });

  it("should transition OVERDUE booking to ONGOING when extended", async () => {
    expect.assertions(2);

    const mockBooking = {
      ...mockBookingData,
      status: BookingStatus.OVERDUE,
      to: new Date("2025-01-01T17:00:00Z"),
      assets: [{ id: "asset-1", status: AssetStatus.CHECKED_OUT }],
      partialCheckins: [],
    };

    const extendedBooking = {
      ...mockBooking,
      status: BookingStatus.ONGOING, // Should transition to ONGOING
      to: new Date("2025-01-02T17:00:00Z"),
    };

    //@ts-expect-error missing vitest type
    db.booking.findUniqueOrThrow.mockResolvedValue(mockBooking);
    //@ts-expect-error missing vitest type
    db.booking.findMany.mockResolvedValue([]); // No conflicts
    //@ts-expect-error missing vitest type
    db.booking.update.mockResolvedValue(extendedBooking);

    const result = await extendBooking({
      id: "booking-1",
      organizationId: "org-1",
      newEndDate: new Date("2025-01-02T17:00:00Z"),
      hints: mockClientHints,
      userId: "user-1",
      role: OrganizationRoles.ADMIN,
    });

    expect(db.booking.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: BookingStatus.ONGOING,
          to: expect.any(Date),
        }),
      })
    );
    expect(result.status).toBe(BookingStatus.ONGOING);
  });

  it("should extend partially returned booking when returned assets have no conflicts", async () => {
    expect.assertions(3);

    const mockBooking = {
      ...mockBookingData,
      status: BookingStatus.ONGOING,
      to: new Date("2025-01-01T17:00:00Z"),
      assets: [
        { id: "asset-1", status: AssetStatus.AVAILABLE }, // Returned
        { id: "asset-2", status: AssetStatus.CHECKED_OUT }, // Still checked out
        { id: "asset-3", status: AssetStatus.CHECKED_OUT }, // Still checked out
      ],
      partialCheckins: [{ assetIds: ["asset-1"] }],
    };

    const extendedBooking = {
      ...mockBooking,
      to: new Date("2025-01-03T17:00:00Z"),
    };

    //@ts-expect-error missing vitest type
    db.booking.findUniqueOrThrow.mockResolvedValue(mockBooking);
    //@ts-expect-error missing vitest type
    db.booking.findMany.mockResolvedValue([]); // No conflicts
    //@ts-expect-error missing vitest type
    db.booking.update.mockResolvedValue(extendedBooking);

    const result = await extendBooking({
      id: "booking-1",
      organizationId: "org-1",
      newEndDate: new Date("2025-01-03T17:00:00Z"),
      hints: mockClientHints,
      userId: "user-1",
      role: OrganizationRoles.ADMIN,
    });

    // Should only check conflicts for asset-2 and asset-3 (not asset-1)
    expect(db.booking.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          assets: { some: { id: { in: ["asset-2", "asset-3"] } } },
        }),
      })
    );

    expect(db.booking.update).toHaveBeenCalled();
    expect(result).toEqual(extendedBooking);
  });

  it("should extend booking successfully when returned asset has conflict but active assets don't", async () => {
    expect.assertions(2);

    const mockBooking = {
      ...mockBookingData,
      status: BookingStatus.ONGOING,
      to: new Date("2025-01-01T17:00:00Z"),
      assets: [
        { id: "asset-1", status: AssetStatus.AVAILABLE }, // Returned
        { id: "asset-2", status: AssetStatus.CHECKED_OUT }, // Still checked out
      ],
      partialCheckins: [{ assetIds: ["asset-1"] }],
    };

    const extendedBooking = {
      ...mockBooking,
      to: new Date("2025-01-03T17:00:00Z"),
    };

    //@ts-expect-error missing vitest type
    db.booking.findUniqueOrThrow.mockResolvedValue(mockBooking);
    // asset-1 is booked elsewhere, but it's returned so shouldn't block
    //@ts-expect-error missing vitest type
    db.booking.findMany.mockResolvedValue([]);
    //@ts-expect-error missing vitest type
    db.booking.update.mockResolvedValue(extendedBooking);

    const result = await extendBooking({
      id: "booking-1",
      organizationId: "org-1",
      newEndDate: new Date("2025-01-03T17:00:00Z"),
      hints: mockClientHints,
      userId: "user-1",
      role: OrganizationRoles.ADMIN,
    });

    // Should succeed - returned asset conflicts are ignored
    expect(db.booking.update).toHaveBeenCalled();
    expect(result).toEqual(extendedBooking);
  });

  it("should prevent extension when active (non-returned) asset has conflict", async () => {
    expect.assertions(1);

    const mockBooking = {
      ...mockBookingData,
      status: BookingStatus.ONGOING,
      to: new Date("2025-01-01T17:00:00Z"),
      assets: [
        { id: "asset-1", status: AssetStatus.AVAILABLE }, // Returned
        { id: "asset-2", status: AssetStatus.CHECKED_OUT }, // Still checked out - has conflict
      ],
      partialCheckins: [{ assetIds: ["asset-1"] }],
    };

    const clashingBooking = {
      id: "booking-2",
      name: "Conflicting Booking for Asset 2",
    };

    //@ts-expect-error missing vitest type
    db.booking.findUniqueOrThrow.mockResolvedValue(mockBooking);
    // asset-2 (active) has a conflict
    //@ts-expect-error missing vitest type
    db.booking.findMany.mockResolvedValue([clashingBooking]);

    await expect(
      extendBooking({
        id: "booking-1",
        organizationId: "org-1",
        newEndDate: new Date("2025-01-03T17:00:00Z"),
        hints: mockClientHints,
        userId: "user-1",
        role: OrganizationRoles.ADMIN,
      })
    ).rejects.toThrow(
      "Cannot extend booking because the extended period is overlapping"
    );
  });

  it("should prevent extension when all assets are returned", async () => {
    expect.assertions(1);

    const mockBooking = {
      ...mockBookingData,
      status: BookingStatus.ONGOING,
      to: new Date("2025-01-01T17:00:00Z"),
      assets: [
        { id: "asset-1", status: AssetStatus.AVAILABLE }, // Returned
        { id: "asset-2", status: AssetStatus.AVAILABLE }, // Returned
        { id: "asset-3", status: AssetStatus.AVAILABLE }, // Returned
      ],
      partialCheckins: [{ assetIds: ["asset-1", "asset-2", "asset-3"] }],
    };

    //@ts-expect-error missing vitest type
    db.booking.findUniqueOrThrow.mockResolvedValue(mockBooking);

    await expect(
      extendBooking({
        id: "booking-1",
        organizationId: "org-1",
        newEndDate: new Date("2025-01-03T17:00:00Z"),
        hints: mockClientHints,
        userId: "user-1",
        role: OrganizationRoles.ADMIN,
      })
    ).rejects.toThrow(
      "Cannot extend booking. All assets have been returned. Please complete the booking instead."
    );
  });
});

describe("removeAssets", () => {
  beforeEach(() => {
    vitest.clearAllMocks();
    sbMock.reset();
  });

  it("should remove assets from booking successfully", async () => {
    expect.assertions(1);

    const mockBooking = {
      id: "booking-1",
      assetIds: ["asset-1", "asset-2"],
    };

    //@ts-expect-error missing vitest type
    db.booking.update.mockResolvedValue({
      ...mockBooking,
      name: "Test Booking",
      status: BookingStatus.DRAFT,
      assets: [],
    });

    await removeAssets({
      booking: mockBooking,
      firstName: "Test",
      lastName: "User",
      userId: "user-1",
      organizationId: "org-1",
    });

    expect(db.booking.update).toHaveBeenCalledWith({
      where: { id: "booking-1", organizationId: "org-1" },
      data: {
        assets: {
          disconnect: [{ id: "asset-1" }, { id: "asset-2" }],
        },
      },
      select: {
        id: true,
        name: true,
        status: true,
      },
    });
  });
});

describe("wrapBookingStatusForNote", () => {
  it("should wrap booking status without custodianUserId", () => {
    const result = wrapBookingStatusForNote("DRAFT");
    expect(result).toBe('{% booking_status status="DRAFT" /%}');
  });

  it("should wrap booking status with custodianUserId", () => {
    const result = wrapBookingStatusForNote("RESERVED", "user-123");
    expect(result).toBe(
      '{% booking_status status="RESERVED" custodianUserId="user-123" /%}'
    );
  });

  it("should handle empty custodianUserId", () => {
    const result = wrapBookingStatusForNote("ONGOING", "");
    expect(result).toBe('{% booking_status status="ONGOING" /%}');
  });

  it("should handle undefined custodianUserId", () => {
    const result = wrapBookingStatusForNote("COMPLETE");
    expect(result).toBe('{% booking_status status="COMPLETE" /%}');
  });

  it("should handle all booking statuses", () => {
    const statuses = [
      "DRAFT",
      "RESERVED",
      "ONGOING",
      "OVERDUE",
      "COMPLETE",
      "CANCELLED",
      "ARCHIVED",
    ];

    statuses.forEach((status) => {
      const result = wrapBookingStatusForNote(status);
      expect(result).toBe(`{% booking_status status="${status}" /%}`);
    });
  });
});

describe("getActionTextFromTransition", () => {
  it("should return correct action text for DRAFT->RESERVED transition", () => {
    const result = getActionTextFromTransition(
      BookingStatus.DRAFT,
      BookingStatus.RESERVED
    );
    expect(result).toBe("reserved the booking");
  });

  it("should return correct action text for RESERVED->ONGOING transition", () => {
    const result = getActionTextFromTransition(
      BookingStatus.RESERVED,
      BookingStatus.ONGOING
    );
    expect(result).toBe("checked-out the booking");
  });

  it("should return correct action text for ONGOING->COMPLETE transition", () => {
    const result = getActionTextFromTransition(
      BookingStatus.ONGOING,
      BookingStatus.COMPLETE
    );
    expect(result).toBe("checked-in the booking");
  });

  it("should return correct action text for RESERVED->CANCELLED transition", () => {
    const result = getActionTextFromTransition(
      BookingStatus.RESERVED,
      BookingStatus.CANCELLED
    );
    expect(result).toBe("cancelled the booking");
  });

  it("should return correct action text for ONGOING->CANCELLED transition", () => {
    const result = getActionTextFromTransition(
      BookingStatus.ONGOING,
      BookingStatus.CANCELLED
    );
    expect(result).toBe("cancelled the booking");
  });

  it("should return correct action text for OVERDUE->CANCELLED transition", () => {
    const result = getActionTextFromTransition(
      BookingStatus.OVERDUE,
      BookingStatus.CANCELLED
    );
    expect(result).toBe("cancelled the booking");
  });

  it("should return correct action text for COMPLETE->ARCHIVED transition", () => {
    const result = getActionTextFromTransition(
      BookingStatus.COMPLETE,
      BookingStatus.ARCHIVED
    );
    expect(result).toBe("archived the booking");
  });

  it("should return correct action text for RESERVED->DRAFT transition", () => {
    const result = getActionTextFromTransition(
      BookingStatus.RESERVED,
      BookingStatus.DRAFT
    );
    expect(result).toBe("reverted booking to draft");
  });

  it("should return fallback action text for unknown transitions", () => {
    const result = getActionTextFromTransition(
      BookingStatus.DRAFT,
      BookingStatus.COMPLETE
    );
    expect(result).toBe("changed the booking status");
  });
});

describe("getSystemActionText", () => {
  it("should return correct system action text for ONGOING->OVERDUE transition", () => {
    const result = getSystemActionText(
      BookingStatus.ONGOING,
      BookingStatus.OVERDUE
    );
    expect(result).toBe("Booking became overdue");
  });

  it("should return fallback system action text for unknown transitions", () => {
    const result = getSystemActionText(
      BookingStatus.DRAFT,
      BookingStatus.RESERVED
    );
    expect(result).toBe("Booking status changed");
  });

  it("should return correct system action text for all booking statuses", () => {
    // Test that the function handles all status combinations gracefully
    const statuses = [
      BookingStatus.DRAFT,
      BookingStatus.RESERVED,
      BookingStatus.ONGOING,
      BookingStatus.OVERDUE,
      BookingStatus.COMPLETE,
      BookingStatus.CANCELLED,
      BookingStatus.ARCHIVED,
    ];

    statuses.forEach((fromStatus) => {
      statuses.forEach((toStatus) => {
        if (fromStatus !== toStatus) {
          const result = getSystemActionText(fromStatus, toStatus);
          expect(typeof result).toBe("string");
          expect(result.length).toBeGreaterThan(0);
        }
      });
    });
  });
});

// Note: createStatusTransitionNote is well-tested through integration tests above
// The function is used by reserveBooking, checkoutBooking, checkinBooking, cancelBooking,
// archiveBooking, revertBookingToDraft, and bulkCancelBookings/bulkArchiveBookings

describe("getOngoingBookingForAsset", () => {
  beforeEach(() => {
    vitest.clearAllMocks();
    sbMock.reset();
  });

  it("should return booking when asset is checked out in an ONGOING booking", async () => {
    expect.assertions(2);

    const mockBooking = {
      id: "booking-1",
      name: "Test Booking",
      status: BookingStatus.ONGOING,
      organizationId: "org-1",
    };

    //@ts-expect-error missing vitest type
    db.booking.findFirst.mockResolvedValue(mockBooking);

    const result = await getOngoingBookingForAsset({
      assetId: "asset-1",
      organizationId: "org-1",
    });

    expect(db.booking.findFirst).toHaveBeenCalledWith({
      where: {
        status: { in: [BookingStatus.ONGOING, BookingStatus.OVERDUE] },
        organizationId: "org-1",
        assets: { some: { id: "asset-1" } },
        partialCheckins: { none: { assetIds: { has: "asset-1" } } },
      },
    });
    expect(result).toEqual(mockBooking);
  });

  it("should return booking when asset is checked out in an OVERDUE booking", async () => {
    expect.assertions(2);

    const mockBooking = {
      id: "booking-2",
      name: "Overdue Booking",
      status: BookingStatus.OVERDUE,
      organizationId: "org-1",
    };

    //@ts-expect-error missing vitest type
    db.booking.findFirst.mockResolvedValue(mockBooking);

    const result = await getOngoingBookingForAsset({
      assetId: "asset-2",
      organizationId: "org-1",
    });

    expect(db.booking.findFirst).toHaveBeenCalledWith({
      where: {
        status: { in: [BookingStatus.ONGOING, BookingStatus.OVERDUE] },
        organizationId: "org-1",
        assets: { some: { id: "asset-2" } },
        partialCheckins: { none: { assetIds: { has: "asset-2" } } },
      },
    });
    expect(result).toEqual(mockBooking);
  });

  it("should return null when asset is partially checked in", async () => {
    expect.assertions(2);

    // Mock that no booking is found because the asset is partially checked in
    //@ts-expect-error missing vitest type
    db.booking.findFirst.mockResolvedValue(null);

    const result = await getOngoingBookingForAsset({
      assetId: "asset-3",
      organizationId: "org-1",
    });

    // Verify the query excludes bookings where asset is in partialCheckins
    expect(db.booking.findFirst).toHaveBeenCalledWith({
      where: {
        status: { in: [BookingStatus.ONGOING, BookingStatus.OVERDUE] },
        organizationId: "org-1",
        assets: { some: { id: "asset-3" } },
        partialCheckins: { none: { assetIds: { has: "asset-3" } } },
      },
    });
    expect(result).toBeNull();
  });

  it("should return null when asset is not in any ONGOING or OVERDUE booking", async () => {
    expect.assertions(2);

    //@ts-expect-error missing vitest type
    db.booking.findFirst.mockResolvedValue(null);

    const result = await getOngoingBookingForAsset({
      assetId: "asset-4",
      organizationId: "org-1",
    });

    expect(db.booking.findFirst).toHaveBeenCalledWith({
      where: {
        status: { in: [BookingStatus.ONGOING, BookingStatus.OVERDUE] },
        organizationId: "org-1",
        assets: { some: { id: "asset-4" } },
        partialCheckins: { none: { assetIds: { has: "asset-4" } } },
      },
    });
    expect(result).toBeNull();
  });

  it("should only consider ONGOING and OVERDUE bookings, not RESERVED or DRAFT", async () => {
    expect.assertions(1);

    //@ts-expect-error missing vitest type
    db.booking.findFirst.mockResolvedValue(null);

    await getOngoingBookingForAsset({
      assetId: "asset-5",
      organizationId: "org-1",
    });

    // Verify that only ONGOING and OVERDUE statuses are queried
    expect(db.booking.findFirst).toHaveBeenCalledWith({
      where: {
        status: { in: [BookingStatus.ONGOING, BookingStatus.OVERDUE] },
        organizationId: "org-1",
        assets: { some: { id: "asset-5" } },
        partialCheckins: { none: { assetIds: { has: "asset-5" } } },
      },
    });
  });

  it("should filter by organization ID to ensure org isolation", async () => {
    expect.assertions(1);

    //@ts-expect-error missing vitest type
    db.booking.findFirst.mockResolvedValue(null);

    await getOngoingBookingForAsset({
      assetId: "asset-6",
      organizationId: "org-2",
    });

    expect(db.booking.findFirst).toHaveBeenCalledWith({
      where: {
        status: { in: [BookingStatus.ONGOING, BookingStatus.OVERDUE] },
        organizationId: "org-2",
        assets: { some: { id: "asset-6" } },
        partialCheckins: { none: { assetIds: { has: "asset-6" } } },
      },
    });
  });

  it("should throw ShelfError when database query fails", async () => {
    expect.assertions(1);

    const dbError = new Error("Database connection error");
    //@ts-expect-error missing vitest type
    db.booking.findFirst.mockRejectedValue(dbError);

    await expect(
      getOngoingBookingForAsset({
        assetId: "asset-7",
        organizationId: "org-1",
      })
    ).rejects.toThrow(ShelfError);
  });

  it("should handle scenario where asset is checked in one booking but checked out in another", async () => {
    expect.assertions(2);

    // This is the key bug scenario: asset is checked in one booking (has partial checkin)
    // and checked out in another. The function should return the booking where it's checked out.
    const checkedOutBooking = {
      id: "booking-checked-out",
      name: "Checked Out Booking",
      status: BookingStatus.ONGOING,
      organizationId: "org-1",
    };

    //@ts-expect-error missing vitest type
    db.booking.findFirst.mockResolvedValue(checkedOutBooking);

    const result = await getOngoingBookingForAsset({
      assetId: "asset-8",
      organizationId: "org-1",
    });

    // The query should exclude bookings where asset has partial checkin
    // so we get the right booking
    expect(db.booking.findFirst).toHaveBeenCalledWith({
      where: {
        status: { in: [BookingStatus.ONGOING, BookingStatus.OVERDUE] },
        organizationId: "org-1",
        assets: { some: { id: "asset-8" } },
        partialCheckins: { none: { assetIds: { has: "asset-8" } } },
      },
    });
    expect(result).toEqual(checkedOutBooking);
  });
});
