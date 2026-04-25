// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const orgFindMany = vi.fn();
const userOrgFindMany = vi.fn();
const userOrgCreate = vi.fn();
const userOrgUpdate = vi.fn();

// why: pure unit test against Prisma; no live database needed.
vi.mock("~/database/db.server", () => ({
  db: {
    organization: { findMany: orgFindMany },
    userOrganization: {
      findMany: userOrgFindMany,
      create: userOrgCreate,
      update: userOrgUpdate,
    },
  },
}));

// why: silence info/error logs and verify failures route through the
// logger rather than throwing.
vi.mock("~/utils/logger", () => ({
  Logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

const { ensureMspClientOrgMemberships, isMspSidePortalRole } = await import(
  "./msp-org-memberships.server"
);

beforeEach(() => {
  orgFindMany.mockReset();
  userOrgFindMany.mockReset();
  userOrgCreate.mockReset();
  userOrgUpdate.mockReset();
  userOrgCreate.mockResolvedValue({});
  userOrgUpdate.mockResolvedValue({});
});

afterEach(() => {
  // sanity
});

describe("isMspSidePortalRole", () => {
  it("returns true for MSP-side role and group slugs", () => {
    expect(isMspSidePortalRole("msp_admin")).toBe(true);
    expect(isMspSidePortalRole("msp_user")).toBe(true);
    expect(isMspSidePortalRole("super_admin")).toBe(true);
    expect(isMspSidePortalRole("admin")).toBe(true);
    expect(isMspSidePortalRole("technician")).toBe(true);
  });

  it("returns false for client-side roles and unknown values", () => {
    expect(isMspSidePortalRole("client_admin")).toBe(false);
    expect(isMspSidePortalRole("client_user")).toBe(false);
    expect(isMspSidePortalRole("read_only")).toBe(false);
    expect(isMspSidePortalRole("billing")).toBe(false);
    expect(isMspSidePortalRole("")).toBe(false);
  });
});

describe("ensureMspClientOrgMemberships", () => {
  it("is a no-op when the role is client-side", async () => {
    const result = await ensureMspClientOrgMemberships({
      userId: "u-1",
      mspTenantId: "msp-1",
      portalRole: "client_user",
      shelfRole: "BASE",
    });
    expect(result).toEqual({
      managedOrgs: 0,
      added: 0,
      existing: 0,
      updated: 0,
    });
    expect(orgFindMany).not.toHaveBeenCalled();
  });

  it("is a no-op when mspTenantId is null (cross-tenant superadmins)", async () => {
    const result = await ensureMspClientOrgMemberships({
      userId: "u-1",
      mspTenantId: null,
      portalRole: "msp_admin",
      shelfRole: "ADMIN",
    });
    expect(result.managedOrgs).toBe(0);
    expect(orgFindMany).not.toHaveBeenCalled();
  });

  it("creates UserOrganization rows for every unlinked client org", async () => {
    orgFindMany.mockResolvedValueOnce([
      { id: "org-a" },
      { id: "org-b" },
      { id: "org-c" },
    ]);
    userOrgFindMany.mockResolvedValueOnce([]);

    const result = await ensureMspClientOrgMemberships({
      userId: "tech-1",
      mspTenantId: "msp-1",
      portalRole: "technician",
      shelfRole: "BASE",
    });

    expect(result).toEqual({
      managedOrgs: 3,
      added: 3,
      existing: 0,
      updated: 0,
    });
    expect(userOrgCreate).toHaveBeenCalledTimes(3);
    expect(userOrgCreate).toHaveBeenCalledWith({
      data: { userId: "tech-1", organizationId: "org-a", roles: ["BASE"] },
    });
  });

  it("counts already-linked orgs as existing without writing", async () => {
    orgFindMany.mockResolvedValueOnce([{ id: "org-a" }, { id: "org-b" }]);
    userOrgFindMany.mockResolvedValueOnce([
      { id: "uo-a", organizationId: "org-a", roles: ["ADMIN"] },
      { id: "uo-b", organizationId: "org-b", roles: ["ADMIN"] },
    ]);

    const result = await ensureMspClientOrgMemberships({
      userId: "msp-admin-1",
      mspTenantId: "msp-1",
      portalRole: "msp_admin",
      shelfRole: "ADMIN",
    });

    expect(result).toMatchObject({ added: 0, existing: 2, updated: 0 });
    expect(userOrgCreate).not.toHaveBeenCalled();
    expect(userOrgUpdate).not.toHaveBeenCalled();
  });

  it("widens the role array on an existing membership without dropping prior roles", async () => {
    orgFindMany.mockResolvedValueOnce([{ id: "org-a" }]);
    userOrgFindMany.mockResolvedValueOnce([
      { id: "uo-a", organizationId: "org-a", roles: ["BASE"] },
    ]);

    const result = await ensureMspClientOrgMemberships({
      userId: "u-1",
      mspTenantId: "msp-1",
      portalRole: "msp_admin",
      shelfRole: "ADMIN",
    });

    expect(result).toMatchObject({ added: 0, existing: 0, updated: 1 });
    expect(userOrgUpdate).toHaveBeenCalledWith({
      where: { id: "uo-a" },
      data: { roles: { set: ["BASE", "ADMIN"] } },
    });
  });

  it("isolates per-org write failures and counts them via the logger", async () => {
    orgFindMany.mockResolvedValueOnce([{ id: "org-a" }, { id: "org-b" }]);
    userOrgFindMany.mockResolvedValueOnce([]);
    userOrgCreate
      .mockRejectedValueOnce(new Error("conflict"))
      .mockResolvedValueOnce({});

    const result = await ensureMspClientOrgMemberships({
      userId: "u-1",
      mspTenantId: "msp-1",
      portalRole: "msp_admin",
      shelfRole: "ADMIN",
    });

    expect(userOrgCreate).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({
      managedOrgs: 2,
      added: 1, // second create succeeded
      existing: 0,
      updated: 0,
    });
  });

  it("returns zero managed orgs when the MSP has no client tenants synced yet", async () => {
    orgFindMany.mockResolvedValueOnce([]);
    userOrgFindMany.mockResolvedValueOnce([]);

    const result = await ensureMspClientOrgMemberships({
      userId: "u-1",
      mspTenantId: "msp-1",
      portalRole: "msp_admin",
      shelfRole: "ADMIN",
    });

    expect(result.managedOrgs).toBe(0);
    expect(userOrgFindMany).not.toHaveBeenCalled();
  });
});
