import { describe, expect, it, beforeEach, vi } from "vitest";
import { createSupabaseMock } from "@mocks/supabase";

const sbMock = createSupabaseMock();
// why: testing location valuation aggregation logic without actual Supabase HTTP calls
vi.mock("~/database/supabase.server", () => ({
  get sbDb() {
    return sbMock.client;
  },
}));

const { getLocationTotalValuation } = await import("./service.server");

describe("getLocationTotalValuation", () => {
  beforeEach(() => {
    sbMock.reset();
  });

  it("returns the aggregated valuation for all assets in a location", async () => {
    sbMock.setData([{ value: 500.0 }, { value: 734.56 }]);

    const total = await getLocationTotalValuation({ locationId: "loc-123" });

    expect(sbMock.calls.from).toHaveBeenCalledWith("Asset");
    expect(sbMock.calls.select).toHaveBeenCalledWith("value");
    expect(sbMock.calls.eq).toHaveBeenCalledWith("locationId", "loc-123");
    expect(total).toBe(1234.56);
  });

  it("returns 0 when no valuation data is available", async () => {
    sbMock.setData([]);

    const total = await getLocationTotalValuation({ locationId: "loc-123" });

    expect(total).toBe(0);
  });
});
