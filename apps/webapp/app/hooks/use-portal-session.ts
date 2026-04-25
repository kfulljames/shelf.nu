import { useMemo } from "react";
import { useMatches } from "react-router";

export type PortalSessionSummary = {
  isBreakglass: boolean;
  breakglassExpires: number | null;
  isReadonly: boolean;
  portalRole: string | null;
};

type LayoutData = {
  isBreakglass?: boolean;
  breakglassExpires?: number | null;
  isReadonly?: boolean;
  portalRole?: string | null;
};

/**
 * Reads the MSP Portal session summary out of the `_layout+/_layout.tsx`
 * loader payload. Available from any route rendered inside the main
 * authenticated layout. Returns `null` outside the layout (e.g. on the
 * portal-callback or qr routes).
 */
export function usePortalSession(): PortalSessionSummary | null {
  const matches = useMatches();
  return useMemo(() => {
    for (const match of matches) {
      const data = match.data as LayoutData | undefined;
      if (data && typeof data.isBreakglass === "boolean") {
        return {
          isBreakglass: data.isBreakglass,
          breakglassExpires: data.breakglassExpires ?? null,
          isReadonly: data.isReadonly ?? false,
          portalRole: data.portalRole ?? null,
        };
      }
    }
    return null;
  }, [matches]);
}

/**
 * Convenience hook for UI components that want to disable mutations when
 * the user is in a read-only portal session.
 */
export function useReadonly(): boolean {
  return usePortalSession()?.isReadonly ?? false;
}
