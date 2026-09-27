# openclaw-musubi

**First-class durable Musubi memory for OpenClaw agents.** The plugin owns
OpenClaw's exclusive memory slot and routes completed-turn capture, semantic
recall, exact-object reads, and deliberate stores through a Musubi core.

## Current architecture

`openclaw-musubi` declares `kind: "memory"` and must be selected with
`plugins.slots.memory = "musubi"`. It does not run beside `memory-core` as an
additive supplement. That earlier architecture is historical and was
superseded by [ADR-0004](./docs/decisions/0004-first-class-memory-provider.md).

The provider:

- registers the exclusive OpenClaw memory capability;
- exposes native `memory_search`, `memory_get`, and `memory_store` tools, plus
  the canonical Musubi tool surface;
- commits every completed turn to a local SQLite outbox before the
  `agent_end` hook returns;
- delivers with stable idempotency, receipt lookup, accepted/verified states,
  and canonical GET readback;
- retains retryable and permanently blocked deliveries for operator action;
- exposes delivery truth through `/musubi-status`, `musubi.status`, and the
  `openclaw musubi-status` CLI command.

Outbound `musubi_think` remains available. The former inbound SSE thought
subscriber is deliberately not registered: it had no OpenClaw context-delivery
contract and consuming a thought into an empty handler would be data loss
disguised as delivery.

## Requirements

- OpenClaw `>= 2026.7.1` (the repository gate runs against `2026.9.6`)
- Node.js `>= 24.16.0 <25` or `>= 26.1.0`
- A reachable Musubi core with canonical episodic and retrieval APIs

## Install and select the memory slot

Build the plugin before a local linked install. Install it into a valid
OpenClaw profile **before** adding the memory slot or allow entry: current
OpenClaw rejects a slot that names a plugin it cannot discover yet. Review
the manifest's tool, hook, and secret contracts before accepting capabilities.
For a managed Git install, use the source commit you intend to deploy. The
npm package remains named `openclaw-musubi` for existing installs; this
repository is its source of truth.

```bash
npm ci
npm run build
npm prune --omit=dev --legacy-peer-deps
openclaw plugins install -l "$PWD" --force --accept-capabilities
```

Prune before linking a development checkout: OpenClaw 2026.9.6 treats its own
bundled plugins inside this package's `node_modules` as conflicting children of
Musubi. The prune keeps runtime dependencies and removes the development-only
OpenClaw host. A published npm package already has this production layout.

Configure `plugins.allow` to include `musubi`, set
`plugins.entries.musubi.enabled: true`, and select
`plugins.slots.memory: "musubi"` as shown below. An install without valid
Musubi configuration is saved disabled. This external plugin needs
`plugins.entries.musubi.hooks.allowConversationAccess: true` for completed-turn
capture and prompt recall. `allowPromptInjection` must not be `false` for
prompt recall. Review that access before enabling the plugin.

## Configuration

Musubi secret fields are declared OpenClaw `secretInputs`; use the same
structured SecretRef form as other native OpenClaw secrets. Literal `${...}`
placeholders are rejected locally before the provider registers.

```json
{
  "plugins": {
    "allow": ["musubi"],
    "slots": { "memory": "musubi" },
    "entries": {
      "musubi": {
        "enabled": true,
        "hooks": { "allowConversationAccess": true },
        "config": {
          "core": {
            "baseUrl": "https://musubi.example.internal",
            "token": {
              "source": "exec",
              "provider": "onepassword",
              "id": "musubi-default"
            },
            "perAgentTokens": {
              "vesper": {
                "source": "exec",
                "provider": "onepassword",
                "id": "musubi-vesper"
              }
            }
          },
          "presence": {
            "defaultId": "owner/openclaw",
            "perAgent": { "vesper": "vesper/openclaw" }
          },
          "capture": {
            "completedTurns": true,
            "skipSessionKeys": ["agent:*:ops-*"]
          }
        }
      }
    }
  }
}
```

Completed-turn capture skips two kinds of machine cadence by default, each
counted under its own reason in the capture diagnostics: OpenClaw heartbeat
polls (`heartbeat_poll`) and scheduled cron runs, any session key of the form
`agent:<id>:cron:...` (`cron_session`). Set `capture.captureCronSessions: true`
to capture cron runs. `capture.skipSessionKeys` excludes further sessions by
glob (`*` is the only wildcard; matching is anchored and case-sensitive), and
every turn it skips is logged as `session_filtered`.

## Verify the live contract

These commands re-establish the claims above; the dates in documentation do
not substitute for running them:

```bash
npm run typecheck
npm run lint
npm test
npm run build
openclaw plugins inspect musubi --runtime --json
openclaw gateway call musubi.status --json
openclaw gateway call musubi.doctor --params '{"agentId":"vesper"}' --timeout 30000 --json
```

The Gateway commands run against the active plugin, where OpenClaw has
materialized configured SecretRefs. Plugin CLI commands such as
`openclaw musubi-doctor --agent vesper` are available only when the CLI process
receives materialized token strings; an unresolved SecretRef makes CLI preview
inert by design. `musubi.doctor` requires `operator.write` because it creates
and archives a diagnostic memory.

The selected memory capability also supplies OpenClaw's active
`MemorySearchManager`: host memory searches use Musubi's guarded retrieval and
canonical object reads. In OpenClaw 2026.9.4, the separate `openclaw memory`
CLI still constructs the built-in file index directly and can report its
provider as `openai` even when `plugins.slots.memory` selects Musubi. Use
`musubi.status` and `musubi.doctor` for Musubi health until that host CLI route
uses the selected capability.

The loader-backed test runs a packed artifact through OpenClaw 2026.9.6 with
`plugins.slots.memory = "musubi"`; it checks the manifest-owned memory kind,
exclusive capability, tools, and conversation-hook registration.

`musubi-doctor` is an explicit deep proof: it queues a diagnostic through the
same SQLite delivery path as a real turn, waits for canonical GET verification,
requires semantic retrieval to return that exact object, then soft-archives the
probe. It never runs automatically.

## Upgrade notes

### From 1.x to 2.x

2.0.0 is a breaking change to the architecture (ADR-0004). On-disk delivery
state from a 1.x install is **not** safe to reuse as-is: the idempotency-key
prefix (`openclaw-mirror`) was kept for replay continuity with 1.0.x rows
that may already exist in a consumer outbox, but the delivery worker, the
capture shape, and the namespace mapping all changed.

If you are upgrading in place, plan for the new state directory under
`<stateDir>/musubi/delivery-outbox.sqlite` — starting it fresh is the
recommended path. If you must reuse the 1.x database, expect rows whose
content shape no longer matches the canonical `/v1/episodic` body to
dead-letter after their first retry; inspect with `openclaw musubi-status`
and prune deliberately.

## Documentation

- [Architecture overview](./docs/architecture/overview.md)
- [Runtime wiring](./docs/architecture/wiring.md)
- [Presence model](./docs/architecture/presence-model.md)
- [Transport and API contract](./docs/api-contract.md)
- [Architecture decisions](./docs/decisions/)

## License

Apache-2.0 — see [LICENSE](./LICENSE). Earlier MIT-licensed releases retain their original terms; see [LICENSE-MIT-LEGACY](./LICENSE-MIT-LEGACY).
