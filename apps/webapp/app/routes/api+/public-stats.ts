import { data } from "react-router";
import { sbDb } from "~/database/supabase.server";
import { makeShelfError } from "~/utils/error";
import { payload, error } from "~/utils/http.server";

export async function loader() {
  try {
    const [assetResult, userResult, qrResult] = await Promise.all([
      sbDb.from("Asset").select("*", { count: "exact", head: true }),
      sbDb.from("User").select("*", { count: "exact", head: true }),
      sbDb.from("Qr").select("*", { count: "exact", head: true }),
    ]);

    const totalAssets = assetResult.count ?? 0;
    const totalUsers = userResult.count ?? 0;
    const totalQrCodes = qrResult.count ?? 0;

    return data(payload({ totalAssets, totalUsers, totalQrCodes }), {
      status: 200,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "public, max-age=604800",
      },
    });
  } catch (cause) {
    const reason = makeShelfError(cause);
    return data(error(reason), { status: reason.status });
  }
}
