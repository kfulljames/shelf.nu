import type { ActionFunctionArgs } from "react-router";
import {
  authenticateApiKey,
  ingestGoldenRecords,
} from "~/modules/integration/service.server";
import { ingestionRequestSchema } from "~/modules/integration/types";
import { ShelfError, makeShelfError } from "~/utils/error";
import { error, payload } from "~/utils/http.server";

/**
 * POST /api/integrations/ingest
 *
 * Ingestion endpoint for AssetMesh golden records.
 * Authenticated via org-scoped API key in the Authorization header.
 *
 * Request body: { records: GoldenRecord[] }
 * Response: { syncLogId, results, summary }
 */
export async function action({ request }: ActionFunctionArgs) {
  try {
    // Only allow POST
    if (request.method !== "POST") {
      throw new ShelfError({
        cause: null,
        message: "Method not allowed",
        label: "Integration",
        status: 405,
        shouldBeCaptured: false,
      });
    }

    // Authenticate via API key
    const authHeader = request.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      throw new ShelfError({
        cause: null,
        message:
          "Missing or malformed Authorization header. " +
          "Expected: Bearer <api-key>",
        label: "Integration",
        status: 401,
        shouldBeCaptured: false,
      });
    }

    const apiKey = authHeader.slice(7); // Remove "Bearer "
    const source = await authenticateApiKey(apiKey);

    // Parse and validate request body
    const rawBody: unknown = await request.json();
    const parseResult = ingestionRequestSchema.safeParse(rawBody);

    if (!parseResult.success) {
      throw new ShelfError({
        cause: parseResult.error,
        message: `Invalid request body: ${parseResult.error.issues
          .map((i) => i.message)
          .join(", ")}`,
        label: "Integration",
        status: 400,
        shouldBeCaptured: false,
      });
    }

    // Process golden records
    const result = await ingestGoldenRecords({
      organizationId: source.organizationId,
      integrationSourceId: source.id,
      userId: source.organization.id, // org owner — records are system-created
      records: parseResult.data.records,
    });

    return Response.json(payload(result), { status: 200 });
  } catch (cause) {
    const reason = makeShelfError(cause);
    return Response.json(error(reason), { status: reason.status });
  }
}
