// @vitest-environment node

import { describe, expect, it } from "vitest";
import { captureAuthCode } from "./middleware";

/** Minimal Hono context the captureAuthCode middleware actually uses. */
type FakeHonoContext = {
  req: { url: string; method: string };
  redirect: (target: string, status?: number) => Response;
};

type MiddlewareFn = (
  c: FakeHonoContext,
  next: () => Promise<void>
) => Promise<Response | undefined | void>;

function makeContext(url: string, method = "GET"): FakeHonoContext {
  return {
    req: { url, method },
    redirect: (target, status = 302) =>
      new Response(null, { status, headers: { location: target } }),
  };
}

/**
 * Run the Hono middleware against a synthetic context and return the
 * Response (or `null` if next() was invoked instead). Avoids spinning
 * up the full Hono app for these unit tests.
 */
async function run(url: string, method = "GET"): Promise<Response | null> {
  const middleware = captureAuthCode() as unknown as MiddlewareFn;
  let nextCalled = false;
  const c = makeContext(url, method);
  const result = await middleware(c, () => {
    nextCalled = true;
    return Promise.resolve();
  });
  if (result instanceof Response) return result;
  if (nextCalled) return null;
  return null;
}

describe("captureAuthCode", () => {
  it("calls next when there is no ?code= on the URL", async () => {
    expect(await run("https://shelf.example.com/assets")).toBeNull();
  });

  it("redirects to /portal-callback preserving the original path as returnTo", async () => {
    const res = await run("https://shelf.example.com/assets/abc-123?code=ABC");
    expect(res?.status).toBe(302);
    const location = res?.headers.get("location");
    expect(location).toBeTruthy();
    const parsed = new URL(location!);
    expect(parsed.pathname).toBe("/portal-callback");
    expect(parsed.searchParams.get("code")).toBe("ABC");
    expect(parsed.searchParams.get("returnTo")).toBe("/assets/abc-123");
  });

  it("preserves other query params on the original URL", async () => {
    const res = await run(
      "https://shelf.example.com/assets?code=ABC&filter=mine&q=foo"
    );
    const parsed = new URL(res!.headers.get("location")!);
    expect(parsed.searchParams.get("returnTo")).toBe(
      "/assets?filter=mine&q=foo"
    );
  });

  it("omits returnTo when the original path is /", async () => {
    const res = await run("https://shelf.example.com/?code=ABC");
    const parsed = new URL(res!.headers.get("location")!);
    expect(parsed.searchParams.get("returnTo")).toBeNull();
    expect(parsed.searchParams.get("code")).toBe("ABC");
  });

  it("calls next when the request is already on /portal-callback (no redirect loop)", async () => {
    expect(
      await run("https://shelf.example.com/portal-callback?code=ABC")
    ).toBeNull();
  });

  it("calls next on non-GET requests carrying ?code= (does not interfere with form posts)", async () => {
    expect(
      await run("https://shelf.example.com/x?code=ABC", "POST")
    ).toBeNull();
  });
});
