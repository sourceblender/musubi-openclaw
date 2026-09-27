/**
 * OpenClaw session-key classification for capture policy.
 *
 * Mirrors the host's own `isCronSessionKey` (openclaw/plugin-sdk/routing):
 * an agent-scoped key `agent:<id>:<rest>` whose rest starts with `cron:`,
 * compared case-insensitively. Scheduled runs use
 * `agent:<id>:cron:<job>` and `agent:<id>:cron:<job>:run:<runId>`.
 *
 * Implemented locally rather than imported so the plugin still loads on the
 * oldest supported host (`openclaw >= 2026.7.1`); a test pins it to the host
 * classifier (tests/capture/session-kind.test.ts).
 */
export function isCronSessionKey(sessionKey: string | undefined): boolean {
  const raw = sessionKey?.trim();
  if (!raw) return false;
  if (raw.slice(0, 6).toLowerCase() !== "agent:") return false;
  const agentIdEnd = raw.indexOf(":", 6);
  if (agentIdEnd === -1) return false;
  const agentId = raw.slice(6, agentIdEnd).trim();
  const rest = raw.slice(agentIdEnd + 1);
  if (!agentId || !rest || rest.startsWith(":")) return false;
  return rest.toLowerCase().startsWith("cron:");
}
