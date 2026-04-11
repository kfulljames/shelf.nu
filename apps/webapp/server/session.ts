import { createCookieSessionStorage } from "react-router";
import { env } from "~/utils/env";

export type AuthSession = {
  portalToken: string;
  userId: string;
  portalUserId: string;
  email: string;
  name: string;
  role: string;
  shelfRole: string;
  tenantId: string | null;
  tenantSlug: string;
  modules: string[];
  groups: string[];
  permissions: string[];
  isReadonly: boolean;
  impersonatedBy: string | null;
  expiresAt: number;
};

export const authSessionKey = "auth";

export type SessionData = {
  [authSessionKey]: AuthSession;
};

export type FlashData = { errorMessage: string };

/** Creates a session storage */
export function createSessionStorage() {
  return createCookieSessionStorage({
    cookie: {
      name: "__authSession",
      httpOnly: true,
      path: "/",
      sameSite: "lax",
      secrets: [env.SESSION_SECRET],
      secure: env.NODE_ENV === "production",
    },
  });
}
