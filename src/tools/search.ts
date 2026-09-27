import type { MusubiConfig } from "../config.js";
import type { MusubiClient } from "../musubi/client.js";
import { type DatedRow, withDates } from "../retrieval/dates.js";
import { guardedRetrieve, STRONG_MATCH_MIN_SCORE } from "../retrieval/guarded.js";
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
