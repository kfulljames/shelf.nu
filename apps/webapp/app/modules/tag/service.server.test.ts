import type { Sb } from "@shelf/database";
import { describe, vitest } from "vitest";
import { USER_ID, ORGANIZATION_ID } from "@factories";
import { createSupabaseMock } from "@mocks/supabase";
import { createTag, updateTag } from "~/modules/tag/service.server";

const sbMock = createSupabaseMock();
// why: testing service logic without actual Supabase HTTP calls
vitest.mock("~/database/supabase.server", () => ({
  get sbDb() {
    return sbMock.client;
  },
}));

describe("tag service", () => {
  beforeEach(() => {
    sbMock.reset();
  });

  describe("create", () => {
    it("should create tag", async () => {
      sbMock.setData({
        id: "tag-1",
        name: "test_tag",
        description: "my test tag",
        color: "#ffffff",
        useFor: ["ASSET"],
        userId: USER_ID,
        organizationId: ORGANIZATION_ID,
      });

      await createTag({
        description: "my test tag",
        organizationId: ORGANIZATION_ID,
        userId: USER_ID,
        name: "test_tag",
        color: "#ffffff",
        useFor: ["ASSET"],
      });

      expectTagToBeCreated({
        name: "test_tag",
        description: "my test tag",
        color: "#ffffff",
        useFor: ["ASSET"],
      });
    });

    it("should trim tag name", async () => {
      sbMock.setData({
        id: "tag-1",
        name: "test_tag",
        description: "my test tag",
        color: "#ffffff",
        useFor: ["ASSET"],
        userId: USER_ID,
        organizationId: ORGANIZATION_ID,
      });

      await createTag({
        description: "my test tag",
        organizationId: ORGANIZATION_ID,
        userId: USER_ID,
        name: " test_tag ",
        color: "#ffffff",
        useFor: ["ASSET"],
      });

      expectTagToBeCreated({
        name: "test_tag",
        description: "my test tag",
        color: "#ffffff",
        useFor: ["ASSET"],
      });
    });
  });

  describe("update", () => {
    it("should update tag", async () => {
      sbMock.setData({
        id: USER_ID,
        name: "test_tag",
        description: "my test tag",
        color: "#ffffff",
        organizationId: ORGANIZATION_ID,
      });

      await updateTag({
        description: "my test tag",
        organizationId: ORGANIZATION_ID,
        id: USER_ID,
        name: "test_tag",
        color: "#ffffff",
      });

      expectTagToBeUpdated({
        name: "test_tag",
        description: "my test tag",
        organizationId: ORGANIZATION_ID,
        id: USER_ID,
        color: "#ffffff",
      });
    });

    it("should trim tag name on update", async () => {
      sbMock.setData({
        id: USER_ID,
        name: "test_tag",
        description: "my test tag",
        color: "#ffffff",
        organizationId: ORGANIZATION_ID,
      });

      await updateTag({
        description: "my test tag",
        organizationId: ORGANIZATION_ID,
        id: USER_ID,
        name: " test_tag ",
        color: "#ffffff",
      });

      expectTagToBeUpdated({
        name: "test_tag",
        description: "my test tag",
        organizationId: ORGANIZATION_ID,
        id: USER_ID,
        color: "#ffffff",
      });
    });

    it("should update tag with useFor", async () => {
      sbMock.setData({
        id: USER_ID,
        name: "test_tag",
        description: "my test tag",
        color: "#ffffff",
        useFor: ["ASSET"],
        organizationId: ORGANIZATION_ID,
      });

      await updateTag({
        description: "my test tag",
        organizationId: ORGANIZATION_ID,
        id: USER_ID,
        name: "test_tag",
        color: "#ffffff",
        useFor: ["ASSET"],
      });

      expectTagToBeUpdated({
        name: "test_tag",
        description: "my test tag",
        organizationId: ORGANIZATION_ID,
        id: USER_ID,
        color: "#ffffff",
        useFor: ["ASSET"],
      });
    });
  });
});

function expectTagToBeCreated({
  name,
  description,
  color,
  useFor,
}: {
  name: string;
  description: string;
  color: string;
  useFor: Sb.TagUseFor[];
}): void {
  expect(sbMock.calls.from).toHaveBeenCalledWith("Tag");
  expect(sbMock.calls.insert).toHaveBeenCalledWith({
    name,
    description,
    color,
    useFor,
    userId: USER_ID,
    organizationId: ORGANIZATION_ID,
  });
  expect(sbMock.calls.select).toHaveBeenCalled();
  expect(sbMock.calls.single).toHaveBeenCalled();
}

function expectTagToBeUpdated({
  name,
  description,
  id,
  organizationId,
  color,
  useFor,
}: {
  name: string;
  description: string;
  id: string;
  organizationId: string;
  color: string;
  useFor?: Sb.TagUseFor[];
}): void {
  expect(sbMock.calls.from).toHaveBeenCalledWith("Tag");

  const expectedUpdateData: Record<string, unknown> = {
    name,
    description,
    color,
  };
  if (useFor !== undefined) {
    expectedUpdateData.useFor = useFor;
  }

  expect(sbMock.calls.update).toHaveBeenCalledWith(expectedUpdateData);
  expect(sbMock.calls.eq).toHaveBeenCalledWith("id", id);
  expect(sbMock.calls.eq).toHaveBeenCalledWith(
    "organizationId",
    organizationId
  );
  expect(sbMock.calls.select).toHaveBeenCalled();
  expect(sbMock.calls.single).toHaveBeenCalled();
}
