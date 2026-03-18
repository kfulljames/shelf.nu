import { OrganizationRoles } from "@prisma/client";
import type { ActionFunctionArgs } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSupabaseMock } from "@mocks/supabase";

import { action } from "~/routes/_layout+/kits.$kitId.assets.assign-custody";
import { requirePermission } from "~/utils/roles.server";
import { getUserByID } from "~/modules/user/service.server";

const sbMock = createSupabaseMock();

const teamMemberServiceMocks = vi.hoisted(() => ({
  getTeamMember: vi.fn(),
}));

// why: testing route handler without actual Supabase HTTP calls
vi.mock("~/database/supabase.server", () => ({
  get sbDb() {
    return sbMock.client;
  },
}));

vi.mock("~/utils/roles.server", () => ({
  requirePermission: vi.fn(),
}));

vi.mock("~/modules/user/service.server", () => ({
  getUserByID: vi.fn(),
}));

vi.mock("~/modules/team-member/service.server", () => ({
  getTeamMember: teamMemberServiceMocks.getTeamMember,
}));

vi.mock("~/modules/note/service.server", () => ({
  createNote: vi.fn(),
  createNotes: vi.fn(),
}));

vi.mock("~/utils/emitter/send-notification.server", () => ({
  sendNotification: vi.fn(),
}));

vi.mock("~/utils/http.server", () => ({
  assertIsPost: vi.fn(),
  parseData: vi.fn().mockImplementation((formData) => {
    const custodian = JSON.parse(formData.get("custodian") || "{}");
    return { custodian };
  }),
  getParams: vi.fn().mockImplementation((params) => ({
    kitId: params.kitId || "kit-123",
  })),
  data: vi.fn((x) => ({ success: true, ...x })),
  error: vi.fn((x) => ({ error: x })),
}));

vi.mock("react-router", async () => {
  const actual = await vi.importActual("react-router");
  const mockResponse = (data: any, init?: { status?: number }) =>
    new Response(JSON.stringify(data), {
      status: init?.status || 200,
      headers: { "Content-Type": "application/json" },
    });
  return {
    ...actual,
    redirect: vi.fn(() => new Response(null, { status: 302 })),
    json: vi.fn(mockResponse),
    data: vi.fn(mockResponse),
  };
});

const requirePermissionMock = vi.mocked(requirePermission);
const getUserByIDMock = vi.mocked(getUserByID);
const mockGetTeamMember = teamMemberServiceMocks.getTeamMember;

function createActionArgs(
  overrides: Partial<ActionFunctionArgs> = {}
): ActionFunctionArgs {
  return {
    context: {
      getSession: () => ({ userId: "user-123" }),
    },
    request: new Request(
      "https://example.com/kits/kit-123/assets/assign-custody",
      {
        method: "POST",
      }
    ),
    params: { kitId: "kit-123" },
    ...overrides,
  } as ActionFunctionArgs;
}

beforeEach(() => {
  vi.clearAllMocks();
  sbMock.reset();
  mockGetTeamMember.mockReset();
  requirePermissionMock.mockReset();

  getUserByIDMock.mockResolvedValue({
    id: "user-123",
    firstName: "Test",
    lastName: "User",
  } as any);
});

