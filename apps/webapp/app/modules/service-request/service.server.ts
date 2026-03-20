import type {
  ServiceRequestPriority,
  ServiceRequestStatus,
} from "@prisma/client";
import type { Prisma } from "@prisma/client";
import { db } from "~/database/db.server";
import type { ErrorLabel } from "~/utils/error";
import { ShelfError } from "~/utils/error";

const label: ErrorLabel = "Integration";

// ─── Create ─────────────────────────────────────────────────────────

export async function createServiceRequest({
  organizationId,
  assetId,
  requestedById,
  title,
  description,
  priority = "MEDIUM",
  assignedToId,
}: {
  organizationId: string;
  assetId: string;
  requestedById: string;
  title: string;
  description?: string;
  priority?: ServiceRequestPriority;
  assignedToId?: string;
}) {
  try {
    const serviceRequest = await db.serviceRequest.create({
      data: {
        organizationId,
        assetId,
        requestedById,
        title,
        description,
        priority,
        assignedToId: assignedToId || null,
      },
    });

    return serviceRequest;
  } catch (cause) {
    throw new ShelfError({
      cause,
      message: "Failed to create service request",
      label,
    });
  }
}

// ─── Read ───────────────────────────────────────────────────────────

export async function getServiceRequestsForAsset({
  assetId,
  organizationId,
}: {
  assetId: string;
  organizationId: string;
}) {
  return db.serviceRequest.findMany({
    where: { assetId, organizationId },
    orderBy: { createdAt: "desc" },
    include: {
      requestedBy: {
        select: {
          firstName: true,
          lastName: true,
          email: true,
          profilePicture: true,
        },
      },
      assignedTo: {
        select: { id: true, name: true },
      },
    },
  });
}

export async function getServiceRequestsForOrganization({
  organizationId,
  page = 1,
  perPage = 20,
  status,
  search,
}: {
  organizationId: string;
  page?: number;
  perPage?: number;
  status?: string | null;
  search?: string;
}) {
  const where: Prisma.ServiceRequestWhereInput = {
    organizationId,
    ...(status && status !== "ALL"
      ? { status: status as ServiceRequestStatus }
      : {}),
    ...(search
      ? {
          OR: [
            { title: { contains: search, mode: "insensitive" as const } },
            {
              asset: {
                title: { contains: search, mode: "insensitive" as const },
              },
            },
          ],
        }
      : {}),
  };

  const [serviceRequests, totalServiceRequests] = await Promise.all([
    db.serviceRequest.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * perPage,
      take: perPage,
      include: {
        asset: { select: { id: true, title: true } },
        requestedBy: {
          select: {
            firstName: true,
            lastName: true,
            email: true,
            profilePicture: true,
          },
        },
        assignedTo: {
          select: { id: true, name: true },
        },
      },
    }),
    db.serviceRequest.count({ where }),
  ]);

  return { serviceRequests, totalServiceRequests };
}

export async function getServiceRequest({
  id,
  organizationId,
}: {
  id: string;
  organizationId: string;
}) {
  const sr = await db.serviceRequest.findFirst({
    where: { id, organizationId },
    include: {
      asset: { select: { id: true, title: true } },
      requestedBy: {
        select: {
          firstName: true,
          lastName: true,
          email: true,
          profilePicture: true,
        },
      },
      assignedTo: {
        select: { id: true, name: true },
      },
    },
  });

  if (!sr) {
    throw new ShelfError({
      cause: null,
      message: "Service request not found",
      label,
      status: 404,
    });
  }

  return sr;
}

// ─── Update ─────────────────────────────────────────────────────────

export async function updateServiceRequestStatus({
  id,
  status,
  resolutionNotes,
}: {
  id: string;
  status: ServiceRequestStatus;
  resolutionNotes?: string;
}) {
  try {
    return await db.serviceRequest.update({
      where: { id },
      data: {
        status,
        ...(resolutionNotes ? { resolutionNotes } : {}),
        ...(status === "RESOLVED" || status === "CLOSED"
          ? { resolvedAt: new Date() }
          : {}),
      },
    });
  } catch (cause) {
    throw new ShelfError({
      cause,
      message: "Failed to update service request",
      label,
    });
  }
}

export async function assignServiceRequest({
  id,
  assignedToId,
}: {
  id: string;
  assignedToId: string | null;
}) {
  try {
    return await db.serviceRequest.update({
      where: { id },
      data: {
        assignedToId,
        ...(assignedToId ? { status: "IN_PROGRESS" } : {}),
      },
    });
  } catch (cause) {
    throw new ShelfError({
      cause,
      message: "Failed to assign service request",
      label,
    });
  }
}

/**
 * Link an external ticket (CW, PSA) to a service request.
 */
export async function linkExternalTicket({
  id,
  externalTicketId,
  externalTicketUrl,
}: {
  id: string;
  externalTicketId: string;
  externalTicketUrl?: string;
}) {
  try {
    return await db.serviceRequest.update({
      where: { id },
      data: { externalTicketId, externalTicketUrl },
    });
  } catch (cause) {
    throw new ShelfError({
      cause,
      message: "Failed to link external ticket",
      label,
    });
  }
}

// ─── T0 Integration ─────────────────────────────────────────────────

/**
 * Submit a service request to AssetMesh T0 API for CW ticket creation.
 * Called after creating the Shelf.nu service request.
 */
export async function submitToT0({
  serviceRequestId,
  organizationId,
  t0ApiUrl,
  t0ApiKey,
}: {
  serviceRequestId: string;
  organizationId: string;
  t0ApiUrl: string;
  t0ApiKey: string;
}) {
  const sr = await getServiceRequest({
    id: serviceRequestId,
    organizationId,
  });

  try {
    const response = await fetch(`${t0ApiUrl}/api/service-requests`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${t0ApiKey}`,
      },
      body: JSON.stringify({
        shelfServiceRequestId: sr.id,
        assetTitle: sr.asset.title,
        title: sr.title,
        description: sr.description,
        priority: sr.priority,
        requestedBy: sr.requestedBy.email,
        organizationId,
      }),
    });

    if (!response.ok) {
      throw new Error(
        `T0 API returned ${response.status}: ${await response.text()}`
      );
    }

    const result = (await response.json()) as {
      ticketId?: string;
      ticketUrl?: string;
    };

    // Link the external ticket back to our service request
    if (result.ticketId) {
      await linkExternalTicket({
        id: sr.id,
        externalTicketId: result.ticketId,
        externalTicketUrl: result.ticketUrl,
      });
    }

    return result;
  } catch (cause) {
    throw new ShelfError({
      cause,
      message: "Failed to submit service request to AssetMesh",
      label,
    });
  }
}
