/**
 * Musubi-backed OpenClaw MemorySearchManager — the Musubi half of the memory
 * capability's `runtime.getMemorySearchManager()`.
 *
 * OpenClaw's own memory surfaces (status, CLI search, the tool path) call a
 * search manager. The contract is file-shaped (paths, line ranges,
 * `readFile(relPath)`); Musubi stores objects, so each object is exposed at a
 * virtual path `musubi/<owner>/<presence>/<plane>/<object_id>`, which is its
 * canonical namespace plus id under a `musubi/` root.
 *
 * Same guarantees as prompt recall (`retrieval/recall.ts`), because host code
 * may surface these results to a model:
 * - one explicit agent per manager; no default-presence fallback
 *   (`recallIdentityIsExplicit` + strict presence resolution);
 * - every read through `guardedRetrieve` (first foreign-owner row fails the
 *   call);
 * - degraded reads, weak-only results and undated strong rows never come back
 *   as partial results: degraded/undated throw, weak-only returns [];
 * - `lexicalOnly` (OpenClaw's inbound reply-path recall, which must not add a
 *   network round-trip) returns [] without calling Musubi.
 *
 * The OpenClaw types are derived from `registerMemoryCapability`'s own
 * signature, so this module is checked against the host contract at compile
 * time without importing an unexported SDK path.
 */

import type { OpenClawPluginApi } from "../api.js";
import type { MusubiConfig } from "../config.js";
import type { MusubiClient } from "../musubi/client.js";
import { MusubiError } from "../musubi/errors.js";
import { resolvePresence } from "../presence/resolver.js";
import { type DatedRow, withDates } from "./dates.js";
import { errorMessage, guardedRetrieve, STRONG_MATCH_MIN_SCORE } from "./guarded.js";
import { recallIdentityIsExplicit } from "./recall.js";
import { PLANE_PATH } from "./targets.js";

type MemoryCapability = Parameters<OpenClawPluginApi["registerMemoryCapability"]>[0];
type MemoryRuntime = NonNullable<MemoryCapability["runtime"]>;
export type OpenClawMemorySearchManager = NonNullable<
  Awaited<ReturnType<MemoryRuntime["getMemorySearchManager"]>>["manager"]
>;
type SearchResult = Awaited<ReturnType<OpenClawMemorySearchManager["search"]>>[number];
type ReadResult = Awaited<ReturnType<OpenClawMemorySearchManager["readFile"]>>;
type EmbeddingProbe = Awaited<
  ReturnType<OpenClawMemorySearchManager["probeEmbeddingAvailability"]>
>;

export const SEARCH_MANAGER_DEFAULT_RESULTS = 10;
export const SEARCH_MANAGER_MAX_RESULTS = 50;
/** Planes a host search reaches. Same set as `musubi_search`. */
export const SEARCH_MANAGER_PLANES = ["curated", "concept", "episodic", "artifact"] as const;
/** Characters of content in one search snippet. */
export const SEARCH_MANAGER_SNIPPET_CHARS = 700;
/** How long one `/v1/ops/status` probe answer is reused. */
export const PROBE_CACHE_MS = 60_000;

const PATH_ROOT = "musubi";

/** A Musubi read that must not be presented as a (partial) result. */
export class MusubiSearchUnavailableError extends Error {
  override readonly name = "MusubiSearchUnavailableError";
}

export type CreateMusubiSearchManagerOptions = {
  readonly client: MusubiClient;
  readonly config: MusubiConfig;
  readonly logger?: { warn(message: string): void };
  /** Injectable clock for probe caching; defaults to Date.now. */
  readonly now?: () => number;
};

/**
 * Returns a factory: one manager per explicit agent, or null when that agent
 * has no Musubi identity of its own (the host then gets no manager, never a
 * default-presence one).
 */
