/**
 * Guarded cross-plane retrieval — the one path every Musubi read that
 * surfaces memory content to a model goes through.
 *
 * Extracted from `tools/search.ts` so the agent-callable search tool and
 * automatic prompt recall (`retrieval/recall.ts`) share ONE identity
 * boundary instead of two copies that can drift. The boundary itself is
 * unchanged: reads use the no-namespace family path (see `targets.ts`),
 * so the server derives the identity family from the presented token, and
 * the first returned row whose owner differs from the configured presence
 * fails the whole call before any row content is merged, surfaced, or
 * logged. See ADR-0005.
 */

import type { MusubiConfig } from "../config.js";
import type { MusubiClient } from "../musubi/client.js";
import { MusubiError } from "../musubi/errors.js";
import { type PresenceContext, resolvePresence } from "../presence/resolver.js";
import { buildRetrieveTargets } from "./targets.js";

export type MusubiRetrieveRow = {
  readonly object_id: string;
  readonly score: number;
  readonly plane: string;
  readonly content: string;
  readonly namespace: string;
  readonly title?: string | null;
  /** True when the server sliced `content` for the response. */
  readonly content_truncated?: boolean;
  /** Server-side slice length in CHARACTERS (UTF-16 code units), not bytes. */
  readonly content_length?: number;
};

export type MusubiRetrieveResponse = {
  readonly results: readonly MusubiRetrieveRow[];
  readonly warnings?: readonly unknown[];
};

export const RECALL_STATES = ["provisional", "matured", "promoted"] as const;

/**
 * Similarity below which retrieved rows are nearest neighbours, not
 * evidence. Shared by `musubi_search` (which withholds weak candidates)
 * and automatic prompt recall (which injects nothing below it).
 */
export const STRONG_MATCH_MIN_SCORE = 0.6;

export type GuardedRetrieveOptions = {
  readonly client: MusubiClient;
  readonly config: MusubiConfig;
  /** OpenClaw agent id for presence resolution. */
  readonly agentId?: string;
  /**
   * Refuse to resolve an agent that has a presence mapping but no token of
   * its own (see `resolvePresence` strict mode). Prompt recall sets this.
   */
  readonly strict?: boolean;
};

export type GuardedRetrieveRequest = {
  readonly query: string;
  readonly planes: readonly string[];
  readonly limit: number;
  readonly mode: "deep" | "fast";
  readonly signal?: AbortSignal;
};

export type GuardedRetrieveResult =
  | {
      readonly ok: true;
      readonly presence: PresenceContext;
      /** Deduplicated by object_id, sorted by score descending, capped at `limit`. */
      readonly rows: readonly MusubiRetrieveRow[];
      /** Per-target failures and server warnings. Non-empty means degraded. */
      readonly warnings: readonly string[];
    }
  | {
      readonly ok: false;
      readonly kind: "presence" | "failed" | "boundary";
      readonly message: string;
    };

