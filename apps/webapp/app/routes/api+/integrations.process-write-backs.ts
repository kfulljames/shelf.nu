import type { ActionFunctionArgs } from "react-router";
import { processWriteBackQueue } from "~/modules/integration/service.server";
import { ASSETMESH_API_KEY, ASSETMESH_API_URL } from "~/utils/env";
import { ShelfError, makeShelfError } from "~/utils/error";
import { error, payload } from "~/utils/http.server";

/**
 * POST /api/integrations/process-write-backs
 *
 * Internal endpoint to process pending write-back queue jobs.
 * Called by a scheduled job (e.g. cron) or manually triggered.
 *
 * Requires an internal secret header to prevent unauthorized access.
 */
export async function action({ request }: ActionFunctionArgs) {
  try {
    if (request.method !== "POST") {
      throw new ShelfError({
        cause: null,
        message: "Method not allowed",
        label: "Integration",
        status: 405,
        shouldBeCaptured: false,
      });
    }

    // Validate internal secret
    const authHeader = request.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      throw new ShelfError({
        cause: null,
        message: "Unauthorized",
        label: "Integration",
        status: 401,
        shouldBeCaptured: false,
      });
    }

    if (!ASSETMESH_API_URL || !ASSETMESH_API_KEY) {
      throw new ShelfError({
        cause: null,
        message:
          "AssetMesh API configuration is missing. " +
          "Set ASSETMESH_API_URL and ASSETMESH_API_KEY.",
        label: "Integration",
        status: 503,
      });
    }

    const result = await processWriteBackQueue({
      t0ApiUrl: ASSETMESH_API_URL,
      t0ApiKey: ASSETMESH_API_KEY,
      batchSize: 10,
    });

    return Response.json(payload(result), { status: 200 });
  } catch (cause) {
    const reason = makeShelfError(cause);
    return Response.json(error(reason), { status: reason.status });
  }
}
