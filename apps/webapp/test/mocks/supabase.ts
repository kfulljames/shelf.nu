import { vi } from "vitest";

type SupaResponse = { data: unknown; error: unknown; count?: number };

/**
 * Creates a chainable mock that simulates the Supabase PostgREST client.
 *
 * Usage:
 *   const sbMock = createSupabaseMock();
 *   vi.mock("~/database/supabase.server", () => ({
 *     get sbDb() { return sbMock.client; },
 *   }));
 *
 *   // Set a single response (used for all calls):
 *   sbMock.setData({ id: "1" });
 *
 *   // Or queue multiple responses (consumed FIFO):
 *   sbMock.enqueue({ data: { id: "1" }, error: null });
 *   sbMock.enqueue({ data: null, error: { message: "fail" } });
 *   // First call returns { id: "1" }, second returns error
 */
export function createSupabaseMock() {
  let _defaultResponse: SupaResponse = { data: null, error: null };
  const _queue: SupaResponse[] = [];

  function nextResponse(): SupaResponse {
    return _queue.length > 0 ? _queue.shift()! : _defaultResponse;
  }

  // Track calls for assertions
  const calls = {
    from: vi.fn(),
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    upsert: vi.fn(),
    eq: vi.fn(),
    neq: vi.fn(),
    gt: vi.fn(),
    gte: vi.fn(),
    lt: vi.fn(),
    lte: vi.fn(),
    in: vi.fn(),
    is: vi.fn(),
    or: vi.fn(),
    not: vi.fn(),
    contains: vi.fn(),
    filter: vi.fn(),
    match: vi.fn(),
    order: vi.fn(),
    limit: vi.fn(),
    range: vi.fn(),
    single: vi.fn(),
    maybeSingle: vi.fn(),
    rpc: vi.fn(),
    columns: vi.fn(),
    ilike: vi.fn(),
  };

  const buildChain = (): any => {
    const chain: Record<string, any> = {};

    const chainMethods = [
      "select",
      "insert",
      "update",
      "delete",
      "upsert",
      "eq",
      "neq",
      "gt",
      "gte",
      "lt",
      "lte",
      "in",
      "is",
      "or",
      "not",
      "contains",
      "filter",
      "match",
      "order",
      "limit",
      "range",
      "columns",
      "ilike",
    ];

    for (const method of chainMethods) {
      chain[method] = (...args: unknown[]) => {
        (calls as any)[method](...args);
        return chain;
      };
    }

    // Terminal methods consume from queue
    chain.single = (...args: unknown[]) => {
      calls.single(...args);
      return Promise.resolve(nextResponse());
    };

    chain.maybeSingle = (...args: unknown[]) => {
      calls.maybeSingle(...args);
      return Promise.resolve(nextResponse());
    };

    // Thenable — awaiting the chain without .single() also resolves
    chain.then = (resolve: (v: any) => any, reject?: (e: any) => any) =>
      Promise.resolve(nextResponse()).then(resolve, reject);

    return chain;
  };

  const chain = buildChain();

  const client = {
    from: (...args: unknown[]) => {
      calls.from(...args);
      return chain;
    },
    rpc: (...args: unknown[]) => {
      calls.rpc(...args);
      return Promise.resolve(nextResponse());
    },
  };

  return {
    /** The mock client to use as `sbDb` */
    client,

    /** All tracked method calls for assertions */
    calls,

    /** Set the default response (used when queue is empty) */
    setResponse(response: SupaResponse) {
      _defaultResponse = response;
    },

    /** Set a success data response */
    setData(data: unknown) {
      _defaultResponse = { data, error: null };
    },

    /** Set an error response */
    setError(error: unknown) {
      _defaultResponse = { data: null, error };
    },

    /** Enqueue a response (consumed FIFO, then falls back to default) */
    enqueue(response: SupaResponse) {
      _queue.push(response);
    },

    /** Enqueue a success data response */
    enqueueData(data: unknown) {
      _queue.push({ data, error: null });
    },

    /** Enqueue an error response */
    enqueueError(error: unknown) {
      _queue.push({ data: null, error });
    },

    /** Reset all tracked calls, queue, and default response */
    reset() {
      _defaultResponse = { data: null, error: null };
      _queue.length = 0;
      for (const fn of Object.values(calls)) {
        if (fn && typeof fn.mockClear === "function") {
          fn.mockClear();
        }
      }
    },
  };
}
