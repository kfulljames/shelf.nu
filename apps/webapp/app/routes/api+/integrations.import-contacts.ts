import type { ActionFunctionArgs } from "react-router";
import { data } from "react-router";
import {
  importContacts,
  validateContactImportPayload,
} from "~/modules/integration/contact-import.server";
import { authenticateApiKey } from "~/modules/integration/service.server";
import { makeShelfError, ShelfError } from "~/utils/error";
import { error, payload } from "~/utils/http.server";

/**
 * POST /api/integrations/import-contacts
 *
 * Import contacts from an external source (CW, Ninja, etc.)
 * as TeamMembers. Authenticated via org-scoped API key.
 */
export async function action({ request }: ActionFunctionArgs) {
  try {
    if (request.method !== "POST") {
      throw new ShelfError({
        cause: null,
        message: "Method not allowed",
        label: "Integration",
        status: 405,
      });
    }

    const authHeader = request.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      throw new ShelfError({
        cause: null,
        message: "Missing or invalid Authorization header",
        label: "Integration",
        status: 401,
      });
    }

    const apiKey = authHeader.slice(7);
    const source = await authenticateApiKey(apiKey);

    const body = await request.json();
    const contacts = validateContactImportPayload(body);

    const result = await importContacts({
      organizationId: source.organizationId,
      sourceName: source.name,
      contacts,
    });

    return data(payload(result));
  } catch (cause) {
    const reason = makeShelfError(cause);
    return data(error(reason), { status: reason.status });
  }
}
