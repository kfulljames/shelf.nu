import { OrganizationRoles } from "@prisma/client";

import { matchRequestUrl, rest } from "msw";
import { server } from "@mocks";
import {
  SUPABASE_URL,
  SUPABASE_AUTH_TOKEN_API,
  SUPABASE_AUTH_ADMIN_USER_API,
  authSession,
  authAccount,
} from "@mocks/handlers";
import { createSupabaseMock } from "@mocks/supabase";
import {
  ORGANIZATION_ID,
  USER_EMAIL,
  USER_ID,
  USER_PASSWORD,
} from "@mocks/user";

import {
  createUserAccountForTesting,
  createUserOrAttachOrg,
} from "./service.server";

// @vitest-environment node
// see https://vitest.dev/guide/environment.html#environments-for-specific-files

const sbMock = createSupabaseMock();
// why: testing user account creation logic without actual Supabase HTTP calls
vitest.mock("~/database/supabase.server", () => ({
  get sbDb() {
    return sbMock.client;
  },
}));

// why: ensureAssetIndexModeForRole has its own db dependencies unrelated to user creation
vitest.mock("~/modules/asset-index-settings/service.server", () => ({
  ensureAssetIndexModeForRole: vitest.fn().mockResolvedValue(undefined),
}));

beforeEach(() => {
  sbMock.reset();
});

const username = `test-user-${USER_ID}`;

