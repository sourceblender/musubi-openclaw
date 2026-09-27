import type { RetryPolicy } from "./retry.js";

export type HttpMethod = "GET" | "POST" | "PATCH" | "DELETE";

/**
 * Subset of the global `fetch` shape the client depends on. Allows tests
 * to inject a deterministic mock without pulling in nock/msw.
 */
export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export type ClientOptions = {
  readonly baseUrl: string;
  readonly token: string;

  /** Default per-request timeout in ms. Overridable per call. */
  readonly requestTimeoutMs?: number;

  /** Custom fetch implementation. Defaults to `globalThis.fetch`. */
  readonly fetch?: FetchLike;

  /** Override for the retry policy. Merged with `DEFAULT_RETRY_POLICY`. */
  readonly retry?: Partial<RetryPolicy>;

  /** Generate a fresh `X-Request-Id` per call. Defaults to `crypto.randomUUID`. */
  readonly generateRequestId?: () => string;

  /** Generate a fresh `Idempotency-Key` for POST writes. Defaults to `crypto.randomUUID`. */
  readonly generateIdempotencyKey?: () => string;

  /** Sleep injection so tests can skip real waits. */
  readonly sleep?: (ms: number) => Promise<void>;

  /** RNG for jitter; injectable for deterministic tests. */
  readonly random?: () => number;
};

export type RequestOptions = {
  /** JSON-serializable body. Object → stringified; primitives → stringified. */
  readonly body?: unknown;

  /**
   * Pre-serialized JSON body, sent byte-for-byte as `application/json`.
   * For writes whose idempotency receipt binds the exact request bytes
   * (see delivery/receipts.ts): the caller freezes the bytes once and
   * replays them. Mutually exclusive with `body`.
   */
  readonly rawBody?: string;

  /**
   * Opt this POST into Musubi's durable completed-response receipt
   * (`Idempotency-Receipt: durable`). Requires an idempotency key. Only
   * single-object episodic and curated capture are eligible server-side.
   */
  readonly durableReceipt?: boolean;

  /**
   * Send exactly once: no in-request retry on network/timeout/5xx. Required
   * for a durable capture, whose ambiguous failure must be resolved through
   * receipt lookup, never by re-sending (canonical-api: typed 503 holds the
   * lease fail-closed; `absent` is not permission to re-POST).
   */
  readonly noRetry?: boolean;

  /** Query parameters appended to the URL. Coerced via `String(value)`. */
  readonly query?: Readonly<Record<string, string | number | boolean | undefined>>;

  /**
   * Override the auto-generated `Idempotency-Key`. Useful when the caller
   * already has a stable client-side id (e.g. capturing an OpenClaw turn
   * row by its existing id).
   */
  readonly idempotencyKey?: string;

  /** External abort signal chained with the per-request timeout. */
  readonly signal?: AbortSignal;

  /** Override the client's default `requestTimeoutMs` for this call. */
  readonly timeoutMs?: number;

  /** Override the client's default bearer token for this call. */
  readonly token?: string;
};
