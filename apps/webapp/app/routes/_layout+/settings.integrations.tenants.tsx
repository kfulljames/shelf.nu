import type {
  ActionFunctionArgs,
  LoaderFunctionArgs,
  MetaFunction,
} from "react-router";
import { data, useFetcher } from "react-router";
import { z } from "zod";
import Header from "~/components/layout/header";
import type { HeaderData } from "~/components/layout/header/types";
import { List } from "~/components/list";
import { ListContentWrapper } from "~/components/list/content-wrapper";
import { Filters } from "~/components/list/filters";
import { Badge } from "~/components/shared/badge";
import { Button } from "~/components/shared/button";
import { DateS } from "~/components/shared/date";
import { EmptyTableValue } from "~/components/shared/empty-table-value";
import { Td, Th } from "~/components/table";
import { useDisabled } from "~/hooks/use-disabled";
import {
  ensureMspAdminAccessToClient,
  getTenantsForMsp,
  provisionClientOrg,
  requireMspOrg,
} from "~/modules/msp/service.server";
import { setSelectedOrganizationIdCookie } from "~/modules/organization/context.server";
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

    await requireMspOrg(organizationId);

    const searchParams = getCurrentSearchParams(request);
    const { page, perPageParam, search } = getParamsValues(searchParams);
    const cookie = await updateCookieWithPerPage(request, perPageParam);
    const { perPage } = cookie;

    const { tenants, totalTenants } = await getTenantsForMsp({
      mspOrgId: organizationId,
      page,
      perPage,
      search: search ?? undefined,
    });

    const totalPages = Math.ceil(totalTenants / perPage);

    const header: HeaderData = {
      title: "Managed Tenants",
    };

    const modelName = {
      singular: "tenant",
      plural: "tenants",
    };

    return data(
      payload({
        header,
        items: tenants,
        search: search ?? undefined,
        page,
        totalItems: totalTenants,
        totalPages,
        perPage,
        modelName,
        searchFieldTooltip: {
          title: "Search tenants",
          text: "Search by client organization name.",
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

export async function action({ context, request }: ActionFunctionArgs) {
  const authSession = context.getSession();
  const { userId } = authSession;

  try {
    const { organizationId } = await requirePermission({
      userId,
      request,
      entity: PermissionEntity.integration,
      action: PermissionAction.read,
    });

    await requireMspOrg(organizationId);

    const formData = await request.formData();
    const intent = formData.get("intent");

    if (intent === "provision") {
      const { clientName } = parseData(
        formData,
        z.object({ clientName: z.string().min(1, "Client name is required") })
      );

      const result = await provisionClientOrg({
        mspOrgId: organizationId,
        clientName,
        userId,
      });

      sendNotification({
        title: "Client provisioned",
        message: `${result.name} has been created successfully.`,
        icon: { name: "success", variant: "success" },
        senderId: userId,
      });

      return payload({ success: true, ...result });
    }

    if (intent === "navigate") {
      const { clientOrgId } = parseData(
        formData,
        z.object({ clientOrgId: z.string() })
      );

      await ensureMspAdminAccessToClient({
        mspOrgId: organizationId,
        clientOrgId,
        userId,
      });

      // Set the cookie to switch to the client org
      const orgCookie = await setSelectedOrganizationIdCookie(clientOrgId);

      return data(payload({ success: true, redirectTo: "/assets" }), {
        headers: [setCookie(orgCookie)],
      });
    }

    return payload({ success: false });
  } catch (cause) {
    const reason = makeShelfError(cause, { userId });
    return data(error(reason), { status: reason.status });
  }
}

export const meta: MetaFunction<typeof loader> = ({ data }) => [
  { title: data ? appendToMetaTitle(data.header.title) : "" },
];

export default function TenantsPage() {
  return (
    <>
      <Header>
        <ProvisionClientButton />
      </Header>
      <ListContentWrapper>
        <Filters />
        <List
          ItemComponent={TenantListItemComponent}
          headerChildren={
            <>
              <Th>Devices</Th>
              <Th>Status</Th>
              <Th>Errors (24h)</Th>
              <Th>Last Sync</Th>
              <Th>Actions</Th>
            </>
          }
        />
      </ListContentWrapper>
    </>
  );
}

function ProvisionClientButton() {
  const fetcher = useFetcher();
  const disabled = useDisabled(fetcher);

  function handleProvision() {
    const clientName = window.prompt("Enter client organization name:");
    if (!clientName) return;

    void fetcher.submit(
      { intent: "provision", clientName },
      { method: "POST" }
    );
  }

  return (
    <Button type="button" onClick={handleProvision} disabled={disabled}>
      {disabled ? "Creating..." : "Add Client"}
    </Button>
  );
}

function syncStatusColor(status: string): {
  color: string;
  textColor: string;
} {
  switch (status) {
    case "connected":
      return { color: "#E6F4EA", textColor: "#1E7D32" };
    case "error":
      return { color: "#FDECEA", textColor: "#C62828" };
    case "disconnected":
    default:
      return { color: "#F5F5F5", textColor: "#616161" };
  }
}

type TenantItem = {
  id: string;
  childOrgId: string;
  childOrgName: string;
  deviceCount: number;
  lastSync: string | Date | null;
  syncStatus: "connected" | "disconnected" | "error";
  syncErrors: number;
};

const TenantListItemComponent = ({ item }: { item: TenantItem }) => {
  const fetcher = useFetcher();

  function handleNavigate() {
    void fetcher.submit(
      { intent: "navigate", clientOrgId: item.childOrgId },
      { method: "POST" }
    );
  }

  // Redirect after successful navigation
  if (fetcher.data && "redirectTo" in fetcher.data) {
    window.location.href = fetcher.data.redirectTo as string;
  }

  return (
    <>
      <Td className="w-full p-0 md:p-0">
        <div className="flex justify-between gap-3 p-4 md:justify-normal md:px-6">
          <button
            type="button"
            onClick={handleNavigate}
            className="text-left font-medium text-gray-900 hover:text-primary-700 hover:underline"
          >
            {item.childOrgName}
          </button>
        </div>
      </Td>

      <Td className="text-right">{item.deviceCount}</Td>

      <Td>
        <Badge
          color={syncStatusColor(item.syncStatus).color}
          textColor={syncStatusColor(item.syncStatus).textColor}
        >
          {item.syncStatus}
        </Badge>
      </Td>

      <Td className="text-right">
        {item.syncErrors > 0 ? (
          <span className="font-medium text-error-600">{item.syncErrors}</span>
        ) : (
          <span className="text-gray-500">0</span>
        )}
      </Td>

      <Td>
        {item.lastSync ? (
          <DateS
            date={item.lastSync}
            options={{ dateStyle: "short", timeStyle: "short" }}
          />
        ) : (
          <EmptyTableValue />
        )}
      </Td>

      <Td>
        <Button
          type="button"
          variant="secondary"
          size="xs"
          onClick={handleNavigate}
        >
          Enter
        </Button>
      </Td>
    </>
  );
};