export async function guardedRetrieve(
  options: GuardedRetrieveOptions,
  request: GuardedRetrieveRequest,
): Promise<GuardedRetrieveResult> {
  const { client, config, agentId, strict = false } = options;

  let presence: PresenceContext;
  try {
    presence = resolvePresence(config, { agentId, strict });
  } catch (err) {
    return { ok: false, kind: "presence", message: `Presence unresolved: ${errorMessage(err)}` };
  }

  const targets = buildRetrieveTargets(presence, [...request.planes]);

  const settled = await Promise.allSettled(
    targets.map((t) =>
      client.post<MusubiRetrieveResponse>("/v1/retrieve", {
        body: {
          // `namespace` is deliberately omitted for undefined targets:
          // the server's family-discovery path filters unauthorized
          // namespaces instead of 403ing the whole request the way an
          // explicit wildcard does. See retrieval/targets.ts.
          ...(t.namespace !== undefined ? { namespace: t.namespace } : {}),
          planes: [...t.planes],
          query_text: request.query,
          mode: request.mode,
          limit: request.limit,
          state_filter: [...RECALL_STATES],
        },
        token: presence.token,
        ...(request.signal ? { signal: request.signal } : {}),
      }),
    ),
  );
  if (settled.every((r) => r.status === "rejected")) {
    const firstErr =
      settled[0]?.status === "rejected"
        ? (settled[0] as PromiseRejectedResult).reason
        : new Error("unknown");
    return {
      ok: false,
      kind: "failed",
      message: `Musubi search failed: ${errorMessage(firstErr)}`,
    };
  }
  const seen = new Set<string>();
  const merged: MusubiRetrieveRow[] = [];
  const warnings: string[] = [];
  // Identity-boundary invariant: every target must agree on `expectedOwner`,
  // because the row-by-row check below fails closed on the FIRST foreign
  // owner it sees. Anchoring on `targets[0]?.expectedOwner` would let a
  // future multi-presence build slip a different owner past the gate,
  // since targets[1..N] are not consulted. Today the build only ever
  // returns one target; this asserts the invariant explicitly so the
  // gate stays correct when buildRetrieveTargets grows.
  const owners = new Set(targets.map((t) => t.expectedOwner));
  if (owners.size !== 1) {
    return {
      ok: false,
      kind: "boundary",
      message:
        `Musubi identity boundary violation: buildRetrieveTargets returned ` +
        `targets with conflicting owners (${[...owners].join(", ")}). No ` +
        `results were surfaced. This is a plugin configuration bug, not a ` +
        `server response — file an issue.`,
    };
  }
  const expectedOwner = targets[0]?.expectedOwner;
  for (const result of settled) {
    if (result.status !== "fulfilled") {
      warnings.push(`one retrieval target failed: ${errorMessage(result.reason)}`);
      continue;
    }
    for (const warning of result.value.warnings ?? []) {
      warnings.push(`Musubi warning: ${formatWarning(warning)}`);
    }
    for (const row of result.value.results ?? []) {
      // IDENTITY BOUNDARY — the FIRST statement in the row loop, before
      // any downstream content handling: the row is never merged,
      // surfaced, or logged. (The HTTP body was necessarily JSON-parsed
      // by the client before this loop; the guarantee is about what
      // happens to row content after that.) No-namespace retrieval lets
      // the server derive the identity family from the presented token
      // alone, so a credential misbinding (this agent configured with
      // another agent's token) would otherwise SUCCEED and hand this
      // agent someone else's memories. A single foreign row fails the
      // entire call — no partial success, no silent dropping — so
      // operators see the misbinding instead of the agents quietly
      // sharing a mind.
      const rowNamespace = typeof row.namespace === "string" ? row.namespace : "";
      const rowOwner = rowNamespace.split("/", 1)[0];
      if (expectedOwner === undefined || rowOwner !== expectedOwner) {
        return {
          ok: false,
          kind: "boundary",
          message:
            `Musubi identity boundary violation: retrieval returned namespace ` +
            `"${rowNamespace}" outside the configured identity "${expectedOwner ?? "?"}/…". ` +
            `No results were surfaced. This means the token bound to this agent ` +
            `authenticates a DIFFERENT identity family — check ` +
            `plugins.entries.musubi.config.core.perAgentTokens for this agent before retrying.`,
        };
      }
      if (seen.has(row.object_id)) continue;
      seen.add(row.object_id);
      merged.push(row);
    }
  }
  merged.sort((a, b) => b.score - a.score);
  return { ok: true, presence, rows: merged.slice(0, request.limit), warnings };
}

export function formatWarning(warning: unknown): string {
  if (typeof warning === "string") return warning;
  try {
    return JSON.stringify(warning);
  } catch {
    return String(warning);
  }
}

export function errorMessage(err: unknown): string {
  if (err instanceof MusubiError) return `${err.name}: ${err.message}`;
  if (err instanceof Error) return err.message;
  return String(err);
}
