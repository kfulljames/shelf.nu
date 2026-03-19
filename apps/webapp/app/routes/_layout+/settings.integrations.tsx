import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { data, Link, Outlet, useLoaderData } from "react-router";
import { ErrorContent } from "~/components/errors";
import HorizontalTabs from "~/components/layout/horizontal-tabs";
import { db } from "~/database/db.server";
import { appendToMetaTitle } from "~/utils/append-to-meta-title";
import { makeShelfError } from "~/utils/error";
import { payload, error } from "~/utils/http.server";
import {
  PermissionAction,
  PermissionEntity,
} from "~/utils/permissions/permission.data";
import { requirePermission } from "~/utils/roles.server";

export const handle = {
  breadcrumb: () => <Link to="/settings/integrations">Integrations</Link>,
};

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

    // Check if org is MSP to show tenant-related tabs
    const org = await db.organization.findUnique({
      where: { id: organizationId },
      select: { orgTier: true },
    });

    const isMsp = org?.orgTier === "MSP";

    const header = {
      title: "Integrations",
      subHeading: "Manage integration sources and sync activity.",
    };

    return payload({ header, isMsp });
  } catch (cause) {
    const reason = makeShelfError(cause, { userId });
    throw data(error(reason), { status: reason.status });
  }
}

export const meta: MetaFunction<typeof loader> = ({ data }) => [
  { title: data ? appendToMetaTitle(data.header.title) : "" },
];

export const shouldRevalidate = () => false;

export default function IntegrationsLayout() {
  const { isMsp } = useLoaderData<typeof loader>();

  const items = [
    { to: "sync-logs", content: "Sync Logs" },
    ...(isMsp
      ? [
          { to: "tenants", content: "Tenants" },
          { to: "dashboard", content: "Dashboard" },
        ]
      : []),
  ];

  return (
    <>
      <HorizontalTabs items={items} />
      <Outlet />
    </>
  );
}

export const ErrorBoundary = () => <ErrorContent />;
