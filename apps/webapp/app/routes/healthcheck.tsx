// learn more: https://fly.io/docs/reference/configuration/#services-http_checks
import { data } from "react-router";

import { sbDb } from "~/database/supabase.server";
import { ShelfError } from "~/utils/error";
import { payload, error } from "~/utils/http.server";

export async function loader() {
  try {
    // if we can connect to the database and make a simple query
    // and make a HEAD request to ourselves, then we're good.
    const { error: healthError } = await sbDb
      .from("User")
      .select("id")
      .limit(1);

    if (healthError) {
      throw healthError;
    }

    return data(payload({ status: "OK" }));
  } catch (cause) {
    return data(
      error(
        new ShelfError({
          cause,
          message: "Healthcheck failed",
          label: "Healthcheck",
        })
      )
    );
  }
}
