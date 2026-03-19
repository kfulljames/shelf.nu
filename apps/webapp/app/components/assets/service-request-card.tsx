import { useFetcher } from "react-router";
import { useZorm } from "react-zorm";
import { z } from "zod";
import { Badge } from "~/components/shared/badge";
import { Button } from "~/components/shared/button";
import { Card } from "~/components/shared/card";
import { DateS } from "~/components/shared/date";
import { useDisabled } from "~/hooks/use-disabled";

const createServiceRequestSchema = z.object({
  title: z.string().min(1, "Title is required"),
  description: z.string().optional(),
  priority: z.enum(["LOW", "MEDIUM", "HIGH", "URGENT"]).default("MEDIUM"),
});

type ServiceRequestSummary = {
  id: string;
  title: string;
  status: string;
  priority: string;
  externalTicketId: string | null;
  externalTicketUrl: string | null;
  createdAt: string | Date;
};

function statusColor(status: string): { color: string; textColor: string } {
  switch (status) {
    case "OPEN":
      return { color: "#E3F2FD", textColor: "#1565C0" };
    case "IN_PROGRESS":
      return { color: "#FFF8E1", textColor: "#F57F17" };
    case "RESOLVED":
      return { color: "#E6F4EA", textColor: "#1E7D32" };
    case "CLOSED":
      return { color: "#F5F5F5", textColor: "#616161" };
    default:
      return { color: "#FFF8E1", textColor: "#F57F17" };
  }
}

export function ServiceRequestCard({
  assetId,
  serviceRequests,
}: {
  assetId: string;
  serviceRequests: ServiceRequestSummary[];
}) {
  const fetcher = useFetcher();
  const zo = useZorm("serviceRequest", createServiceRequestSchema);
  const disabled = useDisabled(fetcher);
  const openRequests = serviceRequests.filter(
    (sr) => sr.status !== "CLOSED" && sr.status !== "RESOLVED"
  );

  return (
    <Card className="my-3">
      <div className="flex items-center justify-between border-b px-4 py-3">
        <h3 className="text-text-sm font-semibold">Service Requests</h3>
        {openRequests.length > 0 && (
          <span className="text-xs text-gray-500">
            {openRequests.length} open
          </span>
        )}
      </div>

      {serviceRequests.length > 0 ? (
        <div className="max-h-[200px] overflow-y-auto">
          {serviceRequests.slice(0, 5).map((sr) => (
            <div
              key={sr.id}
              className="flex items-center justify-between border-b px-4 py-2 last:border-b-0"
            >
              <div className="flex-1">
                <p className="text-sm font-medium text-gray-900">{sr.title}</p>
                <p className="text-xs text-gray-500">
                  <DateS date={sr.createdAt} options={{ dateStyle: "short" }} />
                  {sr.externalTicketId && (
                    <>
                      {" "}
                      &middot;{" "}
                      {sr.externalTicketUrl ? (
                        <a
                          href={sr.externalTicketUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-primary-600 hover:underline"
                        >
                          Ticket #{sr.externalTicketId}
                        </a>
                      ) : (
                        <span>Ticket #{sr.externalTicketId}</span>
                      )}
                    </>
                  )}
                </p>
              </div>
              <Badge
                color={statusColor(sr.status).color}
                textColor={statusColor(sr.status).textColor}
              >
                {sr.status.replace(/_/g, " ")}
              </Badge>
            </div>
          ))}
        </div>
      ) : (
        <p className="px-4 py-3 text-sm text-gray-500">
          No service requests for this asset.
        </p>
      )}

      <div className="border-t px-4 py-3">
        <fetcher.Form
          method="POST"
          ref={zo.ref}
          action={`/api/assets/${assetId}/service-request`}
        >
          <div className="space-y-2">
            <input
              type="text"
              name={zo.fields.title()}
              placeholder="Request title..."
              className="w-full rounded border border-gray-300 px-3 py-1.5 text-sm focus:border-primary-500 focus:outline-none focus:ring-1 focus:ring-primary-500"
            />
            <div className="flex items-center gap-2">
              <select
                name={zo.fields.priority()}
                className="rounded border border-gray-300 px-2 py-1 text-xs"
                defaultValue="MEDIUM"
              >
                <option value="LOW">Low</option>
                <option value="MEDIUM">Medium</option>
                <option value="HIGH">High</option>
                <option value="URGENT">Urgent</option>
              </select>
              <Button type="submit" size="xs" disabled={disabled}>
                {disabled ? "Submitting..." : "Submit Request"}
              </Button>
            </div>
          </div>
        </fetcher.Form>
      </div>
    </Card>
  );
}