export function createMusubiSearchManager(
  options: CreateMusubiSearchManagerOptions,
): (agentId: string) => OpenClawMemorySearchManager | null {
  const { client, config, logger } = options;
  const now = options.now ?? Date.now;
  let probe: { at: number; ok: boolean; vector: boolean; error?: string } | undefined;

  async function probeService(): Promise<NonNullable<typeof probe>> {
    const at = now();
    if (probe && at - probe.at < PROBE_CACHE_MS) return probe;
    try {
      const status = await client.get<{
        status?: unknown;
        components?: Record<string, { healthy?: unknown }>;
      }>("/v1/ops/status");
      const qdrant = status?.components?.qdrant?.healthy === true;
      const dense = status?.components?.["tei-dense"]?.healthy === true;
      probe = { at, ok: status?.status === "ok" && dense, vector: qdrant };
    } catch (error) {
      probe = { at, ok: false, vector: false, error: errorMessage(error) };
    }
    return probe;
  }

  return (agentId: string) => {
    if (!agentId || !recallIdentityIsExplicit(config, agentId)) return null;
    let owner: string;
    try {
      owner = resolvePresence(config, { agentId, strict: true }).presence.split("/", 1)[0] ?? "";
    } catch {
      return null;
    }
    if (!owner) return null;

    const manager: OpenClawMemorySearchManager = {
      async search(query, opts) {
        if (opts?.lexicalOnly) return [];
        if (opts?.sources && !opts.sources.includes("memory")) return [];
        if (opts?.signal?.aborted) return [];
        const trimmed = query.trim();
        if (trimmed.length === 0) return [];
        const limit = Math.max(
          1,
          Math.min(opts?.maxResults ?? SEARCH_MANAGER_DEFAULT_RESULTS, SEARCH_MANAGER_MAX_RESULTS),
        );

        const retrieved = await guardedRetrieve(
          { client, config, agentId, strict: true },
          {
            query: trimmed,
            planes: SEARCH_MANAGER_PLANES,
            limit,
            mode: "deep",
            ...(opts?.signal ? { signal: opts.signal } : {}),
          },
        );
        if (!retrieved.ok) {
          if (retrieved.kind === "boundary")
            logger?.warn(`musubi: memory search withheld — ${retrieved.message}`);
          throw new MusubiSearchUnavailableError(retrieved.message);
        }
        if (retrieved.warnings.length > 0) {
          throw new MusubiSearchUnavailableError(
            `Musubi search degraded; no partial results returned (${retrieved.warnings.length} warning(s))`,
          );
        }
        // The host may ask for a stricter floor, never a looser one: weak
        // candidates are nearest neighbours, not evidence (see guarded.ts).
        const floor = Math.max(STRONG_MATCH_MIN_SCORE, opts?.minScore ?? 0);
        const strong = retrieved.rows.filter((row) => row.score >= floor);
        if (strong.length === 0) return [];
        const dated = await withDates(strong, client, retrieved.presence.token, opts?.signal);
        if (dated.rows.some((row) => sourceDate(row) === undefined)) {
          throw new MusubiSearchUnavailableError(
            "Musubi search could not establish a source date for every strong result; none returned",
          );
        }
        return dated.rows.map(toSearchResult);
      },

      async readFile({ relPath, from, lines }) {
        const target = parseVirtualPath(relPath);
        if (!target || target.owner !== owner) return notFound(relPath);
        const base = PLANE_PATH[target.plane];
        if (!base) return notFound(relPath);
        const presence = resolvePresence(config, { agentId, strict: true });
        let object: {
          content?: unknown;
          created_at?: unknown;
          event_at?: unknown;
          namespace?: unknown;
        };
        try {
          object = await client.getWithQuery(
            `${base}/${encodeURIComponent(target.objectId)}`,
            { namespace: target.namespace },
            { token: presence.token },
          );
        } catch (error) {
          if (error instanceof MusubiError && (error.status === 404 || error.status === 403))
            return notFound(relPath);
          throw error;
        }
        // Identity boundary on the read path too: the returned row must live
        // in the namespace the path named.
        if (object?.namespace !== undefined && object.namespace !== target.namespace)
          return notFound(relPath);
        const text = typeof object?.content === "string" ? object.content : "";
        return sliceLines(relPath, text, from, lines);
      },

      status() {
        return {
          backend: "builtin",
          provider: "musubi",
          sources: ["memory"],
          ...(probe?.error ? { lastSyncError: `Musubi status probe failed: ${probe.error}` } : {}),
        };
      },

      async probeEmbeddingAvailability(): Promise<EmbeddingProbe> {
        const cachedBefore = probe !== undefined && now() - probe.at < PROBE_CACHE_MS;
        const p = await probeService();
        return {
          ok: p.ok,
          checked: true,
          cached: cachedBefore,
          checkedAtMs: p.at,
          cacheExpiresAtMs: p.at + PROBE_CACHE_MS,
          ...(p.error ? { error: p.error } : {}),
        };
      },

      async probeVectorAvailability() {
        return (await probeService()).vector;
      },
    };
    return manager;
  };
}

/** `musubi/<owner>/<presence>/<plane>/<object_id>` for one Musubi object. */
export function virtualPath(namespace: string, objectId: string): string {
  return `${PATH_ROOT}/${namespace}/${objectId}`;
}

export function parseVirtualPath(
  relPath: string,
): { owner: string; namespace: string; plane: string; objectId: string } | undefined {
  const parts = relPath.split("/");
  if (parts.length !== 5 || parts[0] !== PATH_ROOT) return undefined;
  const [, owner, presence, plane, objectId] = parts as [string, string, string, string, string];
  if (!owner || !presence || !plane || !objectId) return undefined;
  return { owner, namespace: `${owner}/${presence}/${plane}`, plane, objectId };
}

function toSearchResult(row: DatedRow): SearchResult {
  const date = sourceDate(row) ?? "";
  const flat = row.content.replace(/\s+/g, " ").trim();
  const cut = flat.length > SEARCH_MANAGER_SNIPPET_CHARS || row.content_truncated === true;
  const snippet = `[${date} ${row.plane}] ${flat.slice(0, SEARCH_MANAGER_SNIPPET_CHARS)}${cut ? "…" : ""}`;
  const lineCount = Math.max(1, row.content.split("\n").length);
  return {
    path: virtualPath(row.namespace, row.object_id),
    startLine: 1,
    endLine: lineCount,
    score: row.score,
    snippet,
    source: "memory",
    citation: `${row.namespace}/${row.object_id}`,
  };
}

function notFound(path: string): ReadResult {
  return { status: "not_found", text: "", path };
}

function sliceLines(path: string, text: string, from?: number, lines?: number): ReadResult {
  if (from === undefined && lines === undefined) return { status: "ok", text, path };
  const all = text.split("\n");
  const start = Math.max(1, from ?? 1);
  const count = Math.max(0, lines ?? all.length);
  const slice = all.slice(start - 1, start - 1 + count);
  const next = start - 1 + slice.length;
  return {
    status: "ok",
    text: slice.join("\n"),
    path,
    from: start,
    lines: slice.length,
    ...(next < all.length ? { truncated: true, nextFrom: next + 1 } : {}),
  };
}

function sourceDate(row: DatedRow): string | undefined {
  const at = row.created_at;
  return typeof at === "string" && /^\d{4}-\d{2}-\d{2}T/.test(at) ? at.slice(0, 10) : undefined;
}
