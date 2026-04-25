/**
 * Minimal subset of the ConnectWise PSA Company resource used by Shelf's
 * org sync. The full schema is much larger (see ConnectWise API docs); we
 * only model what Stage 4 needs.
 */
export type ConnectWiseCompany = {
  id: number;
  identifier: string;
  name: string;
  status?: {
    id: number;
    name: string;
  };
  addressLine1?: string;
  addressLine2?: string;
  city?: string;
  state?: string;
  zip?: string;
  country?: {
    id: number;
    name: string;
  };
  phoneNumber?: string;
  website?: string;
  deletedFlag?: boolean;
};

export type ConnectWiseListParams = {
  page?: number;
  pageSize?: number;
  /** Optional ConnectWise conditions string, e.g. `status/name="Active"`. */
  conditions?: string;
};
