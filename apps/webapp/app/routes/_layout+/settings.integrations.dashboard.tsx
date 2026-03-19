import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { data, useLoaderData } from "react-router";
import Header from "~/components/layout/header";
import type { HeaderData } from "~/components/layout/header/types";
import { Card } from "~/components/shared/card";
import { DateS } from "~/components/shared/date";
import {
  getSyncDashboardStats,
  requireMspOrg,
} from "~/modules/msp/service.server";
import { appendToMetaTitle } from "~/utils/append-to-meta-title";
import { makeShelfError } from "~/utils/error";
import { payload, error } from "~/utils/http.server";
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

    const stats = await getSyncDashboardStats(organizationId);

    const header: HeaderData = {
      title: "Sync Dashboard",
    };

    return data(payload({ header, stats }));
  } catch (cause) {
    const reason = makeShelfError(cause, { userId });
    throw data(error(reason), { status: reason.status });
  }
}

export const meta: MetaFunction<typeof loader> = ({ data }) => [
  { title: data ? appendToMetaTitle(data.header.title) : "" },
];

export default function SyncDashboardPage() {
  const { stats } = useLoaderData<typeof loader>();

  return (
    <>
      <Header />
      <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <StatCard title="Total Tenants" value={stats.totalTenants} />
        <StatCard title="Total Devices" value={stats.totalDevices} />
        <StatCard
          title="Tenants with Errors"
          value={stats.tenantsWithErrors}
          variant={stats.tenantsWithErrors > 0 ? "error" : "default"}
        />
        <StatCard title="Syncs (24h)" value={stats.syncLogsLast24h} />
        <StatCard
          title="Failed Syncs (24h)"
          value={stats.failedSyncsLast24h}
          variant={stats.failedSyncsLast24h > 0 ? "error" : "default"}
        />
        <div className="rounded-xl border border-gray-200 bg-white p-6">
          <p className="text-sm text-gray-500">Last Sync</p>
          <div className="mt-1 text-lg font-semibold text-gray-900">
            {stats.lastSyncAt ? (
              <DateS
                date={stats.lastSyncAt}
                options={{ dateStyle: "medium", timeStyle: "short" }}
              />
            ) : (
              <span className="text-gray-400">No syncs yet</span>
            )}
          </div>
        </div>
      </div>
    </>
  );
}

function StatCard({
  title,
  value,
  variant = "default",
}: {
  title: string;
  value: number;
  variant?: "default" | "error";
}) {
  return (
    <Card className="p-6">
      <p className="text-sm text-gray-500">{title}</p>
      <p
        className={`mt-1 text-2xl font-semibold ${
          variant === "error" && value > 0 ? "text-error-600" : "text-gray-900"
        }`}
      >
        {value.toLocaleString()}
      </p>
    </Card>
  );
}
