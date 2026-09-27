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

type Call = { method: string; url: string; body: string | undefined };

function makeWorker(outbox: DeliveryOutbox, route: (call: Call) => Response) {
  const calls: Call[] = [];
  const fetch: FetchLike = async (url, init) => {
    const call = {
      method: String(init?.method ?? "GET"),
      url,
      body: typeof init?.body === "string" ? init.body : undefined,
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

describe("DeliveryWorker receipt lookup", () => {
  it("freezes the body on the first attempt and sends exactly those bytes", async () => {
    const outbox = open();
    const row = outbox.enqueue(item());
    const { worker, calls } = makeWorker(outbox, (c) =>
      c.url.endsWith("/v1/episodic") && c.method === "POST"
        ? json({ object_id: "obj-1", namespace: "aoi/command-chair/episodic" })
        : readback("obj-1"),
    );
    worker.start();
    const terminal = await worker.awaitTerminal(row.id, 2000);
    await worker.stop();
    const post = calls.find((c) => c.method === "POST" && c.url.endsWith("/v1/episodic"));
    expect(post?.body).toBe(captureRequestBody(row));
    expect(calls.some((c) => c.url.includes("/receipts/lookup"))).toBe(false);
    expect(terminal?.state).toBe("verified");
    expect(terminal?.request_body).toBeNull();
    outbox.close();
  });

  it("asks the receipt table on retry and verifies a found write without re-posting", async () => {
    const outbox = open();
    const frozen = captureRequestBody(outbox.enqueue(item()));
    const row = retried(outbox, frozen);
    const { worker, calls } = makeWorker(outbox, (c) =>
      c.url.includes("/receipts/lookup")
        ? json({ status: "found", object_id: "obj-found" })
        : readback("obj-found"),
    );
    worker.start();
    const terminal = await worker.awaitTerminal(row.id, 2000);
    await worker.stop();
    const lookup = calls.find((c) => c.url.includes("/receipts/lookup"));
    expect(JSON.parse(lookup!.body!)).toEqual({
      namespace: "aoi/command-chair/episodic",
      method: "POST",
      operation_id: CAPTURE_OPERATION_ID,
      idempotency_key: "idem-1",
      request_digest: canonicalRequestDigest(frozen),
    });
    expect(calls.some((c) => c.method === "POST" && c.url.endsWith("/v1/episodic"))).toBe(false);
    expect(calls.some((c) => c.url.includes("/v1/retrieve"))).toBe(false);
    expect(terminal?.state).toBe("verified");
    expect(terminal?.object_id).toBe("obj-found");
    outbox.close();
  });

  it("re-posts the frozen bytes verbatim when the receipt is absent", async () => {
    const outbox = open();
    // A frozen body in a DIFFERENT key order than today's serializer: the
    // worker must replay what is stored, never re-serialise.
    const frozen =
      '{"tags":["source:test","openclaw:idem-idem-1"],"importance":7,"content":"durable note","namespace":"aoi/command-chair/episodic"}';
    const row = retried(outbox, frozen);
    const { worker, calls } = makeWorker(outbox, (c) => {
      if (c.url.includes("/receipts/lookup")) return json({ status: "absent" });
      if (c.method === "POST" && c.url.endsWith("/v1/episodic"))
        return json({ object_id: "obj-new", namespace: "aoi/command-chair/episodic" });
      return readback("obj-new");
    });
    worker.start();
    const terminal = await worker.awaitTerminal(row.id, 2000);
    await worker.stop();
    const lookup = calls.find((c) => c.url.includes("/receipts/lookup"));
    expect(JSON.parse(lookup!.body!).request_digest).toBe(canonicalRequestDigest(frozen));
    const post = calls.find((c) => c.method === "POST" && c.url.endsWith("/v1/episodic"));
    expect(post?.body).toBe(frozen);
    expect(terminal?.state).toBe("verified");
    outbox.close();
  });

  it("treats in_flight as transient: no re-post, row stays retryable", async () => {
    const outbox = open();
    const row = retried(outbox, captureRequestBody(outbox.enqueue(item())));
    const { worker, calls } = makeWorker(outbox, (c) =>
      c.url.includes("/receipts/lookup") ? json({ status: "in_flight" }) : json({}, 500),
    );
    worker.start();
    await new Promise((resolve) => setTimeout(resolve, 150));
    await worker.stop();
    expect(calls.some((c) => c.method === "POST" && c.url.endsWith("/v1/episodic"))).toBe(false);
    const after = outbox.row(row.id);
    expect(after?.state).toBe("pending");
    expect(after?.last_error).toContain("in flight");
    outbox.close();
  });

  it("dead-letters a conflict instead of re-posting", async () => {
    const outbox = open();
    const row = retried(outbox, captureRequestBody(outbox.enqueue(item())));
    const { worker, calls } = makeWorker(outbox, (c) =>
      c.url.includes("/receipts/lookup") ? json({ status: "conflict" }) : json({}, 500),
    );
    worker.start();
    const terminal = await worker.awaitTerminal(row.id, 2000);
    await worker.stop();
    expect(calls.some((c) => c.method === "POST" && c.url.endsWith("/v1/episodic"))).toBe(false);
    expect(terminal?.state).toBe("dead");
    expect(terminal?.last_error).toContain("conflict");
    outbox.close();
  });

  it("refuses an unknown lookup status rather than guessing", async () => {
    const outbox = open();
    const row = retried(outbox, captureRequestBody(outbox.enqueue(item())));
    const { worker, calls } = makeWorker(outbox, (c) =>
      c.url.includes("/receipts/lookup") ? json({ status: "maybe" }) : json({}, 500),
    );
    worker.start();
    await new Promise((resolve) => setTimeout(resolve, 150));
    await worker.stop();
    expect(calls.some((c) => c.method === "POST" && c.url.endsWith("/v1/episodic"))).toBe(false);
    expect(outbox.row(row.id)?.last_error).toContain("unknown status");
    outbox.close();
  });

  it("freezes a pre-upgrade retried row with the pre-freeze serialisation", async () => {
    const outbox = open();
    const row = retried(outbox); // request_body NULL, attempts > 0: enqueued before the upgrade
    const expected = captureRequestBody(row);
    const { worker, calls } = makeWorker(outbox, (c) => {
      if (c.url.includes("/receipts/lookup"))
        return json({ status: "found", object_id: "obj-old" });
      return readback("obj-old");
    });
    worker.start();
    await worker.awaitTerminal(row.id, 2000);
    await worker.stop();
    const lookup = calls.find((c) => c.url.includes("/receipts/lookup"));
    expect(JSON.parse(lookup!.body!).request_digest).toBe(canonicalRequestDigest(expected));
    outbox.close();
  });
});
