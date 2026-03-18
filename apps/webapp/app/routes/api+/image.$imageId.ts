import { data, type LoaderFunctionArgs } from "react-router";
import { z } from "zod";
import { sbDb } from "~/database/supabase.server";
import { ShelfError, makeShelfError } from "~/utils/error";
import { error, getParams } from "~/utils/http.server";

export async function loader({ context, params }: LoaderFunctionArgs) {
  const authSession = context.getSession();
  const { userId } = authSession;
  const { imageId } = getParams(params, z.object({ imageId: z.string() }), {
    additionalData: { userId },
  });

  try {
    const { data: image, error: imageError } = await sbDb
      .from("Image")
      .select("ownerOrgId, contentType, blob, userId")
      .eq("id", imageId)
      .single();

    if (imageError) {
      throw new ShelfError({
        cause: imageError,
        title: "Image not found",
        message:
          "The image you are trying to access does not exist or you do not have permission to access it.",
        additionalData: { userId, imageId },
        status: 404,
        label: "Image",
      });
    }

    const { data: userOrganizations } = await sbDb
      .from("UserOrganization")
      .select("organizationId")
      .eq("userId", authSession.userId);

    const orgIds = (userOrganizations || []).map((uo) => uo.organizationId);

    if (!orgIds.includes(image.ownerOrgId)) {
      throw new ShelfError({
        cause: null,
        message: "Unauthorized. This resource doesn't belong to you.",
        additionalData: {
          userId,
          imageId,
          orgIds,
          ownerOrgId: image.ownerOrgId,
        },
        status: 403,
        label: "Image",
      });
    }

    return new Response(new Uint8Array(image.blob as unknown as ArrayBuffer), {
      headers: {
        "Content-Type": image.contentType,
        "Cache-Control": "max-age=31536000",
      },
    });
  } catch (cause) {
    const reason = makeShelfError(cause, { userId });
    return data(error(reason), { status: reason.status });
  }
}
