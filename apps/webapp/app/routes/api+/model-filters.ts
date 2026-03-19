import { TagUseFor } from "@prisma/client";
import { data, type LoaderFunctionArgs } from "react-router";
import { z } from "zod";
import { sbDb } from "~/database/supabase.server";
import { getSelectedOrganization } from "~/modules/organization/context.server";
import { makeShelfError, ShelfError } from "~/utils/error";
import { payload, error, parseData } from "~/utils/http.server";

const BasicModelFilters = z.object({
  /** key of field for which we have to filter values */
  queryKey: z.string(),

  /** Actual value */
  queryValue: z.string().optional(),

  /** What user have already selected, so that we can exclude them */
  selectedValues: z.string().optional(),
});

/**
 * The schema used for each different model.
 * To allow filtersing and searching on different models update the schema for the relevant model
 */
export const ModelFiltersSchema = z.discriminatedUnion("name", [
  BasicModelFilters.extend({
    name: z.literal("asset"),
  }),
  BasicModelFilters.extend({
    name: z.literal("tag"),
    useFor: z.nativeEnum(TagUseFor).optional(),
  }),
  BasicModelFilters.extend({
    name: z.literal("category"),
  }),
  BasicModelFilters.extend({
    name: z.literal("location"),
  }),
  BasicModelFilters.extend({
    name: z.literal("kit"),
  }),
  BasicModelFilters.extend({
    name: z.literal("teamMember"),
    deletedAt: z.string().nullable().optional(),
    userWithAdminAndOwnerOnly: z.coerce.boolean().optional(), // To get only the teamMembers which are admin or owner
    usersOnly: z.coerce.boolean().optional(), // To get only the teamMembers with users (exclude NRMs)
  }),
  BasicModelFilters.extend({
    name: z.literal("booking"),
  }),
]);

export type AllowedModelNames = z.infer<typeof ModelFiltersSchema>["name"];
export type ModelFilters = z.infer<typeof ModelFiltersSchema>;
export type ModelFiltersLoader = typeof loader;

export async function loader({ context, request }: LoaderFunctionArgs) {
  const authSession = context.getSession();
  const { userId } = authSession;

  try {
    const { organizationId } = await getSelectedOrganization({
      userId,
      request,
    });

    /** Getting all the query parameters from url */
    const url = new URL(request.url);
    const searchParams: Record<string, any> = {};
    for (const [key, value] of url.searchParams.entries()) {
      if (value === "null") {
        searchParams[key] = null;
      } else {
        searchParams[key] = value;
      }
    }

    /** Validating parameters */
    const modelFilters = parseData(searchParams, ModelFiltersSchema);
    const { name, queryKey, queryValue, selectedValues } = modelFilters;

    const selectedValuesArray = selectedValues
      ? selectedValues.split(",").filter(Boolean)
      : [];

    const { data: rpcData, error: rpcErr } = await sbDb.rpc(
      "shelf_model_filter_search",
      {
        p_organization_id: organizationId,
        p_model_name: name,
        p_query_key: queryKey,
        p_query_value: queryValue ?? null,
        p_selected_values:
          selectedValuesArray.length > 0 ? selectedValuesArray : null,
        p_use_for:
          modelFilters.name === "tag" ? (modelFilters.useFor ?? null) : null,
        p_deleted_at:
          modelFilters.name === "teamMember"
            ? (modelFilters.deletedAt ?? null)
            : null,
        p_admin_owner_only:
          modelFilters.name === "teamMember"
            ? (modelFilters.userWithAdminAndOwnerOnly ?? false)
            : false,
        p_users_only:
          modelFilters.name === "teamMember"
            ? (modelFilters.usersOnly ?? false)
            : false,
      }
    );

    if (rpcErr) {
      throw new ShelfError({
        cause: rpcErr,
        message: "Failed to search model filters",
        additionalData: { name, queryKey },
        label: "Assets",
      });
    }

    const queryData = (rpcData as unknown as Array<Record<string, any>>) ?? [];

    return data(
      payload({
        filters: queryData.map((item) => ({
          id: item.id,
          name: item[queryKey],
          color: item?.color,
          metadata: item,
          user: item?.user as any,
        })),
      })
    );
  } catch (cause) {
    const reason = makeShelfError(cause, { userId });
    return data(error(reason), { status: reason.status });
  }
}
