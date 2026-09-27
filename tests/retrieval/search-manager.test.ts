import { describe, expect, it } from "vitest";

import type { MusubiConfig } from "../../src/config.js";
import { MusubiClient } from "../../src/musubi/client.js";
import type { FetchLike } from "../../src/musubi/types.js";
import {
  createMusubiSearchManager,
  MusubiSearchUnavailableError,
  PROBE_CACHE_MS,
  parseVirtualPath,
  virtualPath,
} from "../../src/retrieval/search-manager.js";

type Route = (url: string, init: RequestInit) => { status: number; body?: unknown };

function harness(route: Route) {
  const calls: string[] = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push(`${String(init?.method ?? "GET")} ${url}`);
    const r = route(url, init as RequestInit);
    return new Response(r.body !== undefined ? JSON.stringify(r.body) : null, {
      status: r.status,
      headers: { "content-type": "application/json" },
    });
  };
  const client = new MusubiClient({
    baseUrl: "https://musubi.test",
    token: "t",
    fetch,
    sleep: async () => undefined,
    random: () => 0,
    generateRequestId: () => "r",
    generateIdempotencyKey: () => "i",
    retry: { maxAttempts: 1 },
  });
  return { client, calls };
}

const single: MusubiConfig = {
  core: { baseUrl: "https://musubi.test", token: "t" },
  presence: { defaultId: "eric/openclaw" },
};
const perAgent: MusubiConfig = {
  core: { baseUrl: "https://musubi.test", token: "t", perAgentTokens: { aoi: "aoi-token" } },
  presence: { defaultId: "eric/openclaw", perAgent: { aoi: "eric/aoi", rin: "eric/rin" } },
};

const row = (id: string, score: number, content: string, namespace = "eric/openclaw/episodic") => ({
  object_id: id,
  score,
  plane: "episodic",
  content,
  namespace,
});
const DATED = { status: 200, body: { created_at: "2026-09-12T10:00:00Z" } };

describe("createMusubiSearchManager identity", () => {
  it("gives a single-presence install a manager", () => {
    const { client } = harness(() => ({ status: 200 }));
    expect(createMusubiSearchManager({ client, config: single })("any")).not.toBeNull();
  });

  it("returns null for an unmapped agent in per-agent mode (no default fallback)", () => {
    const { client } = harness(() => ({ status: 200 }));
    expect(createMusubiSearchManager({ client, config: perAgent })("zoe")).toBeNull();
  });

  it("returns null for a mapped agent without its own token (strict)", () => {
    const { client } = harness(() => ({ status: 200 }));
    expect(createMusubiSearchManager({ client, config: perAgent })("rin")).toBeNull();
  });
});

