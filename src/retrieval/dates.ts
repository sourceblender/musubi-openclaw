/**
 * Source-date enrichment for retrieved rows, shared by `musubi_search` and
 * automatic prompt recall. Moved verbatim from `tools/search.ts`; the only
 * addition is an optional AbortSignal so a caller's timeout cancels the GETs.
 */

import type { MusubiClient } from "../musubi/client.js";
import { errorMessage, type MusubiRetrieveRow } from "./guarded.js";
import { PLANE_PATH } from "./targets.js";

export type DatedRow = MusubiRetrieveRow & { readonly created_at?: string };
export type DateEnrichment = {
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

export async function withDates(
  rows: readonly MusubiRetrieveRow[],
  client: MusubiClient,
  token: string,
  signal?: AbortSignal,
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
        { token, ...(signal ? { signal } : {}) },
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
