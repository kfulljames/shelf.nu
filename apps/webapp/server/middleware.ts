import { createMiddleware } from "hono/factory";
import { pathToRegexp } from "path-to-regexp";
import { getSession } from "remix-hono/session";

import { SERVER_URL } from "~/utils/env";
import { safeRedirect } from "~/utils/http.server";
import { isQrId } from "~/utils/id";
import { getPortalLaunchUrl } from "~/utils/portal-auth.server";
import type { FlashData, SessionData } from "./session";
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
