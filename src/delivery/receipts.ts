/**
 * Authoritative idempotency-receipt lookup for capture writes.
 *
 * Musubi records a durable receipt for every completed `POST /v1/episodic`,
 * keyed by (caller identity, method, operation, namespace, Idempotency-Key)
 * and bound to a BYTE-EXACT digest of the request: domain-separated SHA-256
 * over the Content-Type and the exact body bytes the server received
 * (`musubi.api.idempotency_dependency.canonical_digest`). A retry therefore
 * asks the receipt table "did this exact write already commit?" instead of
 * searching for a tag, which depends on the search index having caught up.
 *
 * Because the digest binds bytes, the same bytes must be sent on every
 * attempt: the outbox freezes the first attempt's body (`request_body`) and
 * the worker replays it verbatim. Re-serialising per attempt would make a
 * field-order change between plugin versions look like key reuse (409).
 */

import { createHash } from "node:crypto";

import type { MusubiClient } from "../musubi/client.js";
import { MusubiError } from "../musubi/errors.js";

/** Musubi's operation id for episodic capture writes (receipt-eligible). */
export const CAPTURE_OPERATION_ID = "capture_episodic.bucket=capture";
/** The Content-Type the client sends with every JSON body; part of the digest. */
export const CAPTURE_CONTENT_TYPE = "application/json";

const DIGEST_DOMAIN = "musubi-idem-json-v1";

/** Hex SHA-256 matching Musubi's `canonical_digest(body_bytes, content_type)`. */
export function canonicalRequestDigest(
  body: string,
  contentType: string = CAPTURE_CONTENT_TYPE,
): string {
  return createHash("sha256")
    .update(Buffer.from(DIGEST_DOMAIN, "latin1"))
    .update(Buffer.from([0]))
    .update(Buffer.from(contentType, "latin1"))
    .update(Buffer.from([0]))
    .update(Buffer.from(body, "utf8"))
    .digest("hex");
}

export type ReceiptLookup =
  | { readonly status: "found"; readonly objectId: string }
  | { readonly status: "absent" }
  | { readonly status: "in_flight" }
  | { readonly status: "conflict" }
  /** The server predates the receipt API; the caller may fall back. */
  | { readonly status: "unsupported" };

type ReceiptLookupResponse = {
  readonly status?: unknown;
  readonly object_id?: unknown;
};

export class ReceiptLookupError extends Error {
  override readonly name = "ReceiptLookupError";
}

export async function lookupCaptureReceipt(
  client: MusubiClient,
  request: {
    readonly namespace: string;
    readonly idempotencyKey: string;
    readonly body: string;
    readonly token: string;
    readonly signal?: AbortSignal;
  },
): Promise<ReceiptLookup> {
  let response: ReceiptLookupResponse;
  try {
    response = await client.post<ReceiptLookupResponse>("/v1/idempotency/receipts/lookup", {
      body: {
        namespace: request.namespace,
        method: "POST",
        operation_id: CAPTURE_OPERATION_ID,
        idempotency_key: request.idempotencyKey,
        request_digest: canonicalRequestDigest(request.body),
      },
      token: request.token,
      ...(request.signal ? { signal: request.signal } : {}),
    });
  } catch (error) {
    // Only a server without the route may fall back. 404 is also how an
    // unknown ROUTE answers; an unknown RECEIPT answers 200 {status: absent}.
    if (error instanceof MusubiError && (error.status === 404 || error.status === 405)) {
      return { status: "unsupported" };
    }
    throw error;
  }
  switch (response?.status) {
    case "found":
      if (typeof response.object_id !== "string" || response.object_id.length === 0) {
        throw new ReceiptLookupError("receipt lookup returned found without object_id");
      }
      return { status: "found", objectId: response.object_id };
    case "absent":
      return { status: "absent" };
    case "in_flight":
      return { status: "in_flight" };
    case "conflict":
      return { status: "conflict" };
    default:
      throw new ReceiptLookupError(
        `receipt lookup returned an unknown status: ${String(response?.status)}`,
      );
  }
}
