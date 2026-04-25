import { createMiddleware } from "hono/factory";
import { pathToRegexp } from "path-to-regexp";
import { getSession } from "remix-hono/session";

import { SERVER_URL } from "~/utils/env";
import { safeRedirect } from "~/utils/http.server";
import { isQrId } from "~/utils/id";
import { Logger } from "~/utils/logger";
import { getPortalLaunchUrl } from "~/utils/portal-auth.server";
import type { AuthSession, FlashData, SessionData } from "./session";
import { authSessionKey } from "./session";

/**
 * Ensure host headers for React Router CSRF protection
 * React Router v7.12+ requires host or x-forwarded-host headers
 * In dev mode, Vite dev server doesn't always preserve these headers
 * Only applied in development - production environments have headers intact
 */
export function ensureHostHeaders() {
  return createMiddleware(async (c, next) => {
    // Only apply this fix in development mode
    if (process.env.NODE_ENV === "production") {
      return next();
    }

    const originalRequest = c.req.raw;
    const host = originalRequest.headers.get("host");
    const forwardedHost = originalRequest.headers.get("x-forwarded-host");

    // If both headers are missing, create a new Request with host header
    if (!host && !forwardedHost) {
      const headers = new Headers(originalRequest.headers);
      // Use the URL host from the request
      const url = new URL(originalRequest.url);
      headers.set("host", url.host);

      // Create new Request with the updated headers
      const newRequest = new Request(originalRequest.url, {
        method: originalRequest.method,
        headers,
        body: originalRequest.body,
        // @ts-expect-error - duplex is required for streaming bodies
        duplex: "half",
      });

      // Replace the request in the context
      c.req.raw = newRequest;
    }

    return next();
  });
}

/**
 * Protected routes middleware
 *
 * @param options.publicPath - The public paths
 * @param options.onFailRedirectTo - The path to redirect to if the user is not logged in
 */
export function protect({
  publicPaths,
}: {
  publicPaths: string[];
  onFailRedirectTo?: string;
}) {
  return createMiddleware(async (c, next) => {
    // Skip authentication for internal Remix/framework routes (manifest, etc.)
    if (c.req.path.startsWith("/__")) {
      return next();
    }

    // For single fetch routes (*.data), strip the .data suffix before checking
    const pathToCheck = c.req.path.endsWith(".data")
      ? c.req.path.slice(0, -5)
      : c.req.path;

    if (pathMatch(publicPaths, pathToCheck)) {
      return next();
    }

    const session = getSession<SessionData, FlashData>(c);
    const auth = session.get(authSessionKey);

    if (!auth) {
      // Redirect to portal for authentication
      return c.redirect(getPortalLaunchUrl());
    }

    // Check if portal token is expired
    if (auth.expiresAt * 1000 < Date.now()) {
      session.unset(authSessionKey);
      // Redirect to portal for re-auth
      return c.redirect(getPortalLaunchUrl());
    }

    return next();
  });
}

/**
 * Catch portal auth-code redirects on any URL.
 *
 * The portal can redirect a user back to any URL inside the module
 * (`/assets/abc-123?code=…`, `/?code=…`, etc.) — not just a fixed
 * callback route. This middleware intercepts the auth code wherever
 * it lands, then redirects to the dedicated `/portal-callback` route
 * with the original path preserved as `returnTo`. The callback route
 * does the exchange, provisioning and session-set, then redirects
 * back to the original path.
 *
 * Skipping the callback path itself avoids a redirect loop.
 */
export function captureAuthCode() {
  return createMiddleware(async (c, next) => {
    const method = c.req.method.toUpperCase();
    if (method !== "GET" && method !== "HEAD") return next();

    const url = new URL(c.req.url);
    const code = url.searchParams.get("code");
    if (!code) return next();

    if (url.pathname === "/portal-callback") return next();

    // Build the original path without the ?code so the user lands on
    // a clean URL after the exchange. Other params are preserved.
    const stripped = new URLSearchParams(url.searchParams);
    stripped.delete("code");
    const returnTo =
      url.pathname + (stripped.toString() ? `?${stripped.toString()}` : "");

    const callback = new URL("/portal-callback", url);
    callback.searchParams.set("code", code);
    if (returnTo && returnTo !== "/") {
      callback.searchParams.set("returnTo", returnTo);
    }
    return c.redirect(callback.toString());
  });
}

