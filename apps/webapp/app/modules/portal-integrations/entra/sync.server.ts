import { db } from "~/database/db.server";
import { ShelfError } from "~/utils/error";
import { Logger } from "~/utils/logger";
import {
  listAllUsers,
  normalizeEntraUser,
  type NormalizedEntraUser,
} from "./client.server";

export type EntraSyncContext = {
  portalToken: string;
  tenantId: string;
};

export type EntraSyncResult = {
  fetched: number;
  created: number;
  /** Users that already existed in Shelf and were left untouched.
   * Stage 6 intentionally does not overwrite existing users' names
   * because there is no locked-fields model on User; a later chunk
   * can tighten this once the product decides the merge policy. */
  existing: number;
  /** Users that had no usable email (mail + UPN both missing) and
   * were ignored. */
  skipped: number;
  /** Users whose Shelf insert threw — logged and counted here so the
   * batch continues. */
  failed: number;
};

async function createShelfUser(user: NormalizedEntraUser): Promise<void> {
  await db.user.create({
    data: {
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      // Shelf requires `username` via a cuid default; we rely on that
      // default. Users created via Entra sync haven't logged in, so
      // `onboarded` stays false and the portal-launch flow handles
      // onboarding when they actually arrive.
    },
  });
}

export async function syncEntraUsers(
  ctx: EntraSyncContext
): Promise<EntraSyncResult> {
  const entraUsers = await listAllUsers(ctx);

  let created = 0;
  let existing = 0;
  let skipped = 0;
  let failed = 0;

  for (const raw of entraUsers) {
    const normalized = normalizeEntraUser(raw);
    if (!normalized) {
      skipped += 1;
      continue;
    }

    try {
      const found = await db.user.findUnique({
        where: { email: normalized.email },
        select: { id: true },
      });

      if (found) {
        existing += 1;
        continue;
      }

      await createShelfUser(normalized);
      created += 1;
    } catch (cause) {
      failed += 1;
      Logger.error(
        new ShelfError({
          cause,
          message: "Skipping Entra user — Shelf upsert failed",
          additionalData: {
            email: normalized.email,
            entraObjectId: normalized.entraObjectId,
          },
          label: "Integration",
        })
      );
    }
  }

  Logger.info(
    `[entra-sync] fetched=${entraUsers.length} created=${created} ` +
      `existing=${existing} skipped=${skipped} failed=${failed}`
  );

  return {
    fetched: entraUsers.length,
    created,
    existing,
    skipped,
    failed,
  };
}
