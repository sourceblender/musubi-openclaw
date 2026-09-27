import { createHash } from "node:crypto";
import type { MusubiConfig } from "../config.js";
import type { MusubiClient } from "../musubi/client.js";
import { assertObjectId } from "../musubi/client.js";
import { AbortedError, MusubiError, RateLimitError } from "../musubi/errors.js";
import { type PresenceContext, resolvePresence } from "../presence/resolver.js";
import type { DeliveryOutbox, DeliveryRow, OutboxHealth } from "./outbox.js";
import { lookupCaptureReceipt } from "./receipts.js";

export const RECEIPT_TAG_PREFIX = "openclaw:idem-";
const RECALL_STATES = ["provisional", "matured", "promoted"] as const;

type DeliveryLogger = {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  debug?(message: string): void;
};

type RetrieveResponse = {
  mode?: string;
  limit?: number;
  warnings?: unknown;
  results?: Array<{ object_id?: unknown }>;
};

type ReadbackResponse = {
  object_id?: unknown;
  id?: unknown;
  namespace?: unknown;
  content?: unknown;
  tags?: unknown;
};

type CaptureResponse = {
  object_id?: unknown;
  dedup?: unknown;
};

export class DeliveryWorker {
  readonly #client: MusubiClient;
  readonly #config: MusubiConfig;
  readonly #outbox: DeliveryOutbox;
  readonly #logger: DeliveryLogger;
  #timer: ReturnType<typeof setInterval> | undefined;
  #draining = false;
  #stopped = true;
  #pruneTicks = 0;
  #abortController = new AbortController();

  constructor(options: {
    client: MusubiClient;
    config: MusubiConfig;
    outbox: DeliveryOutbox;
    logger: DeliveryLogger;
  }) {
    this.#client = options.client;
    this.#config = options.config;
    this.#outbox = options.outbox;
    this.#logger = options.logger;
  }

