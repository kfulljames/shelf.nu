import { useSetAtom } from "jotai";
import type {
  ActionFunctionArgs,
  LoaderFunctionArgs,
  MetaFunction,
} from "react-router";
import { data, useNavigation } from "react-router";
import { z } from "zod";
import { addScannedItemAtom } from "~/atoms/qr-scanner";
import Header from "~/components/layout/header";
import type { HeaderData } from "~/components/layout/header/types";
import { CodeScanner } from "~/components/scanner/code-scanner";
import type { OnCodeDetectionSuccessProps } from "~/components/scanner/code-scanner";
import AddAssetsToKitDrawer from "~/components/scanner/drawer/uses/add-assets-to-kit-drawer";
import { sbDb } from "~/database/supabase.server";
import { useScannerCameraId } from "~/hooks/use-scanner-camera-id";
import { useViewportHeight } from "~/hooks/use-viewport-height";
import { appendToMetaTitle } from "~/utils/append-to-meta-title";

import { makeShelfError, ShelfError } from "~/utils/error";
import { isFormProcessing } from "~/utils/form";
import { payload, error, getParams } from "~/utils/http.server";
import {
  PermissionAction,
  PermissionEntity,
} from "~/utils/permissions/permission.data";
import { requirePermission } from "~/utils/roles.server";
import { tw } from "~/utils/tw";
import { action as manageAssetsAction } from "./kits.$kitId.assets.manage-assets";

export type LoaderData = typeof loader;

export async function loader({ context, request, params }: LoaderFunctionArgs) {
  const authSession = context.getSession();
  const { userId } = authSession;

  const { kitId } = getParams(params, z.object({ kitId: z.string() }), {
    additionalData: { userId },
  });

  try {
    const { organizationId } = await requirePermission({
      userId,
      request,
      entity: PermissionEntity.kit,
      action: PermissionAction.update,
    });

    const { data: kit, error: kitError } = await sbDb
      .from("Kit")
      .select("id, name, qrCodes:Qr(id), assets:Asset(id)")
      .eq("id", kitId)
      .eq("organizationId", organizationId)
      .single();

    if (kitError || !kit) {
      throw new ShelfError({
        cause: kitError,
        title: "Kit not found!",
        message:
          "The kit you are trying to access does not exists or you do not have permission to asset it.",
        status: 404,
        label: "Kit",
      });
    }

    const typedKit = kit as unknown as {
      id: string;
      name: string;
      qrCodes: { id: string }[];
      assets: { id: string }[];
    };

    /** We get the userPrefs cookie so we can see if there is already a default camera */
    const title = `Scan assets for kit | ${typedKit.name}`;
    const header: HeaderData = {
      title,
    };

    return payload({ title, header, kit: typedKit });
  } catch (cause) {
    const reason = makeShelfError(cause, { userId, kitId });
    throw data(error(reason), { status: reason.status });
  }
}
export const meta: MetaFunction<typeof loader> = ({ data }) => [
  { title: data ? appendToMetaTitle(data.title) : "" },
];

export const handle = {
  name: "kit.scan-assets",
};

export async function action(args: ActionFunctionArgs) {
  return manageAssetsAction(args);
}

export default function ScanAssetsForKit() {
  const addItem = useSetAtom(addScannedItemAtom);
  const navigation = useNavigation();
  const isLoading = isFormProcessing(navigation.state);

  const { vh, isMd } = useViewportHeight();
  const height = isMd ? vh - 67 : vh - 100;

  const savedCameraId = useScannerCameraId();

  function handleCodeDetectionSuccess({
    value: qrId,
    error,
    type,
  }: OnCodeDetectionSuccessProps) {
    /** WE send the error to the item. addItem will automatically handle the data based on its value */
    addItem(qrId, error, type);
  }

  return (
    <>
      <Header hidePageDescription />

      <AddAssetsToKitDrawer isLoading={isLoading} />

      <div className="-mx-4 flex flex-col" style={{ height: `${height}px` }}>
        <CodeScanner
          isLoading={isLoading}
          onCodeDetectionSuccess={handleCodeDetectionSuccess}
          backButtonText="Kit"
          allowNonShelfCodes
          paused={false}
          setPaused={() => {}}
          scannerModeClassName={(mode) =>
            tw(mode === "scanner" && "justify-start pt-[100px]")
          }
          savedCameraId={savedCameraId}
        />
      </div>
    </>
  );
}
