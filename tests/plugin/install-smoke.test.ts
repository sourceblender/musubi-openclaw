import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const openclaw = resolve(repoRoot, "node_modules/.bin/openclaw");

describe("native OpenClaw installation", () => {
  it("installs from a local plugin directory, then activates as the memory slot", () => {
    const home = mkdtempSync(join(tmpdir(), "musubi-openclaw-install-"));
    const configPath = join(home, "openclaw.json");
    const env = {
      HOME: home,
      PATH: process.env.PATH ?? "",
      OPENCLAW_CONFIG_PATH: configPath,
      OPENCLAW_STATE_DIR: home,
      NO_COLOR: "1",
    };
    try {
      // The host rejects a memory slot before it knows the plugin. Start
      // with a valid empty profile and install the reviewed local source.
      writeFileSync(configPath, "{}");
      const install = spawnSync(
        openclaw,
        ["plugins", "install", "-l", repoRoot, "--force", "--accept-capabilities"],
        { cwd: repoRoot, env, encoding: "utf8" },
      );
      expect(install.status, `${install.stdout}\n${install.stderr}`).toBe(0);
      const saved = JSON.parse(readFileSync(configPath, "utf8"));
      expect(saved.plugins.load.paths).toContain(repoRoot);
      expect(saved.plugins.entries.musubi.enabled).toBe(false);

      saved.plugins.allow = ["musubi"];
      saved.plugins.slots = { memory: "musubi" };
      saved.plugins.entries.musubi = {
        enabled: true,
        hooks: { allowConversationAccess: true },
        config: {
          core: { baseUrl: "https://musubi.invalid", token: "install-probe-token" },
          presence: { defaultId: "probe/openclaw" },
        },
      };
      writeFileSync(configPath, JSON.stringify(saved));

      const inspect = spawnSync(openclaw, ["plugins", "inspect", "musubi", "--runtime", "--json"], {
        cwd: repoRoot,
        env,
        encoding: "utf8",
      });
      expect(inspect.status, `${inspect.stdout}\n${inspect.stderr}`).toBe(0);
      const runtime = JSON.parse(inspect.stdout);
      expect(runtime.plugin.status).toBe("loaded");
      expect(runtime.plugin.kind).toBe("memory");
      expect(runtime.plugin.toolNames).toEqual(
        expect.arrayContaining(["memory_search", "memory_get", "memory_store"]),
      );
      expect(runtime.typedHooks).toEqual(expect.arrayContaining([{ name: "agent_end" }]));
      expect(runtime.typedHooks).toEqual(expect.arrayContaining([{ name: "before_prompt_build" }]));
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 30_000);
});