describe(createUserAccountForTesting.name, () => {
  it("should return null if no auth account created", async () => {
    expect.assertions(3);
    const fetchAuthAdminUserAPI = new Map();
    server.events.on("request:start", (req) => {
      const matchesMethod = req.method === "POST";
      const matchesUrl = matchRequestUrl(
        req.url,
        SUPABASE_AUTH_ADMIN_USER_API,
        SUPABASE_URL
      ).matches;
      if (matchesMethod && matchesUrl) fetchAuthAdminUserAPI.set(req.id, req);
    });
    // https://mswjs.io/docs/api/setup-server/use#one-time-override
    server.use(
      rest.post(
        `${SUPABASE_URL}${SUPABASE_AUTH_ADMIN_USER_API}`,
        async (_req, res, ctx) =>
          res.once(
            ctx.status(400),
            ctx.json({ message: "create-account-error", status: 400 })
          )
      )
    );
    const result = await createUserAccountForTesting(
      USER_EMAIL,
      USER_PASSWORD,
      username
    );
    server.events.removeAllListeners();
    expect(result).toBeNull();
    expect(fetchAuthAdminUserAPI.size).toEqual(1);
    const [request] = fetchAuthAdminUserAPI.values();
    expect(request.body).toEqual({
      email: USER_EMAIL,
      password: USER_PASSWORD,
      email_confirm: true,
    });
  });
  it("should return null and delete auth account if unable to sign in", async () => {
    expect.assertions(5);
    const fetchAuthTokenAPI = new Map();
    const fetchAuthAdminUserAPI = new Map();
    server.events.on("request:start", (req) => {
      const matchesMethod = req.method === "POST";
      const matchesUrl = matchRequestUrl(
        req.url,
        SUPABASE_AUTH_TOKEN_API,
        SUPABASE_URL
      ).matches;
      if (matchesMethod && matchesUrl) fetchAuthTokenAPI.set(req.id, req);
    });
    server.events.on("request:start", (req) => {
      const matchesMethod = req.method === "DELETE";
      const matchesUrl = matchRequestUrl(
        req.url,
        `${SUPABASE_AUTH_ADMIN_USER_API}/*`,
        SUPABASE_URL
      ).matches;
      if (matchesMethod && matchesUrl) fetchAuthAdminUserAPI.set(req.id, req);
    });
    server.use(
      rest.post(
        `${SUPABASE_URL}${SUPABASE_AUTH_TOKEN_API}`,
        async (_req, res, ctx) =>
          res.once(
            ctx.status(400),
            ctx.json({ message: "sign-in-error", status: 400 })
          )
      )
    );
    const result = await createUserAccountForTesting(
      USER_EMAIL,
      USER_PASSWORD,
      username
    );
    server.events.removeAllListeners();
    expect(result).toBeNull();
    expect(fetchAuthTokenAPI.size).toEqual(1);
    const [signInRequest] = fetchAuthTokenAPI.values();
    expect(signInRequest.body).toEqual({
      email: USER_EMAIL,
      password: USER_PASSWORD,
      gotrue_meta_security: {},
    });
    expect(fetchAuthAdminUserAPI.size).toEqual(1);
    // expect call delete auth account with the expected user id
    const [authAdminUserReq] = fetchAuthAdminUserAPI.values();
    expect(authAdminUserReq.url.pathname).toEqual(
      `${SUPABASE_AUTH_ADMIN_USER_API}/${USER_ID}`
    );
  });
  it("should return null and delete auth account if unable to create user in database", async () => {
    expect.assertions(4);
    const fetchAuthTokenAPI = new Map();
    const fetchAuthAdminUserAPI = new Map();
    server.events.on("request:start", (req) => {
      const matchesMethod = req.method === "POST";
      const matchesUrl = matchRequestUrl(
        req.url,
        SUPABASE_AUTH_TOKEN_API,
        SUPABASE_URL
      ).matches;
      if (matchesMethod && matchesUrl) fetchAuthTokenAPI.set(req.id, req);
    });
    server.events.on("request:start", (req) => {
      const matchesMethod = req.method === "DELETE";
      const matchesUrl = matchRequestUrl(
        req.url,
        `${SUPABASE_AUTH_ADMIN_USER_API}/*`,
        SUPABASE_URL
      ).matches;
      if (matchesMethod && matchesUrl) fetchAuthAdminUserAPI.set(req.id, req);
    });

    // createUser calls sbDb multiple times; simulate failure on the Role
    // lookup so the user creation fails
    sbMock.setError({ message: "Role not found", code: "PGRST116" });

    const result = await createUserAccountForTesting(
      USER_EMAIL,
      USER_PASSWORD,
      username
    );
    server.events.removeAllListeners();
    expect(result).toBeNull();
    expect(fetchAuthTokenAPI.size).toEqual(1);
    expect(fetchAuthAdminUserAPI.size).toEqual(1);
    // expect call delete auth account with the expected user id
    const [authAdminUserReq] = fetchAuthAdminUserAPI.values();
    expect(authAdminUserReq.url.pathname).toEqual(
      `${SUPABASE_AUTH_ADMIN_USER_API}/${USER_ID}`
    );
  });
  it("should create an account", async () => {
    expect.assertions(4);
    const fetchAuthAdminUserAPI = new Map();
    const fetchAuthTokenAPI = new Map();
    server.events.on("request:start", (req) => {
      const matchesMethod = req.method === "POST";
      const matchesUrl = matchRequestUrl(
        req.url,
        SUPABASE_AUTH_ADMIN_USER_API,
        SUPABASE_URL
      ).matches;
      if (matchesMethod && matchesUrl) fetchAuthAdminUserAPI.set(req.id, req);
    });
    server.events.on("request:start", (req) => {
      const matchesMethod = req.method === "POST";
      const matchesUrl = matchRequestUrl(
        req.url,
        SUPABASE_AUTH_TOKEN_API,
        SUPABASE_URL
      ).matches;
      if (matchesMethod && matchesUrl) fetchAuthTokenAPI.set(req.id, req);
    });

    // createUser calls sbDb chains multiple times.
    // Enqueue responses in the order the function calls them:
    // 1. Role lookup (.from("Role").select("id").eq("name",...).single())
    sbMock.enqueueData({ id: "role-1" });
    // 2. User insert (.from("User").insert(...).select(...).single())
    sbMock.enqueueData({
      id: USER_ID,
      email: USER_EMAIL,
      username: username,
      firstName: null,
      lastName: null,
      sso: false,
      userOrganizations: [],
    });
    // 3. _RoleToUser join insert
    sbMock.enqueueData({});
    // 4. Organization insert (.from("Organization").insert(...).select("id").single())
    sbMock.enqueueData({ id: "org-id" });
    // 5. Category insert
    sbMock.enqueueData({});
    // 6. TeamMember insert
    sbMock.enqueueData({});
    // 7. AssetIndexSettings insert
    sbMock.enqueueData({});
    // 8. UserOrganization check (maybeSingle - personal org)
    sbMock.enqueueData(null);
    // 9. UserOrganization insert (personal org)
    sbMock.enqueueData({
      userId: USER_ID,
      organizationId: "org-id",
      roles: ["OWNER"],
    });
    // 10. Re-fetch user with full data
    sbMock.enqueueData({
      id: USER_ID,
      email: USER_EMAIL,
      organizations: [{ id: "org-id" }],
    });

    const result = await createUserAccountForTesting(
      USER_EMAIL,
      USER_PASSWORD,
      username
    );

    // we don't want to test the implementation of the function
    result!.expiresAt = -1;
    server.events.removeAllListeners();

    expect(sbMock.calls.from).toHaveBeenCalledWith("User");
    expect(result).toEqual(authSession);
    expect(fetchAuthAdminUserAPI.size).toEqual(1);
    expect(fetchAuthTokenAPI.size).toEqual(1);
  });
});

