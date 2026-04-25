import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vitest } from "vitest";

import { BreakglassBanner } from "./breakglass-banner";

describe("BreakglassBanner", () => {
  beforeEach(() => {
    vitest.useFakeTimers();
    vitest.setSystemTime(new Date("2026-04-25T12:00:00Z"));
  });

  afterEach(() => {
    vitest.useRealTimers();
  });

  it("announces emergency access with role=alert", () => {
    render(<BreakglassBanner expiresAt={null} isReadonly={false} />);
    const banner = screen.getByRole("alert");
    expect(banner).toHaveTextContent(/emergency access/i);
    expect(banner).toHaveTextContent(/breakglass session/i);
  });

  it("renders a read-only badge when isReadonly is true", () => {
    render(<BreakglassBanner expiresAt={null} isReadonly />);
    expect(screen.getByText(/read-only/i)).toBeInTheDocument();
  });

  it("does not render a read-only badge when isReadonly is false", () => {
    render(<BreakglassBanner expiresAt={null} isReadonly={false} />);
    expect(screen.queryByText(/read-only/i)).not.toBeInTheDocument();
  });

  it("renders a mm:ss countdown once mounted on the client", () => {
    // Expires 15 minutes from "now" — unix seconds.
    const expiresAt = Math.floor(
      new Date("2026-04-25T12:15:30Z").getTime() / 1000
    );
    render(<BreakglassBanner expiresAt={expiresAt} isReadonly />);

    // useEffect runs the first tick.
    act(() => {
      vitest.advanceTimersByTime(0);
    });
    expect(screen.getByText(/Expires in 15:30/)).toBeInTheDocument();

    // Advance 1 minute and the countdown should decrement.
    act(() => {
      vitest.advanceTimersByTime(60_000);
    });
    expect(screen.getByText(/Expires in 14:30/)).toBeInTheDocument();
  });

  it("clamps the countdown at 0:00 after expiry", () => {
    const expiresAt = Math.floor(
      new Date("2026-04-25T11:59:50Z").getTime() / 1000
    );
    render(<BreakglassBanner expiresAt={expiresAt} isReadonly={false} />);
    act(() => {
      vitest.advanceTimersByTime(0);
    });
    expect(screen.getByText(/Expires in 0:00/)).toBeInTheDocument();
  });

  it("omits the countdown when no expiry is provided", () => {
    render(<BreakglassBanner expiresAt={null} isReadonly />);
    expect(screen.queryByText(/Expires in/)).not.toBeInTheDocument();
  });
});
