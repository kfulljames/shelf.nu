import type { ActionFunctionArgs } from "react-router";
import {
  authenticateApiKey,
  archiveMissingAssets,
} from "~/modules/integration/service.server";
import { deltaSyncCompleteSchema } from "~/modules/integration/types";
import { ShelfError, makeShelfError } from "~/utils/error";
import { error, payload } from "~/utils/http.server";

/**
 * POST /api/integrations/delta-sync-complete
 *
 * Called by AssetMesh after a full delta push to declare which
 * golden records are still active. Assets not in the list are archived.
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

    const apiKey = authHeader.slice(7);
    const source = await authenticateApiKey(apiKey);

    const rawBody: unknown = await request.json();
    const parseResult = deltaSyncCompleteSchema.safeParse(rawBody);

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

    const result = await archiveMissingAssets({
      organizationId: source.organizationId,
      sourceName: parseResult.data.sourceName,
      activeGoldenRecordIds: parseResult.data.activeGoldenRecordIds,
    });

    return Response.json(payload(result), { status: 200 });
  } catch (cause) {
    const reason = makeShelfError(cause);
    return Response.json(error(reason), { status: reason.status });
  }
}