const newUserMock = {
  id: USER_ID,
  email: USER_EMAIL,
  organizations: [{ id: ORGANIZATION_ID }],
};

/**
 * Tests for the invite acceptance flow in `createUserOrAttachOrg`.
 *
 * Covers the fallback logic that handles the "limbo" state: a user who signed
 * up but never confirmed their email has a Supabase auth account but no Prisma
 * User record. When they later accept a team invite, `createEmailAuthAccount`
 * fails (email exists), so we fall back to `confirmExistingAuthAccount` to
 * confirm the existing auth account and create the Prisma User.
 */
describe(createUserOrAttachOrg.name, () => {
  beforeEach(() => {
    vitest.clearAllMocks();
    sbMock.reset();
  });

  afterEach(() => {
    server.events.removeAllListeners();
  });

  /** Happy path: brand-new user with no prior Supabase account */
  it("creates a new user when no Prisma user and no Supabase account exists", async () => {
    // 1. User lookup (.from("User").select(...).eq("email",...).maybeSingle()) - no user found
    sbMock.enqueueData(null);
    // createUser calls:
    // 2. Role lookup
    sbMock.enqueueData({ id: "role-1" });
    // 3. User insert
    sbMock.enqueueData({
      id: USER_ID,
      email: USER_EMAIL,
      firstName: "Test",
      lastName: null,
      sso: false,
      userOrganizations: [],
    });
    // 4. _RoleToUser join
    sbMock.enqueueData({});
    // 5. Organization insert (personal org)
    sbMock.enqueueData({ id: "personal-org-id" });
    // 6. Category insert
    sbMock.enqueueData({});
    // 7. TeamMember insert
    sbMock.enqueueData({});
    // 8. AssetIndexSettings insert
    sbMock.enqueueData({});
    // 9. UserOrganization check personal (maybeSingle)
    sbMock.enqueueData(null);
    // 10. UserOrganization insert personal
    sbMock.enqueueData({
      userId: USER_ID,
      organizationId: "personal-org-id",
      roles: ["OWNER"],
    });
    // 11. UserOrganization check for invited org (maybeSingle)
    sbMock.enqueueData(null);
    // 12. UserOrganization insert for invited org
    sbMock.enqueueData({
      userId: USER_ID,
      organizationId: ORGANIZATION_ID,
      roles: ["BASE"],
    });
    // 13. Re-fetch user with full data
    sbMock.enqueueData({
      id: USER_ID,
      email: USER_EMAIL,
      organizations: [{ id: ORGANIZATION_ID }],
    });

    const result = await createUserOrAttachOrg({
      email: USER_EMAIL,
      organizationId: ORGANIZATION_ID,
      roles: [OrganizationRoles.BASE],
      password: USER_PASSWORD,
      firstName: "Test",
      createdWithInvite: true,
    });

    expect(result.id).toBe(USER_ID);
    expect(sbMock.calls.from).toHaveBeenCalledWith("User");
    expect(sbMock.calls.insert).toHaveBeenCalled();
  });

  /** The "limbo" bug: unconfirmed Supabase account exists, no Prisma User */
  it("falls back to confirming existing auth account when createEmailAuthAccount fails", async () => {
    // Override: createEmailAuthAccount fails (email already in Supabase)
    server.use(
      rest.post(
        `${SUPABASE_URL}${SUPABASE_AUTH_ADMIN_USER_API}`,
        async (_req, res, ctx) =>
          res.once(
            ctx.status(400),
            ctx.json({ message: "User already registered", status: 400 })
          )
      ),
      // confirmExistingAuthAccount calls updateUserById (PUT)
      rest.put(
        `${SUPABASE_URL}${SUPABASE_AUTH_ADMIN_USER_API}/:id`,
        async (_req, res, ctx) =>
          res.once(ctx.status(200), ctx.json(authAccount))
      )
    );

    // 1. User lookup - no user found
    sbMock.enqueueData(null);
    // 2. confirmExistingAuthAccount calls sbDb.rpc("find_auth_user_by_email")
    sbMock.enqueueData([{ id: USER_ID }]);
    // createUser calls:
    // 3. Role lookup
    sbMock.enqueueData({ id: "role-1" });
    // 4. User insert
    sbMock.enqueueData({
      id: USER_ID,
      email: USER_EMAIL,
      firstName: "Test",
      lastName: null,
      sso: false,
      userOrganizations: [],
    });
    // 5. _RoleToUser join
    sbMock.enqueueData({});
    // 6. Organization insert (personal org)
    sbMock.enqueueData({ id: "personal-org-id" });
    // 7. Category insert
    sbMock.enqueueData({});
    // 8. TeamMember insert
    sbMock.enqueueData({});
    // 9. AssetIndexSettings insert
    sbMock.enqueueData({});
    // 10. UserOrganization check personal (maybeSingle)
    sbMock.enqueueData(null);
    // 11. UserOrganization insert personal
    sbMock.enqueueData({
      userId: USER_ID,
      organizationId: "personal-org-id",
      roles: ["OWNER"],
    });
    // 12. UserOrganization check for invited org
    sbMock.enqueueData(null);
    // 13. UserOrganization insert for invited org
    sbMock.enqueueData({
      userId: USER_ID,
      organizationId: ORGANIZATION_ID,
      roles: ["BASE"],
    });
    // 14. Re-fetch user with full data
    sbMock.enqueueData({
      id: USER_ID,
      email: USER_EMAIL,
      organizations: [{ id: ORGANIZATION_ID }],
    });

    const result = await createUserOrAttachOrg({
      email: USER_EMAIL,
      organizationId: ORGANIZATION_ID,
      roles: [OrganizationRoles.BASE],
      password: USER_PASSWORD,
      firstName: "Test",
      createdWithInvite: true,
    });

    expect(result.id).toBe(USER_ID);
    expect(sbMock.calls.rpc).toHaveBeenCalledWith("find_auth_user_by_email", {
      user_email: USER_EMAIL,
    });
    expect(sbMock.calls.insert).toHaveBeenCalled();
  });

  /** No auth account can be created or found -- user gets a clear error */
  it("throws when both createEmailAuthAccount and confirmExistingAuthAccount fail", async () => {
    // createEmailAuthAccount fails
    server.use(
      rest.post(
        `${SUPABASE_URL}${SUPABASE_AUTH_ADMIN_USER_API}`,
        async (_req, res, ctx) =>
          res.once(
            ctx.status(400),
            ctx.json({ message: "User already registered", status: 400 })
          )
      )
    );

    // 1. User lookup - no user found
    sbMock.enqueueData(null);
    // 2. confirmExistingAuthAccount finds no auth user via rpc
    sbMock.enqueueData([]);

    await expect(
      createUserOrAttachOrg({
        email: USER_EMAIL,
        organizationId: ORGANIZATION_ID,
        roles: [OrganizationRoles.BASE],
        password: USER_PASSWORD,
        firstName: "Test",
        createdWithInvite: true,
      })
    ).rejects.toThrow("We are facing some issue with your account");
  });

  /** Existing user accepting invite for a new org -- no auth changes needed */
  it("attaches org to existing Prisma user without creating a new auth account", async () => {
    const existingUser = {
      id: USER_ID,
      email: USER_EMAIL,
      firstName: "Existing",
      lastName: "User",
      sso: false,
      userOrganizations: [],
    };

    // 1. User lookup - found existing user
    sbMock.enqueueData(existingUser);
    // 2. createUserOrgAssociation: check existing (maybeSingle)
    sbMock.enqueueData(null);
    // 3. createUserOrgAssociation: insert new association
    sbMock.enqueueData({
      userId: USER_ID,
      organizationId: ORGANIZATION_ID,
      roles: ["BASE"],
    });

    const result = await createUserOrAttachOrg({
      email: USER_EMAIL,
      organizationId: ORGANIZATION_ID,
      roles: [OrganizationRoles.BASE],
      password: USER_PASSWORD,
      firstName: "Existing",
      createdWithInvite: true,
    });

    expect(result.id).toBe(USER_ID);
    expect(sbMock.calls.from).toHaveBeenCalledWith("UserOrganization");
    // User insert should NOT have been called with "User" table for insert
    // (the insert calls should be only for UserOrganization)
  });
});
