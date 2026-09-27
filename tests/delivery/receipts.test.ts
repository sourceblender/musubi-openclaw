import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { MusubiConfig } from "../../src/config.js";
import { DeliveryOutbox, type EnqueueDelivery } from "../../src/delivery/outbox.js";
import { CAPTURE_OPERATION_ID, canonicalRequestDigest } from "../../src/delivery/receipts.js";
import { captureRequestBody, DeliveryWorker } from "../../src/delivery/worker.js";
import { MusubiClient } from "../../src/musubi/client.js";
import type { FetchLike } from "../../src/musubi/types.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function open() {
  const root = mkdtempSync(join(tmpdir(), "musubi-receipts-"));
  roots.push(root);
  return new DeliveryOutbox(join(root, "outbox.sqlite"));
}

function item(overrides: Partial<EnqueueDelivery> = {}): EnqueueDelivery {
  const content = overrides.content ?? "durable note";
  return {
    idempotencyKey: "idem-1",
    contentSha256: createHash("sha256").update(content).digest("hex"),
    namespace: "aoi/command-chair/episodic",
    agentId: "aoi",
    content,
    tags: ["source:test"],
    importance: 7,
    sourceRef: "turn-1",
    ...overrides,
  };
}

const config: MusubiConfig = {
  core: { baseUrl: "https://musubi.test", token: "default", perAgentTokens: { aoi: "tok" } },
  presence: { defaultId: "aoi/command-chair", perAgent: { aoi: "aoi/command-chair" } },
};
const logger = { info() {}, warn() {}, error() {}, debug() {} };

type Call = { method: string; url: string; body: string | undefined; receiptHeader: string | null };

