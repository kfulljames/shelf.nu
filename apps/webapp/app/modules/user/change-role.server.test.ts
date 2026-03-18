// @vitest-environment node
import { OrganizationRoles } from "@prisma/client";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { createSupabaseMock } from "@mocks/supabase";
import { ShelfError } from "~/utils/error";
import { changeUserRole } from "./service.server";

const sbMock = createSupabaseMock();
// why: testing role change validation logic without actual Supabase HTTP calls
vi.mock("~/database/supabase.server", () => ({
  get sbDb() {
    return sbMock.client;
  },
}));

beforeEach(() => {
  sbMock.reset();
});

const ORG_ID = "org-1";
const USER_ID = "user-1";

function mockUserOrg(roles: OrganizationRoles[]) {
  sbMock.setData({
    id: "uo-1",
    userId: USER_ID,
    organizationId: ORG_ID,
    roles,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
}

function mockFindThenUpdate(
  roles: OrganizationRoles[],
  newRole: OrganizationRoles
) {
  // First call: maybeSingle (find)
  sbMock.enqueueData({
    id: "uo-1",
    userId: USER_ID,
    organizationId: ORG_ID,
    roles,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  // Second call: single (update)
  sbMock.enqueueData({
    id: "uo-1",
    userId: USER_ID,
    organizationId: ORG_ID,
    roles: [newRole],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
}

describe("changeUserRole", () => {
  it("rejects assigning OWNER role", async () => {
    await expect(
      changeUserRole({
        userId: USER_ID,
        organizationId: ORG_ID,
        newRole: OrganizationRoles.OWNER,
        callerRole: OrganizationRoles.OWNER,
      })
    ).rejects.toThrow(ShelfError);

    await expect(
      changeUserRole({
        userId: USER_ID,
        organizationId: ORG_ID,
        newRole: OrganizationRoles.OWNER,
        callerRole: OrganizationRoles.OWNER,
      })
    ).rejects.toThrow(/Cannot assign Owner role/);
  });

  it("rejects when user is not a member", async () => {
    // maybeSingle returns null
    sbMock.setData(null);

    await expect(
      changeUserRole({
        userId: USER_ID,
        organizationId: ORG_ID,
        newRole: OrganizationRoles.BASE,
        callerRole: OrganizationRoles.OWNER,
      })
    ).rejects.toThrow(/not a member/);
  });

  it("rejects changing the OWNER's role", async () => {
    mockUserOrg([OrganizationRoles.OWNER]);

    await expect(
      changeUserRole({
        userId: USER_ID,
        organizationId: ORG_ID,
        newRole: OrganizationRoles.ADMIN,
        callerRole: OrganizationRoles.OWNER,
      })
    ).rejects.toThrow(/Cannot change the Owner's role/);
  });

  it("rejects ADMIN caller promoting to ADMIN", async () => {
    mockUserOrg([OrganizationRoles.BASE]);

    await expect(
      changeUserRole({
        userId: USER_ID,
        organizationId: ORG_ID,
        newRole: OrganizationRoles.ADMIN,
        callerRole: OrganizationRoles.ADMIN,
      })
    ).rejects.toThrow(/Only the workspace owner can promote/);
  });

  it("rejects ADMIN caller demoting another ADMIN", async () => {
    mockUserOrg([OrganizationRoles.ADMIN]);

    await expect(
      changeUserRole({
        userId: USER_ID,
        organizationId: ORG_ID,
        newRole: OrganizationRoles.BASE,
        callerRole: OrganizationRoles.ADMIN,
      })
    ).rejects.toThrow(/Only the workspace owner can change an Administrator/);
  });

  it("allows OWNER to promote BASE to ADMIN", async () => {
    mockFindThenUpdate([OrganizationRoles.BASE], OrganizationRoles.ADMIN);

    const result = await changeUserRole({
      userId: USER_ID,
      organizationId: ORG_ID,
      newRole: OrganizationRoles.ADMIN,
      callerRole: OrganizationRoles.OWNER,
    });

    expect(result.previousRole).toBe(OrganizationRoles.BASE);
    expect(sbMock.calls.from).toHaveBeenCalledWith("UserOrganization");
    expect(sbMock.calls.update).toHaveBeenCalledWith({
      roles: [OrganizationRoles.ADMIN],
    });
    expect(sbMock.calls.eq).toHaveBeenCalledWith("userId", USER_ID);
    expect(sbMock.calls.eq).toHaveBeenCalledWith("organizationId", ORG_ID);
  });

  it("allows OWNER to demote ADMIN to BASE", async () => {
    mockFindThenUpdate([OrganizationRoles.ADMIN], OrganizationRoles.BASE);

    const result = await changeUserRole({
      userId: USER_ID,
      organizationId: ORG_ID,
      newRole: OrganizationRoles.BASE,
      callerRole: OrganizationRoles.OWNER,
    });

    expect(result.previousRole).toBe(OrganizationRoles.ADMIN);
  });

  it("allows ADMIN to change BASE to SELF_SERVICE", async () => {
    mockFindThenUpdate(
      [OrganizationRoles.BASE],
      OrganizationRoles.SELF_SERVICE
    );

    const result = await changeUserRole({
      userId: USER_ID,
      organizationId: ORG_ID,
      newRole: OrganizationRoles.SELF_SERVICE,
      callerRole: OrganizationRoles.ADMIN,
    });

    expect(result.previousRole).toBe(OrganizationRoles.BASE);
  });
});
