import { BookingStatus } from "@prisma/client";
import { createSupabaseMock } from "@mocks/supabase";
import { Logger } from "~/utils/logger";
import { scheduler } from "~/utils/scheduler.server";
import { BOOKING_SCHEDULER_EVENTS_ENUM } from "./constants";
import { createStatusTransitionNote } from "./service.server";
import type { SchedulerData } from "./types";
import { registerBookingWorkers } from "./worker.server";

// @vitest-environment node

const sbMock = createSupabaseMock();
// why: testing worker handlers without actual Supabase HTTP calls
vitest.mock("~/database/supabase.server", () => ({
  get sbDb() {
    return sbMock.client;
  },
}));

// why: preventing actual job scheduling during tests
vitest.mock("~/utils/scheduler.server", () => ({
  scheduler: {
    work: vitest.fn(),
    cancel: vitest.fn(),
    sendAfter: vitest.fn(),
  },
  QueueNames: {
    bookingQueue: "booking-queue",
  },
}));

// why: avoiding actual status transition note creation during worker tests
vitest.mock("./service.server", () => ({
  createStatusTransitionNote: vitest.fn().mockResolvedValue(undefined),
  scheduleNextBookingJob: vitest.fn().mockResolvedValue(undefined),
}));

// why: avoiding actual booking note creation during worker tests
vitest.mock("../booking-note/service.server", () => ({
  createSystemBookingNote: vitest.fn().mockResolvedValue({}),
}));

// why: preventing actual email template rendering during tests
vitest.mock("~/emails/bookings-updates-template", () => ({
  bookingUpdatesTemplateString: vitest.fn().mockResolvedValue("<html></html>"),
}));

// why: preventing actual email sending during tests
vitest.mock("~/emails/mail.server", () => ({
  sendEmail: vitest.fn(),
}));

// why: preventing actual email content generation during tests
vitest.mock("./email-helpers", () => ({
  checkoutReminderEmailContent: vitest.fn().mockReturnValue(""),
  overdueBookingEmailContent: vitest.fn().mockReturnValue(""),
  sendCheckinReminder: vitest.fn().mockResolvedValue(undefined),
}));

// why: preventing actual markdoc wrapper execution during tests
vitest.mock("~/utils/markdoc-wrappers", () => ({
  wrapBookingStatusForNote: vitest.fn().mockReturnValue("[STATUS]"),
}));

// why: preventing actual date utility execution during tests
vitest.mock("~/utils/date-fns", () => ({
  getTimeRemainingMessage: vitest.fn().mockReturnValue("1 hour"),
}));

// why: spying on Logger to verify logging behavior without side effects
vitest.mock("~/utils/logger", () => ({
  Logger: {
    warn: vitest.fn(),
    info: vitest.fn(),
    error: vitest.fn(),
  },
}));

// why: preventing ShelfError from interfering with test assertions
vitest.mock("~/utils/error", () => ({
  ShelfError: class ShelfError extends Error {
    constructor(opts: {
      cause: unknown;
      message: string;
      [key: string]: unknown;
    }) {
      super(opts.message);
    }
  },
}));

/**
 * Helper to register workers and extract the auto-archive handler.
 * Since handlers are internal (not exported), we invoke them via
 * the callback registered with scheduler.work.
 */
async function getWorkerHandler(): Promise<
  (job: { data: SchedulerData }) => Promise<void>
> {
  await registerBookingWorkers();
  // scheduler.work is called with (queueName, callback)
  const workMock = scheduler.work as ReturnType<typeof vitest.fn>;
  const callback = workMock.mock.calls[0][1];
  return callback;
}

