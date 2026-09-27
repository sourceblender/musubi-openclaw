import type { MusubiConfig } from "../config.js";
import type { MusubiClient } from "../musubi/client.js";
import {
  errorMessage,
  guardedRetrieve,
  type MusubiRetrieveRow,
  STRONG_MATCH_MIN_SCORE,
} from "../retrieval/guarded.js";
import { PLANE_PATH } from "../retrieval/targets.js";
import { SearchParameters, type SearchParams } from "./parameters.js";

/**
 * Canonical agent-callable semantic search tool — `musubi_search`.
 *
 * Hybrid + rerank retrieval across every plane the calling presence can
 * read. This is the native first-class recall path; the agent invokes it when
 * prior continuity may matter or when artifact-level grounding is needed.
 *
 * This file holds the body. `recall.ts` re-exports the same body wrapped
 * with a deprecation log under the legacy `musubi_recall` name for
 * one minor release per [[13-decisions/0032-agent-tools-canonical-surface]].
 */

export type ToolDefinition = {
  readonly name: string;
  readonly description: string;
  readonly parameters: typeof SearchParameters;
  execute(toolCallId: string, params: SearchParams): Promise<ToolResult>;
};

export type ToolResult = {
  readonly content: ReadonlyArray<{ type: "text"; text: string }>;
  readonly isError?: boolean;
};

export type CreateSearchToolOptions = {
  readonly client: MusubiClient;
  readonly config: MusubiConfig;
  /** OpenClaw agent id for presence resolution. */
  readonly agentId?: string;
};

export type SearchTool = {
  readonly definition: ToolDefinition;
  readonly recommendedOptional: true;
};

const DEFAULT_LIMIT = 10;

type DatedRow = MusubiRetrieveRow & { readonly created_at?: string };
type DateEnrichment = {
  readonly rows: readonly DatedRow[];
  readonly warnings: readonly string[];
};

/**
 * Attach each candidate's real source date.
 *
 * `/v1/retrieve` returns object_id, namespace, plane, score, content, state,
 * importance, score_kind, extra and title -- verified against the live API on
 * 2026-08-07, not merely against our own type. There is no date on the wire and
 * `extra` holds only lineage and score_components, so a date cannot be surfaced
 * by typing an existing field; it has to be fetched.
 *
 * Why this matters: asked about one week and handed memories from another, the
 * model had NO field that distinguished them. We required a judgement we never
 * gave it the information to make. Enrichment is bounded by `limit` and each
 * failure degrades to "date unavailable" -- never to a guess, and never to
 * silently omitting the date, which is the state that caused this.
 *
 * Concurrency is capped at {@link DATE_ENRICHMENT_CONCURRENCY}: `limit` can be
 * 50, and each of those GETs carries its own retry budget, so an unbounded
 * fan-out turned one search against a struggling backend into a burst of
 * hundreds of in-flight requests.
 */
const DATE_ENRICHMENT_CONCURRENCY = 6;

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  mapper: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (let index = next++; index < items.length; index = next++) {
      results[index] = await mapper(items[index] as T);
    }
  });
  await Promise.all(workers);
  return results;
}

async function withDates(
  rows: readonly MusubiRetrieveRow[],
  client: MusubiClient,
  token: string,
): Promise<DateEnrichment> {
  const enriched = await mapWithConcurrency(rows, DATE_ENRICHMENT_CONCURRENCY, async (row) => {
    const base = PLANE_PATH[row.plane];
    if (!base) {
      return {
        row,
        warning: `date metadata unavailable for unsupported plane ${row.plane} (${row.namespace}/${row.object_id})`,
      };
    }
    try {
      const full = await client.getWithQuery<{ created_at?: string; event_at?: string }>(
        `${base}/${encodeURIComponent(row.object_id)}`,
        { namespace: row.namespace },
        { token },
      );
      // `created_at` is the lived/source chronology. Historical imports keep
      // that original timestamp while `event_at` records the later ingestion
      // lifecycle event. Prefer the source date so an old memory does not
      // present itself as something that happened during tonight's import.
      return { row: { ...row, created_at: full.created_at ?? full.event_at } };
    } catch (err) {
      return {
        row,
        warning: `date metadata unavailable for ${row.plane} ${row.namespace}/${row.object_id}: ${errorMessage(err)}`,
      };
    }
  });
  return {
    rows: enriched.map((entry) => entry.row),
    warnings: enriched.flatMap((entry) => (entry.warning ? [entry.warning] : [])),
  };
}