  start(): void {
    if (!this.#stopped) return;
    this.#stopped = false;
    this.#abortController = new AbortController();
    const recovered = this.#outbox.recoverOrphans();
    if (recovered > 0) {
      this.#logger.warn(`musubi: recovered ${recovered} orphaned outbox lease(s)`);
    }
    void this.drainOnce();
    this.#timer = setInterval(() => void this.drainOnce(), 1000);
  }

  async stop(timeoutMs = 3000): Promise<void> {
    this.#stopped = true;
    this.#abortController.abort();
    if (this.#timer) {
      clearInterval(this.#timer);
      this.#timer = undefined;
    }
    const deadline = Date.now() + timeoutMs;
    while (this.#draining && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  kick(): void {
    if (!this.#stopped) void this.drainOnce();
  }

  health(): OutboxHealth {
    return this.#outbox.health();
  }

  async awaitTerminal(rowId: number, timeoutMs = 1500): Promise<DeliveryRow | undefined> {
    // Same exponential backoff as DeliveryController.awaitTerminal; see
    // that comment for the rationale. Capped at 100ms so the upper end
    // stays under one animation frame.
    let intervalMs = 30;
    const deadline = Date.now() + timeoutMs;
    this.kick();
    while (Date.now() < deadline) {
      const row = this.#outbox.row(rowId);
      if (!row || row.state === "verified" || row.state === "dead") return row;
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
      intervalMs = Math.min(intervalMs * 2, 100);
    }
    return this.#outbox.row(rowId);
  }

  async drainOnce(): Promise<void> {
    if (this.#draining || this.#stopped) return;
    this.#draining = true;
    try {
      for (const row of this.#outbox.claimBatch()) {
        if (this.#stopped) break;
        await this.#deliver(row);
      }
      this.#pruneTicks += 1;
      if (this.#pruneTicks >= 300) {
        this.#pruneTicks = 0;
        this.#outbox.prune();
      }
    } catch (error) {
      this.#logger.error(`musubi: outbox worker failed — ${errorMessage(error)}`);
    } finally {
      this.#draining = false;
    }
  }

  async #deliver(row: DeliveryRow): Promise<void> {
    try {
      if (row.object_id) {
        await this.#verify(row, row.object_id, storedDedupEvidence(row));
        return;
      }

      const presence = resolvePresence(this.#config, {
        agentId: row.agent_id ?? undefined,
        strict: row.agent_id !== null,
      });
      // The exact bytes of this capture, frozen before the FIRST send and
      // replayed on every retry. Musubi's receipt binds their digest.
      // A row that already has attempts but reaches here with no frozen body
      // was enqueued before this upgrade: any earlier POST it made was legacy.
      const preUpgradeAttempt = row.request_body === null && row.attempts > 0;
      const requestBody =
        row.request_body ?? this.#outbox.freezeRequestBody(row.id, captureRequestBody(row));
      // Receipt-first delivery, mirroring musubi-harness `flush_once`: ask the
      // server's durable receipt ledger BEFORE every send.
      const receipt = await lookupCaptureReceipt(this.#client, {
        namespace: row.namespace,
        idempotencyKey: row.idem_key,
        body: requestBody,
        token: presence.token,
        signal: this.#abortController.signal,
      });
      if (receipt.status === "found") {
        this.#outbox.markAccepted(row.id, receipt.objectId);
        await this.#verify(row, receipt.objectId, undefined);
        return;
      }
      if (receipt.status === "in_flight") {
        throw new TransientDeliveryError("receipt lookup: an earlier attempt is still in flight");
      }
      if (receipt.status === "conflict") {
        // Same Idempotency-Key, different request bytes. Resending cannot
        // succeed and would never be a replay; this row needs an operator.
        this.#deadLetter(
          row,
          "receipt lookup: idempotency key already used with a different request (conflict)",
        );
        return;
      }
      if (row.post_attempt === "durable") {
        // A durable POST may have reached the server and its outcome is
        // unknown. Only `found` (above) resolves it. `absent` is not
        // permission to re-POST (canonical-api; orphan reconciliation, musubi
        // #558, is not landed), and neither is `unsupported`: a receipt route
        // that later answers 404/405 (server rollback, routing outage) must
        // not turn a possibly-committed durable write into a legacy re-POST.
        // Hold the row and keep asking; never send twice.
        throw new TransientDeliveryError(
          `receipt ${receipt.status} after a durable POST attempt; holding (fail-closed, no re-POST)`,
        );
      }
      // Rows whose earlier attempt predates the durable path (a legacy POST,
      // or a pre-upgrade row with attempts but no marker) have no durable
      // receipt to find. Keep their existing recovery: the receipt-tag search.
      const legacyAttempt =
        row.post_attempt === "legacy" || (row.post_attempt === null && preUpgradeAttempt);
      if (receipt.status === "unsupported" || legacyAttempt) {
        const existing = legacyAttempt ? await this.#findByReceipt(row, presence.token) : undefined;
        if (existing) {
          this.#outbox.markAccepted(row.id, existing);
          await this.#verify(row, existing, undefined);
          return;
        }
      }
      const durable = receipt.status !== "unsupported";
      // Written BEFORE the request leaves: after this line a crash, abort, or
      // lost response leaves an ambiguous POST, and the next attempt must know.
      this.#outbox.markPostAttempted(row.id, durable ? "durable" : "legacy");
      const response = await this.#client.post<CaptureResponse>("/v1/episodic", {
        rawBody: requestBody,
        idempotencyKey: row.idem_key,
        durableReceipt: durable,
        // One send per attempt. An ambiguous failure is resolved by the next
        // attempt's receipt lookup, never by an in-request retry.
        noRetry: durable,
        token: presence.token,
        signal: this.#abortController.signal,
      });
      // Server-shape guard: the typed envelope is `T` via a cast in the
      // client; a server drift would otherwise make object_id silently
      // undefined and the row would dead-letter with a misleading
      // message. Asserting here keeps the failure mode self-describing.
      let objectId: string;
      try {
        objectId = assertObjectId(response, "POST /v1/episodic").object_id;
      } catch (error) {
        this.#deadLetter(row, `write returned an invalid envelope: ${errorMessage(error)}`);
        return;
      }
      const dedupMerge = captureDedupEvidence(response);
      this.#outbox.markAccepted(row.id, objectId, dedupMerge);
      await this.#verify(row, objectId, dedupMerge);
    } catch (error) {
      if (error instanceof AbortedError) {
        // Shutdown, not failure. Release the lease without charging the row a
        // failure, so restarting does not walk it toward `degraded`.
        this.#outbox.markDeferred(row.id);
        return;
      }
      const prefix =
        row.attempts > 0 && !row.object_id ? "delivery/receipt lookup failed" : "delivery failed";
      const retryable = isRetryable(error);
      // Include `row=${row.id}` in the persisted `last_error` so an
      // operator reading `/musubi-status` can correlate the failure
      // message back to the row id without cross-referencing timestamps.
      const detail = `row=${row.id} ${prefix}: ${errorMessage(error)}`;
      if (retryable) {
        this.#outbox.markFailed(row.id, detail, true, Date.now(), retryAfterMs(error));
      } else {
        this.#deadLetter(row, detail);
      }
    }
  }