describe("kits/$kitId/assets/assign-custody", () => {
  it("prevents assigning custody to team members from different organizations", async () => {
    requirePermissionMock.mockResolvedValue({
      organizationId: "org-1",
      role: OrganizationRoles.ADMIN,
    } as any);

    // Custodian not found due to org filter
    mockGetTeamMember.mockRejectedValue(new Error("Not found"));

    const formData = new FormData();
    formData.set(
      "custodian",
      JSON.stringify({
        id: "foreign-team-member-123",
        name: "Foreign Team Member",
      })
    );

    const request = new Request(
      "https://example.com/kits/kit-123/assets/assign-custody",
      {
        method: "POST",
        body: formData,
      }
    );

    const response = await action(createActionArgs({ request }));

    expect((response as Response).status).toBe(404);

    expect(mockGetTeamMember).toHaveBeenCalledWith({
      id: "foreign-team-member-123",
      organizationId: "org-1",
      select: {
        id: true,
        userId: true,
        name: true,
        user: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
          },
        },
      },
    });

    // sbDb should not have been called for kit update
    expect(sbMock.calls.from).not.toHaveBeenCalled();
  });

  it("allows assigning custody to team members from the same organization", async () => {
    requirePermissionMock.mockResolvedValue({
      organizationId: "org-1",
      role: OrganizationRoles.ADMIN,
    } as any);

    // Valid team member from same org
    mockGetTeamMember.mockResolvedValue({
      id: "team-member-123",
      userId: "user-456",
      name: "Valid Team Member",
      user: {
        id: "user-456",
        firstName: "Valid",
        lastName: "Member",
      },
    });

    // sbDb calls: kit update, kit custody insert, asset select for kit,
    // kit select for name, then per-asset update+custody insert
    sbMock.enqueue({ data: null, error: null }); // Kit update
    sbMock.enqueue({ data: null, error: null }); // KitCustody insert
    sbMock.enqueueData([]); // Asset select (no assets in kit)
    sbMock.enqueueData({ name: "Test Kit" }); // Kit name select

    const formData = new FormData();
    formData.set(
      "custodian",
      JSON.stringify({
        id: "team-member-123",
        name: "Valid Team Member",
      })
    );

    const request = new Request(
      "https://example.com/kits/kit-123/assets/assign-custody",
      {
        method: "POST",
        body: formData,
      }
    );

    const response = await action(createActionArgs({ request }));

    expect((response as Response).status).toBe(302); // Redirect on success

    expect(mockGetTeamMember).toHaveBeenCalledWith({
      id: "team-member-123",
      organizationId: "org-1",
      select: {
        id: true,
        userId: true,
        name: true,
        user: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
          },
        },
      },
    });

    // Verify sbDb was called for Kit and KitCustody
    expect(sbMock.calls.from).toHaveBeenCalledWith("Kit");
    expect(sbMock.calls.from).toHaveBeenCalledWith("KitCustody");
  });

  it("prevents self-service users from assigning custody to other team members", async () => {
    requirePermissionMock.mockResolvedValue({
      organizationId: "org-1",
      role: OrganizationRoles.SELF_SERVICE,
    } as any);

    // Valid team member from same org, but different user
    mockGetTeamMember.mockResolvedValue({
      id: "team-member-456",
      userId: "other-user-456", // Different from current user
      name: "Other Team Member",
      user: {
        id: "other-user-456",
        firstName: "Other",
        lastName: "Member",
      },
    });

    const formData = new FormData();
    formData.set(
      "custodian",
      JSON.stringify({
        id: "team-member-456",
        name: "Other Team Member",
      })
    );

    const request = new Request(
      "https://example.com/kits/kit-123/assets/assign-custody",
      {
        method: "POST",
        body: formData,
      }
    );

    const response = await action(createActionArgs({ request }));

    expect((response as Response).status).toBe(500); // ShelfError defaults to 500

    // sbDb should not have been called for kit update
    expect(sbMock.calls.update).not.toHaveBeenCalled();
  });

  it("allows self-service users to assign custody to themselves", async () => {
    requirePermissionMock.mockResolvedValue({
      organizationId: "org-1",
      role: OrganizationRoles.SELF_SERVICE,
    } as any);

    // Valid team member from same org, same user
    mockGetTeamMember.mockResolvedValue({
      id: "team-member-123",
      userId: "user-123", // Same as current user
      name: "Self User",
      user: {
        id: "user-123",
        firstName: "Self",
        lastName: "User",
      },
    });

    // sbDb calls: kit update, kit custody insert, asset select for kit,
    // kit select for name
    sbMock.enqueue({ data: null, error: null }); // Kit update
    sbMock.enqueue({ data: null, error: null }); // KitCustody insert
    sbMock.enqueueData([]); // Asset select (no assets in kit)
    sbMock.enqueueData({ name: "Test Kit" }); // Kit name select

    const formData = new FormData();
    formData.set(
      "custodian",
      JSON.stringify({
        id: "team-member-123",
        name: "Self User",
      })
    );

    const request = new Request(
      "https://example.com/kits/kit-123/assets/assign-custody",
      {
        method: "POST",
        body: formData,
      }
    );

    const response = await action(createActionArgs({ request }));

    expect((response as Response).status).toBe(302); // Redirect on success

    expect(sbMock.calls.from).toHaveBeenCalledWith("Kit");
  });
});