describe("autoArchiveHandler", () => {
  let workerHandler: (job: { data: SchedulerData }) => Promise<void>;

  beforeAll(async () => {
    workerHandler = await getWorkerHandler();
  });

  beforeEach(() => {
    sbMock.reset();
    vitest.clearAllMocks();
  });

  const mockJob = {
    data: {
      id: "booking-1",
      hints: { timeZone: "UTC", locale: "en-US" },
      eventType: BOOKING_SCHEDULER_EVENTS_ENUM.autoArchiveHandler,
    },
  };

  it("should archive a COMPLETE booking", async () => {
    const mockBooking = {
      id: "booking-1",
      status: BookingStatus.COMPLETE,
      custodianUserId: "user-1",
      organizationId: "org-1",
    };

    // 1st call (maybeSingle): fetch booking
    sbMock.enqueueData(mockBooking);
    // 2nd call (maybeSingle): fetch booking settings
    sbMock.enqueueData({ autoArchiveBookings: true });
    // 3rd call (maybeSingle): archive update returns updated booking
    sbMock.enqueueData({
      id: "booking-1",
      status: BookingStatus.ARCHIVED,
      custodianUserId: "user-1",
    });

    await workerHandler(mockJob);

    expect(sbMock.calls.from).toHaveBeenCalledWith("Booking");
    expect(sbMock.calls.from).toHaveBeenCalledWith("BookingSettings");
    expect(sbMock.calls.update).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "ARCHIVED",
        autoArchivedAt: expect.any(String),
      })
    );
    expect(createStatusTransitionNote).toHaveBeenCalledWith({
      bookingId: "booking-1",
      fromStatus: BookingStatus.COMPLETE,
      toStatus: BookingStatus.ARCHIVED,
      custodianUserId: "user-1",
    });
    expect(Logger.info).toHaveBeenCalledWith("Auto-archived booking booking-1");
  });

  it("should skip when booking not found", async () => {
    // maybeSingle returns null for booking lookup
    sbMock.setData(null);

    await workerHandler(mockJob);

    expect(Logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("not found")
    );
    expect(sbMock.calls.update).not.toHaveBeenCalled();
  });

  it("should skip when booking is no longer COMPLETE", async () => {
    // maybeSingle returns booking with non-COMPLETE status
    sbMock.setData({
      id: "booking-1",
      status: BookingStatus.ARCHIVED,
      custodianUserId: "user-1",
      organizationId: "org-1",
    });

    await workerHandler(mockJob);

    expect(Logger.info).toHaveBeenCalledWith(
      expect.stringContaining("no longer COMPLETE")
    );
    expect(sbMock.calls.update).not.toHaveBeenCalled();
  });

  it("should skip when auto-archive is disabled for org", async () => {
    // 1st call: booking fetch
    sbMock.enqueueData({
      id: "booking-1",
      status: BookingStatus.COMPLETE,
      custodianUserId: "user-1",
      organizationId: "org-1",
    });
    // 2nd call: booking settings fetch
    sbMock.enqueueData({ autoArchiveBookings: false });

    await workerHandler(mockJob);

    expect(Logger.info).toHaveBeenCalledWith(
      expect.stringContaining("disabled for organization")
    );
    expect(sbMock.calls.update).not.toHaveBeenCalled();
  });

  it("should skip on concurrent modification", async () => {
    // 1st call: booking fetch
    sbMock.enqueueData({
      id: "booking-1",
      status: BookingStatus.COMPLETE,
      custodianUserId: "user-1",
      organizationId: "org-1",
    });
    // 2nd call: booking settings fetch
    sbMock.enqueueData({ autoArchiveBookings: true });
    // 3rd call: archive update returns null (concurrent modification)
    sbMock.enqueueData(null);

    await workerHandler(mockJob);

    expect(Logger.info).toHaveBeenCalledWith(
      expect.stringContaining("modified concurrently")
    );
  });

  it("should handle errors gracefully", async () => {
    // Simulate a Supabase error on the first query
    sbMock.setError({ message: "DB connection error" });

    await workerHandler(mockJob);

    expect(Logger.error).toHaveBeenCalled();
  });
});