  /**
   * Terminal failure for one row, always paired with one operator log line.
   * Every dead-letter goes through here, so none is silent, and the line
   * names the agent: without it a dead capture can only be attributed by
   * inference (2026-09-27: a dropped Codex capture could not be traced to a
   * seat). The line carries ids only, never content.
   */
  #deadLetter(row: DeliveryRow, detail: string): void {
    this.#outbox.markFailed(row.id, detail, false);
    this.#logger.error(
      `musubi: row ${row.id} dead-lettered (agent=${row.agent_id ?? "default"}, idempotency=${row.idem_key}): ${detail}`,
    );
  }

  async #findByReceipt(row: DeliveryRow, token: string): Promise<string | undefined> {
    const response = await this.#client.post<RetrieveResponse>("/v1/retrieve", {
      body: {
        namespace: row.namespace,
        mode: "recent",
        limit: 50,
        tags: [`${RECEIPT_TAG_PREFIX}${row.idem_key}`],
        state_filter: [...RECALL_STATES],
      },
      token,
      signal: this.#abortController.signal,
    });
    // `limit` is deliberately NOT compared: a server that clamps or omits the
    // echo is not degraded, but treating it as such turned every retry of an
    // already-attempted row into a permanent stall.
    if (
      response?.mode !== "recent" ||
      !Array.isArray(response.results) ||
      !Array.isArray(response.warnings) ||
      response.warnings.length > 0
    ) {
      throw new TransientDeliveryError("receipt lookup returned an invalid or degraded envelope");
    }
    const first = response.results[0];
    if (!first) return undefined;
    if (typeof first.object_id !== "string" || first.object_id.length === 0) {
      throw new TransientDeliveryError("receipt lookup returned a row without object_id");
    }
    return first.object_id;
  }

  async #verify(
    row: DeliveryRow,
    objectId: string,
    dedupMerge: boolean | undefined,
  ): Promise<void> {
    let presence: PresenceContext;
    try {
      presence = resolvePresence(this.#config, {
        agentId: row.agent_id ?? undefined,
        strict: row.agent_id !== null,
      });
      const got = await this.#client.getWithQuery<ReadbackResponse>(
        `/v1/episodic/${encodeURIComponent(objectId)}`,
        { namespace: row.namespace },
        { token: presence.token, signal: this.#abortController.signal },
      );
      const gotId = got.object_id ?? got.id;
      const gotSha = sha256(typeof got.content === "string" ? got.content : "");
      const mismatches: string[] = [];
      if (gotId !== objectId) mismatches.push("object_id");
      if (got.namespace !== row.namespace) mismatches.push("namespace");
      if (gotSha !== row.content_sha256) mismatches.push("content_sha256");
      if (mismatches.length > 0) {
        // A content-only mismatch is the signature of a server-side
        // dedup-merge, not a corrupted delivery: the episodic plane
        // merges factually-compatible near-duplicates (cosine + a
        // casefolded/whitespace-normalized compare) into the EXISTING
        // row under a longer-wins content policy, unions the tags, and
        // returns the existing object. The merged row therefore carries
        // OUR receipt tag while its content legitimately differs from
        // what we submitted. Byte-exact hashing can never accept that.
        // Prefer the write response's direct dedup evidence; only older
        // servers that omit the field fall back to the unioned receipt tag.
        const contentOnlyMismatch = mismatches.length === 1 && mismatches[0] === "content_sha256";
        const verifiedByResponse = dedupMerge === true && contentOnlyMismatch;
        const verifiedByFallback =
          dedupMerge === undefined && this.#isDedupMerge(row, mismatches, got);
        if (verifiedByResponse || verifiedByFallback) {
          this.#outbox.markVerified(row.id, objectId);
          this.#logger.info(
            `musubi: verified ${row.namespace}/${objectId} via server dedup-merge ` +
              `(canonical content differs from submission; evidence=${
                verifiedByResponse ? "capture_response" : "receipt_tag_fallback"
              })`,
          );
          return;
        }
        this.#deadLetter(row, `readback identity mismatch: ${mismatches.join(", ")}`);
        return;
      }
      this.#outbox.markVerified(row.id, objectId);
      this.#logger.debug?.(`musubi: verified ${row.namespace}/${objectId}`);
    } catch (error) {
      if (error instanceof AbortedError) {
        this.#outbox.markDeferred(row.id);
        return;
      }
      const grace404 = error instanceof MusubiError && error.status === 404 && row.attempts < 5;
      const detail = `readback failed: ${errorMessage(error)}`;
      if (grace404 || isRetryable(error)) {
        this.#outbox.markFailed(row.id, detail, true, Date.now(), retryAfterMs(error));
      } else {
        this.#deadLetter(row, detail);
      }
    }
  }

  /**
   * True iff a readback mismatch is explained by a server dedup-merge:
   * object_id and namespace both verified, ONLY the content hash
   * differs, and the readback row's tags include this delivery's
   * receipt tag (proof the server unioned our write into that row).
   */
  #isDedupMerge(row: DeliveryRow, mismatches: readonly string[], got: ReadbackResponse): boolean {
    if (mismatches.length !== 1 || mismatches[0] !== "content_sha256") return false;
    if (!Array.isArray(got.tags)) return false;
    const receiptTag = `${RECEIPT_TAG_PREFIX}${row.idem_key}`;
    return got.tags.some((tag) => tag === receiptTag);
  }
}

