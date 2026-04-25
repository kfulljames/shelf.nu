import { useEffect, useState } from "react";
import { tw } from "~/utils/tw";

type Props = {
  /** Unix seconds when the breakglass session ends. */
  expiresAt: number | null;
  /** Whether the session is also read-only. */
  isReadonly: boolean;
  className?: string;
};

/**
 * A persistent top-of-app banner shown whenever the current session carries
 * the `breakglass: true` claim from the MSP Portal. Required by the portal
 * RBAC guide (modules must log and surface breakglass sessions prominently).
 */
export function BreakglassBanner({ expiresAt, isReadonly, className }: Props) {
  const remaining = useBreakglassCountdown(expiresAt);

  return (
    <div
      role="alert"
      aria-live="polite"
      className={tw(
        "-mx-4 flex flex-wrap items-center justify-center gap-x-3 gap-y-1 bg-error-600 px-4 py-2 text-center text-sm font-semibold text-white",
        className
      )}
    >
      <span className="uppercase tracking-wider">Emergency access</span>
      <span className="font-normal text-white/90">
        You are using a breakglass session.
      </span>
      {isReadonly ? (
        <span className="rounded border border-white/30 bg-white/10 px-2 py-0.5 text-xs uppercase tracking-wide">
          Read-only
        </span>
      ) : null}
      {remaining ? (
        <span className="font-mono text-xs text-white/80">
          Expires in {remaining}
        </span>
      ) : null}
    </div>
  );
}

function formatRemaining(msLeft: number): string {
  if (msLeft <= 0) return "0:00";
  const totalSeconds = Math.floor(msLeft / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

function useBreakglassCountdown(expiresAt: number | null): string | null {
  const [now, setNow] = useState<number | null>(null);

  useEffect(() => {
    if (!expiresAt) return;
    // Only run on the client — keeps initial SSR output stable.
    setNow(Date.now());
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, [expiresAt]);

  if (!expiresAt || now === null) return null;
  return formatRemaining(expiresAt * 1000 - now);
}
