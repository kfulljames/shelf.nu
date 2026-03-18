import type { LoaderFunctionArgs } from "react-router";
import { data, Link, useLoaderData } from "react-router";
import { z } from "zod";
import { DateS } from "~/components/shared/date";
import { Table, Td, Tr } from "~/components/table";
import { SSOUserBadge } from "~/components/user/sso-user-badge";
import { sbDb } from "~/database/supabase.server";
import { appendToMetaTitle } from "~/utils/append-to-meta-title";
import { makeShelfError, ShelfError } from "~/utils/error";
import { payload, error, getParams } from "~/utils/http.server";
import { requireAdmin } from "~/utils/roles.server";

export const meta = () => [
  { title: appendToMetaTitle("Organization members") },
];

export const loader = async ({ context, params }: LoaderFunctionArgs) => {
  const authSession = context.getSession();
  const { userId } = authSession;
  const { organizationId } = getParams(
    params,
    z.object({ organizationId: z.string() }),
    { additionalData: { userId } }
  );

  try {
    await requireAdmin(userId);

    // Query UserOrganization joined with User to get members of this org
    const { data: userOrgRows, error: uoErr } = await sbDb
      .from("UserOrganization")
      .select(
        "roles, user:User!inner(id, firstName, lastName, email, sso, createdAt)"
      )
      .eq("organizationId", organizationId);

    if (uoErr) {
      throw new ShelfError({
        cause: uoErr,
        message: "Failed to load organization members",
        additionalData: { userId, organizationId },
        label: "Admin dashboard",
      });
    }

    const members = (userOrgRows ?? []).map((row) => {
      const u = row.user as unknown as {
        id: string;
        firstName: string | null;
        lastName: string | null;
        email: string;
        sso: boolean;
        createdAt: string;
      };
      return {
        ...u,
        userOrganizations: [{ roles: row.roles }],
      };
    });

    return payload({ members });
  } catch (cause) {
    const reason = makeShelfError(cause, { userId, organizationId });
    throw data(error(reason), { status: reason.status });
  }
};

export default function AdminOrgQrCodes() {
  const { members } = useLoaderData<typeof loader>();
  return (
    <>
      <div className="flex justify-between">
        <div className="flex items-end gap-3">
          <h2>Members</h2>
          <span>{members.length} total members</span>
        </div>
      </div>
      <Table className="mt-5">
        <thead className="bg-gray-100">
          <tr className="font-semibold">
            <th className="border-b p-4 text-left text-gray-600 md:px-6">ID</th>
            <th className="border-b p-4 text-left text-gray-600 md:px-6">
              Name
            </th>
            <th className="border-b p-4 text-left text-gray-600 md:px-6">
              Email
            </th>
            <th className="border-b p-4 text-left text-gray-600 md:px-6">
              Role
            </th>
            <th className="border-b p-4 text-left text-gray-600 md:px-6">
              Created At
            </th>
          </tr>
        </thead>

        <tbody>
          {members.map((member) => (
            <Tr key={member.id}>
              <Td>
                <Link
                  to={`/admin-dashboard/${member.id}`}
                  className="underline hover:text-gray-500"
                >
                  {member.id}
                </Link>
              </Td>
              <Td>
                {member.firstName} {member.lastName}
              </Td>
              <Td>
                <span>
                  {member.email}{" "}
                  <SSOUserBadge sso={member.sso} userId={member.id} />
                </span>
              </Td>
              <Td>{member.userOrganizations[0].roles.join(" ,")}</Td>
              <Td>
                <DateS
                  date={member.createdAt}
                  options={{
                    timeStyle: "short",
                    dateStyle: "short",
                  }}
                />
              </Td>
            </Tr>
          ))}
        </tbody>
      </Table>
    </>
  );
}