function makeWorker(outbox: DeliveryOutbox, route: (call: Call) => Response) {
  const calls: Call[] = [];
  const fetch: FetchLike = async (url, init) => {
    const call = {
      method: String(init?.method ?? "GET"),
      url,
      body: typeof init?.body === "string" ? init.body : undefined,
      receiptHeader: new Headers(init?.headers as ConstructorParameters<typeof Headers>[0]).get(
        "idempotency-receipt",
      ),
    };
    calls.push(call);
    return route(call);
  };
  const worker = new DeliveryWorker({
    client: new MusubiClient({
      baseUrl: config.core.baseUrl,
      token: "default",
      fetch,
      sleep: async () => undefined,
    }),
    config,
    outbox,
    logger,
  });
  return { worker, calls };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const readback = (objectId: string, content = "durable note") =>
  json({
    object_id: objectId,
    namespace: "aoi/command-chair/episodic",
    content,
    tags: ["openclaw:idem-idem-1"],
  });

/** Put a row into "a previous attempt may have reached the server" state. */
function retried(outbox: DeliveryOutbox, frozen?: string) {
  const row = outbox.enqueue(item());
  if (frozen !== undefined) outbox.freezeRequestBody(row.id, frozen);
  outbox.markFailed(row.id, "network", true, -1_000_000);
  return row;
}

describe("canonicalRequestDigest", () => {
  it("matches Musubi's canonical_digest byte-for-byte (vector computed by the harness's Python)", () => {
    const body =
      '{"namespace":"aoi/command-chair/episodic","content":"durable note — ✓","importance":7,"tags":["source:test","openclaw:idem-idem-1"]}';
    expect(canonicalRequestDigest(body)).toBe(
      "7347d0f075b3c3bebacc7b67df5af1a2673df5868b91c14e2816704f336574e8",
    );
  });
});

describe("captureRequestBody", () => {
  it("keeps the pre-freeze key order so rows enqueued before the upgrade keep their digest", () => {
    const outbox = open();
    const row = outbox.enqueue(item());
    expect(Object.keys(JSON.parse(captureRequestBody(row)))).toEqual([
      "namespace",
      "content",
      "importance",
      "tags",
    ]);
    expect(JSON.parse(captureRequestBody(row)).tags).toEqual([
      "source:test",
      "openclaw:idem-idem-1",
    ]);
    outbox.close();
  });
});

describe("DeliveryWorker receipt-first delivery", () => {
  const isLookup = (c: Call) => c.url.includes("/receipts/lookup");
  const isCapture = (c: Call) => c.method === "POST" && c.url.endsWith("/v1/episodic");
  const accepted = (id: string) => json({ object_id: id, namespace: "aoi/command-chair/episodic" });
  const settle = () => new Promise((resolve) => setTimeout(resolve, 150));

  it("first attempt: lookup, mark, then ONE durable POST of the frozen bytes", async () => {
    const outbox = open();
    const row = outbox.enqueue(item());
    const { worker, calls } = makeWorker(outbox, (c) =>
      isLookup(c)
        ? json({ status: "absent" })
        : isCapture(c)
          ? accepted("obj-1")
          : readback("obj-1"),
    );
    worker.start();
    const terminal = await worker.awaitTerminal(row.id, 2000);
    await worker.stop();
    const order = calls.map((c) =>
      isLookup(c) ? "lookup" : isCapture(c) ? "capture" : "readback",
    );
    expect(order).toEqual(["lookup", "capture", "readback"]);
    const lookup = calls.find(isLookup);
    const capture = calls.find(isCapture);
    expect(JSON.parse(lookup!.body!)).toEqual({
      namespace: "aoi/command-chair/episodic",
      method: "POST",
      operation_id: CAPTURE_OPERATION_ID,
      idempotency_key: "idem-1",
      request_digest: canonicalRequestDigest(capture!.body!),
    });
    expect(capture?.body).toBe(captureRequestBody(row));
    expect(capture?.receiptHeader).toBe("durable");
    expect(terminal?.state).toBe("verified");
    expect(terminal?.post_attempt).toBe("durable");
    expect(terminal?.request_body).toBeNull();
    outbox.close();
  });

  it("found: verifies the receipt's object without posting", async () => {
    const outbox = open();
    const row = outbox.enqueue(item());
    const { worker, calls } = makeWorker(outbox, (c) =>
      isLookup(c) ? json({ status: "found", object_id: "obj-found" }) : readback("obj-found"),
    );
    worker.start();
    const terminal = await worker.awaitTerminal(row.id, 2000);
    await worker.stop();
    expect(calls.some(isCapture)).toBe(false);
    expect(terminal?.state).toBe("verified");
    expect(terminal?.object_id).toBe("obj-found");
    outbox.close();
  });

  it("absent after a durable POST attempt: holds the row and never re-posts", async () => {
    const outbox = open();
    const row = outbox.enqueue(item());
    outbox.freezeRequestBody(row.id, captureRequestBody(row));
    outbox.markPostAttempted(row.id, "durable"); // a crash or lost response after this point
    outbox.markFailed(row.id, "network", true, -1_000_000);
    const { worker, calls } = makeWorker(outbox, (c) =>
      isLookup(c) ? json({ status: "absent" }) : accepted("dup"),
    );
    worker.start();
    await settle();
    await worker.stop();
    expect(calls.some(isLookup)).toBe(true);
    expect(calls.some(isCapture)).toBe(false);
    const after = outbox.row(row.id);
    expect(after?.state).toBe("pending");
    expect(after?.last_error).toContain("no re-POST");
    outbox.close();
  });

  it("a failed durable POST is sent once (no in-request retry) and then held", async () => {
    const outbox = open();
    const row = outbox.enqueue(item());
    let lookups = 0;
    const { worker, calls } = makeWorker(outbox, (c) => {
      if (isLookup(c)) {
        lookups += 1;
        return json({ status: "absent" });
      }
      return json({ detail: "upstream" }, 503);
    });
    worker.start();
    await settle();
    await worker.stop();
    expect(calls.filter(isCapture)).toHaveLength(1);
    const after = outbox.row(row.id);
    expect(after?.post_attempt).toBe("durable");
    expect(after?.state).toBe("pending");
    expect(lookups).toBeGreaterThanOrEqual(1);
    outbox.close();
  });

  it("in_flight is transient: no POST, row stays retryable", async () => {
    const outbox = open();
    const row = outbox.enqueue(item());
    const { worker, calls } = makeWorker(outbox, (c) =>
      isLookup(c) ? json({ status: "in_flight" }) : json({}, 500),
    );
    worker.start();
    await settle();
    await worker.stop();
    expect(calls.some(isCapture)).toBe(false);
    expect(outbox.row(row.id)?.last_error).toContain("in flight");
    outbox.close();
  });

  it("conflict dead-letters without posting", async () => {
    const outbox = open();
    const row = outbox.enqueue(item());
    const { worker, calls } = makeWorker(outbox, (c) =>
      isLookup(c) ? json({ status: "conflict" }) : json({}, 500),
    );
    worker.start();
    const terminal = await worker.awaitTerminal(row.id, 2000);
    await worker.stop();
    expect(calls.some(isCapture)).toBe(false);
    expect(terminal?.state).toBe("dead");
    expect(terminal?.last_error).toContain("conflict");
    outbox.close();
  });

  it("refuses an unknown lookup status rather than guessing", async () => {
    const outbox = open();
    const row = outbox.enqueue(item());
    const { worker, calls } = makeWorker(outbox, (c) =>
      isLookup(c) ? json({ status: "maybe" }) : json({}, 500),
    );
    worker.start();
    await settle();
    await worker.stop();
    expect(calls.some(isCapture)).toBe(false);
    expect(outbox.row(row.id)?.last_error).toContain("unknown status");
    outbox.close();
  });

  it("an older server without the receipt route gets a legacy POST (no durable header)", async () => {
    const outbox = open();
    const row = outbox.enqueue(item());
    const { worker, calls } = makeWorker(outbox, (c) =>
      isLookup(c)
        ? json({ detail: "Not Found" }, 404)
        : isCapture(c)
          ? accepted("obj-l")
          : readback("obj-l"),
    );
    worker.start();
    const terminal = await worker.awaitTerminal(row.id, 2000);
    await worker.stop();
    expect(calls.find(isCapture)?.receiptHeader).toBeNull();
    expect(terminal?.post_attempt).toBe("legacy");
    expect(terminal?.state).toBe("verified");
    outbox.close();
  });

  it("a pre-upgrade retried row keeps the receipt-tag recovery before any POST", async () => {
    const outbox = open();
    const row = outbox.enqueue(item());
    outbox.markFailed(row.id, "network", true, -1_000_000); // attempts > 0, no frozen body, no marker
    const expected = captureRequestBody(row);
    const { worker, calls } = makeWorker(outbox, (c) => {
      if (isLookup(c)) return json({ status: "absent" });
      if (c.url.includes("/v1/retrieve"))
        return json({
          mode: "recent",
          limit: 50,
          warnings: [],
          results: [{ object_id: "obj-legacy" }],
        });
      return readback("obj-legacy");
    });
    worker.start();
    const terminal = await worker.awaitTerminal(row.id, 2000);
    await worker.stop();
    expect(JSON.parse(calls.find(isLookup)!.body!).request_digest).toBe(
      canonicalRequestDigest(expected),
    );
    expect(calls.some(isCapture)).toBe(false);
    expect(terminal?.object_id).toBe("obj-legacy");
    expect(terminal?.state).toBe("verified");
    outbox.close();
  });
});
