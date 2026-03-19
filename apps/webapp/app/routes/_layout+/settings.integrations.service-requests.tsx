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
import { Button } from "~/components/shared/button";
import { DateS } from "~/components/shared/date";
import { EmptyTableValue } from "~/components/shared/empty-table-value";
import { UserBadge } from "~/components/shared/user-badge";
import { Td, Th } from "~/components/table";
import { getServiceRequestsForOrganization } from "~/modules/service-request/service.server";
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

const SORT_OPTIONS = {
  createdAt: "Created",
  priority: "Priority",
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
    const { page, perPageParam, search } = getParamsValues(searchParams);
    const cookie = await updateCookieWithPerPage(request, perPageParam);
    const { perPage } = cookie;

    const statusFilter = searchParams.get("status");
    const status = statusFilter && statusFilter !== "ALL" ? statusFilter : null;

    const { serviceRequests, totalServiceRequests } =
      await getServiceRequestsForOrganization({
        organizationId,
        page,
        perPage,
        status,
        search: search ?? undefined,
      });

    const totalPages = Math.ceil(totalServiceRequests / perPage);

    const header: HeaderData = {
      title: "Service Requests",
    };

    const modelName = {
      singular: "service request",
      plural: "service requests",
    };

    return data(
      payload({
        header,
        items: serviceRequests,
        search: search ?? undefined,
        page,
        totalItems: totalServiceRequests,
        totalPages,
        perPage,
        modelName,
        searchFieldTooltip: {
          title: "Search service requests",
          text: "Search by title or asset name.",
        },
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

export default function ServiceRequestsPage() {
  return (
    <>
      <Header />
      <ListContentWrapper>
        <Filters
          slots={{
            "left-of-search": (
              <StatusFilter
                statusItems={{
                  OPEN: "Open",
                  IN_PROGRESS: "In Progress",
                  WAITING_ON_PARTS: "Waiting on Parts",
                  ESCALATED: "Escalated",
                  RESOLVED: "Resolved",
                  CLOSED: "Closed",
                }}
              />
            ),
            "right-of-search": (
              <SortBy
                sortingOptions={SORT_OPTIONS}
                defaultSortingBy="createdAt"
                defaultSortingDirection="desc"
              />
            ),
          }}
        />
        <List
          ItemComponent={ServiceRequestListItem}
          headerChildren={
            <>
              <Th>Priority</Th>
              <Th>Asset</Th>
              <Th>Status</Th>
              <Th>Requested By</Th>
              <Th>Assigned To</Th>
              <Th>Ticket</Th>
              <Th>Created</Th>
            </>
          }
        />
      </ListContentWrapper>
    </>
  );
}

type ServiceRequestItem = {
  id: string;
  title: string;
  priority: string;
  status: string;
  externalTicketId: string | null;
  externalTicketUrl: string | null;
  createdAt: string | Date;
  asset: { id: string; title: string };
  requestedBy: {
    firstName: string | null;
    lastName: string | null;
    email: string;
    profilePicture: string | null;
  };
  assignedTo: { id: string; name: string } | null;
};

function priorityColor(priority: string): {
  color: string;
  textColor: string;
} {
  switch (priority) {
    case "URGENT":
      return { color: "#FDECEA", textColor: "#C62828" };
    case "HIGH":
      return { color: "#FFF3E0", textColor: "#E65100" };
    case "MEDIUM":
      return { color: "#FFF8E1", textColor: "#F57F17" };
    case "LOW":
      return { color: "#E8F5E9", textColor: "#2E7D32" };
    default:
      return { color: "#F5F5F5", textColor: "#616161" };
  }
}

function statusColor(status: string): { color: string; textColor: string } {
  switch (status) {
    case "OPEN":
      return { color: "#E3F2FD", textColor: "#1565C0" };
    case "IN_PROGRESS":
      return { color: "#FFF8E1", textColor: "#F57F17" };
    case "WAITING_ON_PARTS":
      return { color: "#F3E5F5", textColor: "#7B1FA2" };
    case "ESCALATED":
      return { color: "#FDECEA", textColor: "#C62828" };
    case "RESOLVED":
      return { color: "#E6F4EA", textColor: "#1E7D32" };
    case "CLOSED":
      return { color: "#F5F5F5", textColor: "#616161" };
    default:
      return { color: "#F5F5F5", textColor: "#616161" };
  }
}

const ServiceRequestListItem = ({ item }: { item: ServiceRequestItem }) => {
  const requesterName =
    item.requestedBy.firstName && item.requestedBy.lastName
      ? `${item.requestedBy.firstName} ${item.requestedBy.lastName}`
      : item.requestedBy.email;
  const requesterImg =
    item.requestedBy.profilePicture || "/static/images/default_pfp.jpg";

  return (
    <>
      <Td className="w-full p-0 md:p-0">
        <div className="flex justify-between gap-3 p-4 md:justify-normal md:px-6">
          <span className="font-medium text-gray-900">{item.title}</span>
        </div>
      </Td>

      <Td>
        <Badge
          color={priorityColor(item.priority).color}
          textColor={priorityColor(item.priority).textColor}
        >
          {item.priority}
        </Badge>
      </Td>

      <Td>
        <Button
          to={`/assets/${item.asset.id}/overview`}
          variant="link"
          className="text-left text-sm"
        >
          {item.asset.title}
        </Button>
      </Td>

      <Td>
        <Badge
          color={statusColor(item.status).color}
          textColor={statusColor(item.status).textColor}
        >
          {item.status.replace(/_/g, " ")}
        </Badge>
      </Td>

      <Td>
        <UserBadge name={requesterName} img={requesterImg} />
      </Td>

      <Td>
        {item.assignedTo ? (
          <span className="text-sm">{item.assignedTo.name}</span>
        ) : (
          <EmptyTableValue />
        )}
      </Td>

      <Td>
        {item.externalTicketId ? (
          item.externalTicketUrl ? (
            <a
              href={item.externalTicketUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-sm text-primary-600 hover:underline"
            >
              #{item.externalTicketId}
            </a>
          ) : (
            <span className="text-sm">#{item.externalTicketId}</span>
          )
        ) : (
          <EmptyTableValue />
        )}
      </Td>

      <Td>
        <DateS
          date={item.createdAt}
          options={{ dateStyle: "short", timeStyle: "short" }}
        />
      </Td>
    </>
  );
};