function pathMatch(paths: string[], requestPath: string) {
  for (const path of paths) {
    const regex = pathToRegexp(path);

    if (regex.test(requestPath)) {
      return true;
    }
  }

  return false;
}

/**
 * Structured context about the current portal session. Emitted
 * alongside any security-relevant middleware event so downstream log
 * aggregation has a consistent shape to filter on.
 */
function portalAuditContext(auth: AuthSession) {
  return {
    portalUserId: auth.portalUserId,
    userId: auth.userId,
    tenantId: auth.tenantId,
    role: auth.role,
    shelfRole: auth.shelfRole,
    breakglass: auth.breakglass,
    breakglassExpires: auth.breakglassExpires,
    isReadonly: auth.isReadonly,
    impersonatedBy: auth.impersonatedBy,
  };
}

/**
 * Block write requests (POST / PUT / PATCH / DELETE) when the current
 * session carries the portal's `isReadonly` claim. Required by the
 * portal RBAC guide for breakglass sessions: "Respect `isReadonly` —
 * block all write operations when `isReadonly: true`."
 *
 * Also emits a structured warn line so every blocked attempt is
 * visible in observability — Shelf has no persistent access-audit
 * table today, so the logger is the audit trail for Chunk 2.3.
 */
export function enforceReadonly({ publicPaths }: { publicPaths: string[] }) {
  return createMiddleware(async (c, next) => {
    const method = c.req.method.toUpperCase();
    if (method === "GET" || method === "HEAD" || method === "OPTIONS") {
      return next();
    }

    const pathToCheck = c.req.path.endsWith(".data")
      ? c.req.path.slice(0, -5)
      : c.req.path;

    if (pathMatch(publicPaths, pathToCheck)) {
      return next();
    }

    const session = getSession<SessionData, FlashData>(c);
    const auth = session.get(authSessionKey);

    if (!auth || !auth.isReadonly) {
      return next();
    }

    Logger.warn({
      event: "portal.readonly_block",
      method,
      path: c.req.path,
      ...portalAuditContext(auth),
    });

    return c.json(
      {
        error: {
          title: "Read-only access",
          message:
            "Your session is read-only. Write actions are disabled for the duration of this breakglass session.",
        },
      },
      403
    );
  });
}

/**
 * Cache middleware
 *
 * @param seconds - The number of seconds to cache
 */
export function cache(seconds: number) {
  return createMiddleware(async (c, next) => {
    if (!c.req.path.match(/\.[a-zA-Z0-9]+$/) || c.req.path.endsWith(".data")) {
      return next();
    }

    await next();

    if (!c.res.ok) {
      return;
    }

    c.res.headers.set("cache-control", `public, max-age=${seconds}`);
  });
}

/**
 * URL shortner middleware
 */

export function urlShortener({ excludePaths }: { excludePaths: string[] }) {
  return createMiddleware(async (c, next) => {
    const fullPath = c.req.path;

    // In react-router-hono-server v2, we no longer use getPath to prepend the host
    // The path is just the regular path, so no need to remove URL_SHORTENER prefix
    const pathParts = fullPath.split("/").filter(Boolean);
    const pathname = "/" + pathParts.join("/");

    // console.log(`urlShortener middleware: Processing ${pathname}`);

    // Check if the current request path matches any of the excluded paths
    const isExcluded = excludePaths.some((path) => pathname.startsWith(path));
    if (isExcluded) {
      // console.log(
      //   `urlShortener middleware: Skipping excluded path ${pathname}`
      // );
      return next();
    }

    const path = pathParts.join("/");

    // Check if the path is a single segment and a valid CUID
    if (pathParts.length === 1 && isQrId(path)) {
      const redirectUrl = `${SERVER_URL}/qr/${path}`;
      // console.log(`urlShortener middleware: Redirecting QR to ${redirectUrl}`);
      return c.redirect(safeRedirect(redirectUrl), 301);
    }

    // console.log(`urlShortener middleware: Redirecting to ${SERVER_URL}`);
    /**
     * In all other cases, we just redirect to the app root.
     * The URL shortener should only be used for QR codes
     * */
    return c.redirect(safeRedirect(SERVER_URL), 301);
  });
}