function captureDedupEvidence(response: CaptureResponse | undefined): boolean | undefined {
  if (!response || !Object.hasOwn(response, "dedup")) return undefined;
  if (response.dedup === null) return false;
  if (
    typeof response.dedup === "object" &&
    !Array.isArray(response.dedup) &&
    Object.values(response.dedup).every((value) => typeof value === "string")
  ) {
    return true;
  }
  return undefined;
}

function storedDedupEvidence(row: DeliveryRow): boolean | undefined {
  if (row.write_dedup_merge === 1) return true;
  if (row.write_dedup_merge === 0) return false;
  return undefined;
}

/**
 * A non-HTTP delivery failure that is still worth retrying — today, a receipt
 * lookup whose envelope came back degraded.
 *
 * It exists so that everything else which is NOT a `MusubiError` can safely
 * dead-letter. Previously any such error (a corrupt `tags_json` row, a logic
 * bug, a degraded envelope) was classified retryable, so it spun forever:
 * never delivered, never dead-lettered, and pinning the provider `degraded`
 * through `oldestPendingAgeMs` with no operator-visible terminal state.
 */
/**
 * Serialise a capture row exactly as every release before the byte freeze
 * did (same key order), so rows enqueued before the upgrade keep the digest
 * their first attempt already produced.
 */
export function captureRequestBody(row: DeliveryRow): string {
  return JSON.stringify({
    namespace: row.namespace,
    content: row.content ?? "",
    importance: row.importance,
    tags: [...parseTags(row.tags_json), `${RECEIPT_TAG_PREFIX}${row.idem_key}`],
  });
}

export class TransientDeliveryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TransientDeliveryError";
  }
}

function isRetryable(error: unknown): boolean {
  if (error instanceof TransientDeliveryError) return true;
  if (!(error instanceof MusubiError)) return false;
  return (
    error.code === "network" ||
    error.code === "timeout" ||
    // Shutdown cancellation: the row must survive to the next process.
    error.code === "aborted" ||
    error.code === "server" ||
    error.code === "rate-limit"
  );
}

/**
 * A 429 the client declined to sleep on in-band hands its `Retry-After` to
 * the outbox, which waits it out durably instead of blocking the drain loop.
 */
function retryAfterMs(error: unknown): number | undefined {
  return error instanceof RateLimitError ? error.retryAfterMs : undefined;
}

function parseTags(value: string): string[] {
  const parsed: unknown = JSON.parse(value);
  if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === "string")) {
    throw new Error("outbox tags_json is not a string array");
  }
  return parsed;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