describe("search", () => {
  it("honours lexicalOnly, non-memory sources and empty queries without calling Musubi", async () => {
    const { client, calls } = harness(() => ({ status: 200, body: { results: [] } }));
    const m = createMusubiSearchManager({ client, config: single })("a")!;
    expect(await m.search("q", { lexicalOnly: true })).toEqual([]);
    expect(await m.search("q", { sources: ["sessions"] })).toEqual([]);
    expect(await m.search("   ")).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it("maps strong dated rows to virtual-path results and drops weak ones", async () => {
    const { client } = harness((url) =>
      url.endsWith("/v1/retrieve")
        ? {
            status: 200,
            body: { results: [row("m1", 0.9, "We chose\nMatrix."), row("w", 0.3, "weak")] },
          }
        : DATED,
    );
    const results = await createMusubiSearchManager({ client, config: single })("a")!.search(
      "matrix",
    );
    expect(results).toEqual([
      {
        path: "musubi/eric/openclaw/episodic/m1",
        startLine: 1,
        endLine: 2,
        score: 0.9,
        snippet: "[2026-09-12 episodic] We chose Matrix.",
        source: "memory",
        citation: "eric/openclaw/episodic/m1",
      },
    ]);
  });

  it("applies a stricter host minScore but never a looser one", async () => {
    const { client } = harness((url) =>
      url.endsWith("/v1/retrieve")
        ? { status: 200, body: { results: [row("m1", 0.7, "x"), row("weak", 0.5, "y")] } }
        : DATED,
    );
    const m = createMusubiSearchManager({ client, config: single })("a")!;
    expect(await m.search("q", { minScore: 0.8 })).toEqual([]);
    // A lax host minScore must not admit the 0.5 row below Musubi's 0.60 floor.
    const lax = await m.search("q", { minScore: 0.1 });
    expect(lax.map((r) => r.citation)).toEqual(["eric/openclaw/episodic/m1"]);
  });

  it("throws instead of returning partial results when the read is degraded", async () => {
    // Dates resolve, so ONLY the degraded warning can make this throw.
    const { client } = harness((url) =>
      url.endsWith("/v1/retrieve")
        ? { status: 200, body: { results: [row("m1", 0.9, "x")], warnings: ["reranker down"] } }
        : DATED,
    );
    await expect(
      createMusubiSearchManager({ client, config: single })("a")!.search("q"),
    ).rejects.toBeInstanceOf(MusubiSearchUnavailableError);
  });

  it("throws when a strong row cannot be dated", async () => {
    const { client } = harness((url) =>
      url.endsWith("/v1/retrieve")
        ? { status: 200, body: { results: [row("m1", 0.9, "x")] } }
        : { status: 404 },
    );
    await expect(
      createMusubiSearchManager({ client, config: single })("a")!.search("q"),
    ).rejects.toThrow(/source date/);
  });

  it("fails closed on a foreign-owner row and never logs its content", async () => {
    const warns: string[] = [];
    const { client } = harness(() => ({
      status: 200,
      body: { results: [row("f", 0.9, "PRIVATE", "mallory/x/episodic")] },
    }));
    const m = createMusubiSearchManager({
      client,
      config: single,
      logger: { warn: (w) => warns.push(w) },
    })("a")!;
    await expect(m.search("q")).rejects.toThrow(/identity boundary/);
    expect(warns.join("\n")).not.toContain("PRIVATE");
  });
});

describe("readFile", () => {
  it("round-trips a virtual path to a canonical GET with the agent's token", async () => {
    const seen: Array<{ url: string; auth: string | null }> = [];
    const fetch: FetchLike = async (url, init) => {
      seen.push({
        url,
        auth: new Headers(init?.headers as ConstructorParameters<typeof Headers>[0]).get(
          "authorization",
        ),
      });
      return new Response(JSON.stringify({ content: "a\nb\nc", namespace: "eric/aoi/episodic" }), {
        status: 200,
      });
    };
    const client = new MusubiClient({
      baseUrl: "https://musubi.test",
      token: "t",
      fetch,
      sleep: async () => undefined,
    });
    const m = createMusubiSearchManager({ client, config: perAgent })("aoi")!;
    const path = virtualPath("eric/aoi/episodic", "m1");
    expect(await m.readFile({ relPath: path })).toEqual({ status: "ok", text: "a\nb\nc", path });
    expect(seen[0]?.url).toBe("https://musubi.test/v1/episodic/m1?namespace=eric%2Faoi%2Fepisodic");
    expect(seen[0]?.auth).toBe("Bearer aoi-token");
    expect(await m.readFile({ relPath: path, from: 2, lines: 1 })).toEqual({
      status: "ok",
      text: "b",
      path,
      from: 2,
      lines: 1,
      truncated: true,
      nextFrom: 3,
    });
  });

  it("answers not_found, without a request, for another owner's path or a malformed path", async () => {
    const { client, calls } = harness(() => ({ status: 200, body: { content: "secret" } }));
    const m = createMusubiSearchManager({ client, config: single })("a")!;
    for (const relPath of [
      "musubi/mallory/x/episodic/m1",
      "notes/today.md",
      "musubi/eric/openclaw/episodic",
    ]) {
      expect(await m.readFile({ relPath })).toEqual({
        status: "not_found",
        text: "",
        path: relPath,
      });
    }
    expect(calls).toHaveLength(0);
  });

  it("maps a 404 and a namespace mismatch to not_found", async () => {
    let n = 0;
    const { client } = harness(() =>
      ++n === 1
        ? { status: 404, body: { detail: "gone" } }
        : { status: 200, body: { content: "x", namespace: "eric/other/episodic" } },
    );
    const m = createMusubiSearchManager({ client, config: single })("a")!;
    const path = virtualPath("eric/openclaw/episodic", "m1");
    expect((await m.readFile({ relPath: path })).status).toBe("not_found");
    expect((await m.readFile({ relPath: path })).status).toBe("not_found");
  });
});

describe("status and probes", () => {
  it("reports provider musubi and caches the ops probe", async () => {
    let t = 1_000;
    const { client, calls } = harness(() => ({
      status: 200,
      body: {
        status: "ok",
        components: { qdrant: { healthy: true }, "tei-dense": { healthy: true } },
      },
    }));
    const m = createMusubiSearchManager({ client, config: single, now: () => t })("a")!;
    expect(m.status()).toMatchObject({
      backend: "builtin",
      provider: "musubi",
      sources: ["memory"],
    });
    expect(await m.probeEmbeddingAvailability()).toMatchObject({
      ok: true,
      checked: true,
      cached: false,
    });
    expect(await m.probeVectorAvailability()).toBe(true);
    expect(calls).toHaveLength(1);
    t += PROBE_CACHE_MS + 1;
    await m.probeEmbeddingAvailability();
    expect(calls).toHaveLength(2);
  });

  it("probes with each agent's own token and never shares one agent's cached health", async () => {
    const auths: Array<string | null> = [];
    const fetch: FetchLike = async (_url, init) => {
      auths.push(
        new Headers(init?.headers as ConstructorParameters<typeof Headers>[0]).get("authorization"),
      );
      return new Response(
        JSON.stringify({
          status: "ok",
          components: { qdrant: { healthy: true }, "tei-dense": { healthy: true } },
        }),
        { status: 200 },
      );
    };
    const client = new MusubiClient({
      baseUrl: "https://musubi.test",
      token: "t",
      fetch,
      sleep: async () => undefined,
    });
    const config: MusubiConfig = {
      core: {
        baseUrl: "https://musubi.test",
        token: "t",
        perAgentTokens: { aoi: "aoi-token", yua: "yua-token" },
      },
      presence: { defaultId: "eric/openclaw", perAgent: { aoi: "eric/aoi", yua: "eric/yua" } },
    };
    const factory = createMusubiSearchManager({ client, config, now: () => 5_000 });
    await factory("aoi")!.probeEmbeddingAvailability();
    const yua = await factory("yua")!.probeEmbeddingAvailability();
    expect(auths).toEqual(["Bearer aoi-token", "Bearer yua-token"]);
    expect(yua.cached).toBe(false);
  });

  it("parseVirtualPath rejects anything but musubi/<owner>/<presence>/<plane>/<id>", () => {
    expect(parseVirtualPath("musubi/eric/aoi/episodic/m1")).toEqual({
      owner: "eric",
      namespace: "eric/aoi/episodic",
      plane: "episodic",
      objectId: "m1",
    });
    expect(parseVirtualPath("musubi/eric/aoi/episodic")).toBeUndefined();
    expect(parseVirtualPath("x/eric/aoi/episodic/m1")).toBeUndefined();
  });
});
