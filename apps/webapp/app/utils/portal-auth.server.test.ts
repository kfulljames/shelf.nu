// @vitest-environment node

import { describe, expect, it } from "vitest";
import { ShelfError } from "~/utils/error";
import {
  assertNotReadonly,
  getPortalLaunchUrl,
  hasPermission,
  inGroup,
  isCrossTenantRole,
  isMspRole,
  mapPortalRoleToShelfRole,
} from "./portal-auth.server";

describe("mapPortalRoleToShelfRole", () => {
  it("returns OWNER when permissions include the wildcard", () => {
    expect(mapPortalRoleToShelfRole("msp_user", ["*"], [])).toBe("OWNER");
  });

  it("permission-based overrides take priority over groups and role", () => {
    expect(
      mapPortalRoleToShelfRole("msp_user", ["shelf:admin"], ["read_only"])
    ).toBe("ADMIN");
    expect(
      mapPortalRoleToShelfRole("client_user", ["shelf:self_service"], ["admin"])
    ).toBe("SELF_SERVICE");
    expect(
      mapPortalRoleToShelfRole("msp_admin", ["shelf:base"], ["super_admin"])
    ).toBe("BASE");
  });

  it("falls back to standard group slugs when no permission override matches", () => {
    expect(mapPortalRoleToShelfRole("msp_user", [], ["super_admin"])).toBe(
      "OWNER"
    );
    expect(mapPortalRoleToShelfRole("msp_user", [], ["admin"])).toBe("ADMIN");
    expect(mapPortalRoleToShelfRole("msp_user", [], ["read_only"])).toBe(
      "BASE"
    );
  });

  it("defaults to portal-role mapping when no permission or group match", () => {
    expect(mapPortalRoleToShelfRole("superadmin", [], [])).toBe("OWNER");
    expect(mapPortalRoleToShelfRole("superadmin_readonly", [], [])).toBe(
      "OWNER"
    );
    expect(mapPortalRoleToShelfRole("msp_admin", [], [])).toBe("ADMIN");
    expect(mapPortalRoleToShelfRole("client_admin", [], [])).toBe("ADMIN");
    expect(mapPortalRoleToShelfRole("msp_user", [], [])).toBe("BASE");
    expect(mapPortalRoleToShelfRole("client_user", [], [])).toBe("BASE");
  });

  it("returns BASE for unknown portal roles", () => {
    expect(mapPortalRoleToShelfRole("unknown_role", [], [])).toBe("BASE");
    expect(mapPortalRoleToShelfRole("", [], [])).toBe("BASE");
  });

  it("treats groups as optional and defaults them to empty", () => {
    expect(mapPortalRoleToShelfRole("msp_admin", [])).toBe("ADMIN");
  });
});

describe("hasPermission", () => {
  it("grants any permission when the session carries the wildcard", () => {
    expect(hasPermission({ permissions: ["*"] }, "anything")).toBe(true);
    expect(hasPermission({ permissions: ["*", "read"] }, "billing:write")).toBe(
      true
    );
  });

  it("grants when the required permission is present", () => {
    expect(hasPermission({ permissions: ["read", "write"] }, "write")).toBe(
      true
    );
  });

  it("denies when the required permission is absent", () => {
    expect(hasPermission({ permissions: ["read"] }, "write")).toBe(false);
    expect(hasPermission({ permissions: [] }, "read")).toBe(false);
  });
});

describe("inGroup", () => {
  it("returns true when the session belongs to the group", () => {
    expect(inGroup({ groups: ["admin", "billing"] }, "billing")).toBe(true);
  });

  it("returns false when the session is not in the group", () => {
    expect(inGroup({ groups: ["read_only"] }, "admin")).toBe(false);
    expect(inGroup({ groups: [] }, "admin")).toBe(false);
  });
});

describe("assertNotReadonly", () => {
  it("is a no-op when isReadonly is false", () => {
    expect(() =>
      assertNotReadonly({ isReadonly: false, permissions: ["read"] })
    ).not.toThrow();
  });

  it("throws a 403 ShelfError when isReadonly is true", () => {
    try {
      assertNotReadonly({ isReadonly: true, permissions: ["*"] });
      expect.fail("expected assertNotReadonly to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ShelfError);
      const shelfErr = err as ShelfError;
      expect(shelfErr.status).toBe(403);
      expect(shelfErr.message).toContain("read-only");
    }
  });
});

describe("isCrossTenantRole", () => {
  it("identifies superadmin roles that can see all tenants", () => {
    expect(isCrossTenantRole("superadmin")).toBe(true);
    expect(isCrossTenantRole("superadmin_readonly")).toBe(true);
  });

  it("returns false for tenant-bound roles", () => {
    expect(isCrossTenantRole("msp_admin")).toBe(false);
    expect(isCrossTenantRole("client_user")).toBe(false);
    expect(isCrossTenantRole("")).toBe(false);
  });
});

describe("isMspRole", () => {
  it("identifies MSP-side roles", () => {
    expect(isMspRole("msp_admin")).toBe(true);
    expect(isMspRole("msp_user")).toBe(true);
  });

  it("returns false for client and superadmin roles", () => {
    expect(isMspRole("client_admin")).toBe(false);
    expect(isMspRole("client_user")).toBe(false);
    expect(isMspRole("superadmin")).toBe(false);
  });
});

describe("getPortalLaunchUrl", () => {
  it("builds the launch URL against the configured portal", () => {
    // PORTAL_URL is set to https://portal.test in test/setup-test-env.ts.
    expect(getPortalLaunchUrl()).toBe(
      "https://portal.test/api/auth/launch?module=shelf"
    );
  });
});
