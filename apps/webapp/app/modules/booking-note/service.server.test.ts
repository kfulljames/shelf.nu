import { describe, it, expect, beforeEach, vi } from "vitest";
import { createSupabaseMock } from "@mocks/supabase";
import {
  createBookingNote,
  createSystemBookingNote,
  getBookingNotes,
} from "./service.server";

const sbMock = createSupabaseMock();
// why: testing booking note service logic without actual Supabase HTTP calls
vi.mock("~/database/supabase.server", () => ({
  get sbDb() {
    return sbMock.client;
  },
}));

// why: testing error handling behavior without actual ShelfError implementation
vi.mock("~/utils/error", () => ({
  ShelfError: class ShelfError extends Error {
    constructor(config: any) {
      super(config.message);
      Object.assign(this, config);
    }
  },
}));

describe("BookingNote Service", () => {
  beforeEach(() => {
    sbMock.reset();
  });

  describe("createBookingNote", () => {
    it("should create a booking note with user", async () => {
      const mockNote = {
        id: "note-1",
        content: "Test note",
        type: "COMMENT",
        bookingId: "booking-1",
        userId: "user-1",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      sbMock.setData(mockNote);

      const result = await createBookingNote({
        content: "Test note",
        type: "COMMENT",
        userId: "user-1",
        bookingId: "booking-1",
      });

      expect(sbMock.calls.from).toHaveBeenCalledWith("BookingNote");
      expect(sbMock.calls.insert).toHaveBeenCalledWith({
        content: "Test note",
        type: "COMMENT",
        bookingId: "booking-1",
        userId: "user-1",
      });
      expect(sbMock.calls.select).toHaveBeenCalled();
      expect(sbMock.calls.single).toHaveBeenCalled();
      expect(result).toEqual(mockNote);
    });

    it("should create a booking note without user", async () => {
      const mockNote = {
        id: "note-1",
        content: "System note",
        type: "UPDATE",
        bookingId: "booking-1",
        userId: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      sbMock.setData(mockNote);

      const result = await createBookingNote({
        content: "System note",
        type: "UPDATE",
        bookingId: "booking-1",
      });

      expect(sbMock.calls.from).toHaveBeenCalledWith("BookingNote");
      expect(sbMock.calls.insert).toHaveBeenCalledWith({
        content: "System note",
        type: "UPDATE",
        bookingId: "booking-1",
      });
      expect(result).toEqual(mockNote);
    });
  });

  describe("createSystemBookingNote", () => {
    it("should create a system booking note with UPDATE type", async () => {
      const mockNote = {
        id: "note-1",
        content: "System generated note",
        type: "UPDATE",
        bookingId: "booking-1",
        userId: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      sbMock.setData(mockNote);

      const result = await createSystemBookingNote({
        content: "System generated note",
        bookingId: "booking-1",
      });

      expect(sbMock.calls.from).toHaveBeenCalledWith("BookingNote");
      expect(sbMock.calls.insert).toHaveBeenCalledWith({
        content: "System generated note",
        type: "UPDATE",
        bookingId: "booking-1",
      });
      expect(result).toEqual(mockNote);
    });
  });

  describe("getBookingNotes", () => {
    it("should return booking notes when booking exists in organization", async () => {
      const mockBooking = { id: "booking-1" };
      const mockNotes = [
        {
          id: "note-1",
          content: "Test note",
          type: "COMMENT",
          bookingId: "booking-1",
          userId: "user-1",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          user: { id: "user-1", firstName: "John", lastName: "Doe" },
        },
      ];

      // First call: booking lookup (maybeSingle), second call: notes fetch (then)
      sbMock.enqueueData(mockBooking);
      sbMock.enqueueData(mockNotes);

      const result = await getBookingNotes({
        bookingId: "booking-1",
        organizationId: "org-1",
      });

      // Verify booking lookup
      expect(sbMock.calls.from).toHaveBeenCalledWith("Booking");
      expect(sbMock.calls.eq).toHaveBeenCalledWith("id", "booking-1");
      expect(sbMock.calls.eq).toHaveBeenCalledWith("organizationId", "org-1");

      // Verify notes fetch
      expect(sbMock.calls.from).toHaveBeenCalledWith("BookingNote");
      expect(sbMock.calls.eq).toHaveBeenCalledWith("bookingId", "booking-1");
      expect(sbMock.calls.order).toHaveBeenCalledWith("createdAt", {
        ascending: false,
      });

      expect(result).toEqual(mockNotes);
    });

    it("should throw error when booking does not exist", async () => {
      // Return null for booking lookup
      sbMock.setData(null);

      await expect(
        getBookingNotes({
          bookingId: "booking-1",
          organizationId: "org-1",
        })
      ).rejects.toThrow("Booking not found or access denied");
    });
  });
});
