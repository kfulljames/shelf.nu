import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { data } from "react-router";
import { StatusFilter } from "~/components/booking/status-filter";
import Header from "~/components/layout/header";
import type { HeaderData } from "~/components/layout/header/types";
import { List } from "~/components/list";
import { ListContentWrapper } from "~/components/list/content-wrapper";
import { Filters } from "~/components/list/filters";
import { SortBy } from "~/components/list/filters/sort-by";
import { Badge } from "~/components/shared/badge";
import { DateS } from "~/components/shared/date";
import { EmptyTableValue } from "~/components/shared/empty-table-value";
import { Td, Th } from "~/components/table";
import { getSyncLogsForOrganization } from "~/modules/integration/service.server";
import { appendToMetaTitle } from "~/utils/append-to-meta-title";
import {
  setCookie,
  updateCookieWithPerPage,
  userPrefs,
} from "~/utils/cookies.server";
import { makeShelfError } from "~/utils/error";
import { payload, error, getCurrentSearchParams } from "~/utils/http.server";
import { getParamsValues } from "~/utils/list";
import {
  PermissionAction,
  PermissionEntity,
} from "~/utils/permissions/permission.data";
import { requirePermission } from "~/utils/roles.server";

const SYNC_LOG_SORTING_OPTIONS = {
  startedAt: "Started",
  completedAt: "Completed",
} as const;

export async function loader({ context, request }: LoaderFunctionArgs) {
  const authSession = context.getSession();
  const { userId } = authSession;

  try {
    const { organizationId } = await requirePermission({
      userId,
      request,
      entity: PermissionEntity.integration,
      action: PermissionAction.read,
    });

    const searchParams = getCurrentSearchParams(request);
    const { page, perPageParam } = getParamsValues(searchParams);
    const cookie = await updateCookieWithPerPage(request, perPageParam);
    const { perPage } = cookie;

    const statusFilter = searchParams.get("status");
    const status = statusFilter && statusFilter !== "ALL" ? statusFilter : null;

    const { syncLogs, totalSyncLogs } = await getSyncLogsForOrganization({
      organizationId,
      page,
      perPage,
      status,
    });

    const totalPages = Math.ceil(totalSyncLogs / perPage);

    const header: HeaderData = {
      title: "Integration Sync Logs",
    };

    const modelName = {
      singular: "sync log",
      plural: "sync logs",
    };

    return data(
      payload({
        header,
        items: syncLogs,
        page,
        totalItems: totalSyncLogs,
        totalPages,
        perPage,
        modelName,
      }),
      {
        headers: [setCookie(await userPrefs.serialize(cookie))],
      }
    );
  } catch (cause) {
    const reason = makeShelfError(cause, { userId });
    throw data(error(reason), { status: reason.status });
  }
}

export const meta: MetaFunction<typeof loader> = ({ data }) => [
  { title: data ? appendToMetaTitle(data.header.title) : "" },
];

export default function SyncLogsPage() {
  return (
    <>
      <Header />
      <ListContentWrapper>
        <Filters
          slots={{
            "left-of-search": (
              <StatusFilter
                statusItems={{
                  running: "Running",
                  completed: "Completed",
                  failed: "Failed",
                }}
              />
            ),
            "right-of-search": (
              <SortBy
                sortingOptions={SYNC_LOG_SORTING_OPTIONS}
                defaultSortingBy="startedAt"
                defaultSortingDirection="desc"
              />
            ),
          }}
        />
        <List
          ItemComponent={SyncLogListItem}
          headerChildren={
            <>
              <Th>Status</Th>
              <Th>Source</Th>
              <Th>Records</Th>
              <Th>Created</Th>
              <Th>Updated</Th>
              <Th>Errors</Th>
              <Th>Started</Th>
              <Th>Completed</Th>
            </>
          }
        />
      </ListContentWrapper>
    </>
  );
}

type SyncLogItem = {
  id: string;
  status: string;
  recordsProcessed: number | null;
  recordsCreated: number | null;
  recordsUpdated: number | null;
  recordsFailed: number | null;
  startedAt: string | Date;
  completedAt: string | Date | null;
  errorMessage: string | null;
  integrationSource: {
    name: string;
    displayName: string | null;
  } | null;
};

function statusColor(status: string): { color: string; textColor: string } {
  switch (status) {
    case "completed":
      return { color: "#E6F4EA", textColor: "#1E7D32" };
    case "running":
      return { color: "#E3F2FD", textColor: "#1565C0" };
    case "failed":
      return { color: "#FDECEA", textColor: "#C62828" };
    default:
      return { color: "#F5F5F5", textColor: "#616161" };
  }
}

const SyncLogListItem = ({ item }: { item: SyncLogItem }) => {
  const sourceName =
    item.integrationSource?.displayName ||
    item.integrationSource?.name ||
    "Unknown";

  return (
    <>
      <Td className="w-full p-0 md:p-0">
        <div className="flex justify-between gap-3 p-4 md:justify-normal md:px-6">
          <span className="font-medium text-gray-900">
            Sync #{item.id.slice(0, 8)}
          </span>
        </div>
      </Td>

      <Td>
        <Badge
          color={statusColor(item.status).color}
          textColor={statusColor(item.status).textColor}
        >
          {item.status}
        </Badge>
      </Td>

      <Td>{sourceName}</Td>

      <Td className="text-right">
        {item.recordsCreated ?? <EmptyTableValue />}
      </Td>

      <Td className="text-right">
        {item.recordsUpdated ?? <EmptyTableValue />}
      </Td>

      <Td className="text-right">
        {item.recordsFailed ?? <EmptyTableValue />}
      </Td>

      <Td>
        <DateS
          date={item.startedAt}
          options={{ dateStyle: "short", timeStyle: "short" }}
        />
      </Td>

      <Td>
        {item.completedAt ? (
          <DateS
            date={item.completedAt}
            options={{ dateStyle: "short", timeStyle: "short" }}
          />
        ) : (
          <EmptyTableValue />
        )}
      </Td>
    </>
  );
};
