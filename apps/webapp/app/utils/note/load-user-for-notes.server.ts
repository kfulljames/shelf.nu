import type { User } from "@prisma/client";

import { sbDb } from "~/database/supabase.server";

/**
 * Basic user name type for notes
 */
export type BasicUserName = {
  firstName: string | null;
  lastName: string | null;
};

/**
 * Memoized loader for user names used inside note creation helpers.
 * Returns a function so callers can reuse the same closure without repeated queries.
 */
export function createLoadUserForNotes(userId: User["id"]) {
  let cachedUser: BasicUserName | null = null;

  return async (): Promise<BasicUserName> => {
    if (!cachedUser) {
      const { data: user } = await sbDb
        .from("User")
        .select("firstName, lastName")
        .eq("id", userId)
        .maybeSingle();

      cachedUser = user
        ? {
            firstName: user.firstName as string | null,
            lastName: user.lastName as string | null,
          }
        : { firstName: null, lastName: null };
    }

    return cachedUser;
  };
}