/**
 * Backing implementation. Exported so the deprecation alias in
 * `recall.ts` reuses the exact same code path — no parameter or
 * response drift between canonical and alias.
 */
export async function executeSearch(
  options: CreateSearchToolOptions,
  params: SearchParams,
): Promise<ToolResult> {
  const limit = params.limit ?? DEFAULT_LIMIT;
  const defaultPlanes = ["curated", "concept", "episodic", "artifact"];
  const callerPlanes = params.planes ? [...params.planes] : defaultPlanes;
  const retrieved = await guardedRetrieve(options, {
    query: params.query,
    planes: callerPlanes,
    limit,
    mode: "deep",
  });
  if (!retrieved.ok) return toolError(retrieved.message);
  const { client } = options;
  const { presence, warnings: retrieveWarnings } = retrieved;
  const warnings = [...retrieveWarnings];
  const results = retrieved.rows;
  if (results.length === 0) {
    const status =
      warnings.length > 0
        ? "No results were returned; retrieval was degraded."
        : `No Musubi results for "${params.query}".`;
    return toolText(appendWarnings(status, warnings));
  }
  const top = results[0]?.score ?? 0;
  if (top < STRONG_MATCH_MIN_SCORE) {
    // FAIL CLOSED. Withhold content, not just confidence. Showing weak
    // candidates alongside a caveat still puts plausible text in front of the
    // model, and that is precisely what got promoted into a claimed event.
    return toolText(
      appendWarnings(
        `NO STRONG MATCH for "${params.query}" (top similarity ${top.toFixed(2)}, ` +
          `floor ${STRONG_MATCH_MIN_SCORE.toFixed(2)}). ${results.length} weak ` +
          `candidate(s) were withheld: they are nearest neighbours, not evidence ` +
          `that any specific event occurred. Say you do not remember, or ask for ` +
          `a more specific detail and search again.`,
        warnings,
      ),
    );
  }
  const dated = await withDates(results, client, presence.token);
  return toolText(appendWarnings(formatResults(dated.rows), [...warnings, ...dated.warnings]));
}

export function createSearchTool(options: CreateSearchToolOptions): SearchTool {
  return {
    recommendedOptional: true,
    definition: {
      name: "musubi_search",
      description:
        "Search the active Musubi memory provider across every readable plane (curated knowledge, synthesized concepts, episodic memory, source artifacts) using hybrid retrieval and reranking.",
      parameters: SearchParameters,
      async execute(_toolCallId, params) {
        return executeSearch(options, params);
      },
    },
  };
}

function formatResults(rows: readonly DatedRow[]): string {
  const lines: string[] = [];
  lines.push(`Musubi returned ${rows.length} result(s):`);
  lines.push("");
  for (const row of rows) {
    const label = row.title ? `${row.title}` : `${row.namespace}/${row.object_id}`;
    // `created_at` is verified ISO-8601 elsewhere in this file
    // (`/\d{4}-\d{2}-\d{2}T/`), but the slice assumes the prefix;
    // fall back to "(date unavailable)" rather than rendering nonsense
    // if a server drift returns an unexpected shape.
    const when =
      typeof row.created_at === "string" && /^\d{4}-\d{2}-\d{2}/u.test(row.created_at)
        ? row.created_at.slice(0, 10)
        : "date unavailable";
    lines.push(`[${row.plane}] (${when}) (score ${row.score.toFixed(2)}) ${label}`);
    lines.push(row.content);
    if (row.content_truncated === true) {
      const full = typeof row.content_length === "number" ? ` of ${row.content_length} chars` : "";
      lines.push(`[content truncated${full} — use musubi_get for the full object]`);
    }
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}

function toolText(text: string): ToolResult {
  return { content: [{ type: "text", text }] };
}

function toolError(text: string): ToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

function appendWarnings(text: string, warnings: readonly string[]): string {
  if (warnings.length === 0) return text;
  return `${text}\n\nRetrieval warnings:\n${warnings.map((warning) => `- ${warning}`).join("\n")}`;
}
