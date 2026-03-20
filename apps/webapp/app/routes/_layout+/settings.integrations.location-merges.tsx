import type {
  ActionFunctionArgs,
  LoaderFunctionArgs,
  MetaFunction,
} from "react-router";
import { data, useFetcher } from "react-router";
import { z } from "zod";
import { StatusFilter } from "~/components/booking/status-filter";
import Header from "~/components/layout/header";
import type { HeaderData } from "~/components/layout/header/types";
import { List } from "~/components/list";
import { ListContentWrapper } from "~/components/list/content-wrapper";
import { Filters } from "~/components/list/filters";
import { Badge } from "~/components/shared/badge";
import { Button } from "~/components/shared/button";
import { Td, Th } from "~/components/table";
import { useDisabled } from "~/hooks/use-disabled";
import {
  approveLocationMerge,
  getLocationMergeProposals,
  rejectLocationMerge,
} from "~/modules/integration/location-sync.server";
import { appendToMetaTitle } from "~/utils/append-to-meta-title";
import {
  setCookie,
  updateCookieWithPerPage,
  userPrefs,
} from "~/utils/cookies.server";
import { sendNotification } from "~/utils/emitter/send-notification.server";
import { makeShelfError } from "~/utils/error";
import {
  payload,
  error,
  getCurrentSearchParams,
  parseData,
} from "~/utils/http.server";
import { getParamsValues } from "~/utils/list";
import {
  PermissionAction,
  PermissionEntity,
} from "~/utils/permissions/permission.data";
import { requirePermission } from "~/utils/roles.server";

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

    const statusFilter = searchParams.get("status") ?? "pending";

    const { proposals, total } = await getLocationMergeProposals({
      organizationId,
      status: statusFilter,
      page,
      perPage,
    });

    const totalPages = Math.ceil(total / perPage);

    const header: HeaderData = {
      title: "Location Merge Proposals",
    };

    const modelName = {
      singular: "proposal",
      plural: "proposals",
    };

    return data(
      payload({
        header,
        items: proposals,
        page,
        totalItems: total,
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

export async function action({ context, request }: ActionFunctionArgs) {
  const authSession = context.getSession();
  const { userId } = authSession;

  try {
    await requirePermission({
      userId,
      request,
      entity: PermissionEntity.integration,
      action: PermissionAction.read,
    });

    const formData = await request.formData();
    const { intent, proposalId } = parseData(
      formData,
      z.object({
        intent: z.enum(["approve", "reject"]),
        proposalId: z.string(),
      })
    );

    if (intent === "approve") {
      await approveLocationMerge({ proposalId, userId });
      sendNotification({
        title: "Merge approved",
        message: "Locations have been merged successfully.",
        icon: { name: "success", variant: "success" },
        senderId: userId,
      });
    } else {
      await rejectLocationMerge({ proposalId, userId });
      sendNotification({
        title: "Merge rejected",
        message: "Locations will be kept separate.",
        icon: { name: "success", variant: "success" },
        senderId: userId,
      });
    }

    return payload({ success: true });
  } catch (cause) {
    const reason = makeShelfError(cause, { userId });
    return data(error(reason), { status: reason.status });
  }
}

export const meta: MetaFunction<typeof loader> = ({ data }) => [
  { title: data ? appendToMetaTitle(data.header.title) : "" },
];

export default function LocationMergesPage() {
  return (
    <>
      <Header />
      <ListContentWrapper>
        <Filters
          slots={{
            "left-of-search": (
              <StatusFilter
                statusItems={{
                  pending: "Pending",
                  merged: "Merged",
                  rejected: "Rejected",
                }}
              />
            ),
          }}
        />
        <List
          ItemComponent={MergeProposalItem}
          headerChildren={
            <>
              <Th>Source Location</Th>
              <Th>Target Location</Th>
              <Th>Status</Th>
              <Th>Actions</Th>
            </>
          }
        />
      </ListContentWrapper>
    </>
  );
}

type ProposalItem = {
  id: string;
  status: string;
  similarityScore: number;
  sourceLocation: { id: string; name: string; address: string | null } | null;
  targetLocation: { id: string; name: string; address: string | null } | null;
};

function mergeStatusColor(status: string): {
  color: string;
  textColor: string;
} {
  switch (status) {
    case "pending":
      return { color: "#FFF8E1", textColor: "#F57F17" };
    case "merged":
      return { color: "#E6F4EA", textColor: "#1E7D32" };
    case "rejected":
      return { color: "#F5F5F5", textColor: "#616161" };
    default:
      return { color: "#F5F5F5", textColor: "#616161" };
  }
}

const MergeProposalItem = ({ item }: { item: ProposalItem }) => {
  const fetcher = useFetcher();
  const disabled = useDisabled(fetcher);
  const isPending = item.status === "pending";

  return (
    <>
      <Td className="w-full p-0 md:p-0">
        <div className="flex justify-between gap-3 p-4 md:justify-normal md:px-6">
          <span className="font-medium text-gray-900">
            Merge #{item.id.slice(0, 8)}
          </span>
        </div>
      </Td>

      <Td>
        <div>
          <p className="font-medium">{item.sourceLocation?.name ?? "—"}</p>
          {item.sourceLocation?.address && (
            <p className="text-xs text-gray-500">
              {item.sourceLocation.address}
            </p>
          )}
        </div>
      </Td>

      <Td>
        <div>
          <p className="font-medium">{item.targetLocation?.name ?? "—"}</p>
          {item.targetLocation?.address && (
            <p className="text-xs text-gray-500">
              {item.targetLocation.address}
            </p>
          )}
        </div>
      </Td>

      <Td>
        <Badge
          color={mergeStatusColor(item.status).color}
          textColor={mergeStatusColor(item.status).textColor}
        >
          {item.status}
        </Badge>
      </Td>

      <Td>
        {isPending ? (
          <fetcher.Form method="POST" className="flex gap-2">
            <input type="hidden" name="proposalId" value={item.id} />
            <Button
              type="submit"
              name="intent"
              value="approve"
              variant="primary"
              size="xs"
              disabled={disabled}
            >
              Merge
            </Button>
            <Button
              type="submit"
              name="intent"
              value="reject"
              variant="secondary"
              size="xs"
              disabled={disabled}
            >
              Keep Both
            </Button>
          </fetcher.Form>
        ) : (
          <span className="text-sm text-gray-500">Resolved</span>
        )}
      </Td>
    </>
  );
};
