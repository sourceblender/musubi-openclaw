import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

describe("OpenClaw active memory runtime", () => {
  it("routes the selected slot to Musubi's manager and refuses an unmapped agent", () => {
    const script = `
      import { getActiveMemorySearchManager } from "openclaw/plugin-sdk/memory-host-search";
      const cfg = {
        agents: { defaults: { workspace: "/tmp/musubi-openclaw-active-host-probe" } },
        plugins: {
          allow: ["musubi"],
          load: { paths: [process.cwd()] },
          slots: { memory: "musubi" },
          entries: { musubi: { enabled: true, config: {
            core: { baseUrl: "https://musubi.invalid", token: "test-token",
              perAgentTokens: { main: "test-token" } },
            presence: { defaultId: "test/openclaw", perAgent: { main: "test/openclaw" } },
          } } },
        },
      };
      const selected = await getActiveMemorySearchManager({ cfg, agentId: "main", purpose: "status" });
      const lexical = await selected.manager?.search("no network", { lexicalOnly: true });
      const unmapped = await getActiveMemorySearchManager({ cfg, agentId: "other", purpose: "status" });
      console.log(JSON.stringify({
        provider: selected.manager?.status().provider,
        source: selected.manager?.status().sources,
        purpose: selected.debug?.purpose,
        lexical,
        unmappedManager: unmapped.manager === null,
      }));
    `;
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
      cwd: repoRoot,
      encoding: "utf8",
      env: { ...process.env, NO_COLOR: "1" },
    });
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    const output = JSON.parse(result.stdout.trim().split("\n").at(-1) ?? "{}");
    expect(output).toEqual({
      provider: "musubi",
      source: ["memory"],
      purpose: "status",
      lexical: [],
      unmappedManager: true,
    });
  }, 20_000);
});
