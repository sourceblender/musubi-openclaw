import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Exercise the plugin as a package, with OpenClaw outside its root. OpenClaw
 * 2026.9.6 treats bundled plugins inside a linked package's node_modules as
 * conflicting children of that package. A development checkout has OpenClaw as
 * a dev dependency; a published package does not.
 */
export function packPluginForHostTest(repoRoot: string): {
  pluginRoot: string;
  cleanup: () => void;
} {
  const stage = mkdtempSync(join(tmpdir(), "musubi-openclaw-packed-"));
  try {
    const archive = execFileSync("npm", ["pack", "--silent", "--pack-destination", stage], {
      cwd: repoRoot,
      encoding: "utf8",
    }).trim();
    execFileSync("tar", ["-xzf", join(stage, archive), "-C", stage]);
    const pluginRoot = join(stage, "package");
    const installEnv = { ...process.env };
    // A parent `npm test` may export its own project-scoped allowScripts list.
    // Passing it into this different package makes npm reject the install.
    delete installEnv.npm_config_allow_scripts;
    delete installEnv.npm_config_local_prefix;
    execFileSync(
      "npm",
      ["install", "--offline", "--omit=dev", "--legacy-peer-deps", "--no-audit", "--no-fund"],
      { cwd: pluginRoot, env: installEnv, stdio: "pipe" },
    );
    if (!existsSync(join(pluginRoot, "dist/index.js"))) {
      throw new Error("packed plugin is missing dist/index.js; run the build first");
    }
    if (existsSync(join(pluginRoot, "node_modules/openclaw"))) {
      throw new Error("packed plugin unexpectedly contains the OpenClaw host");
    }
    return {
      pluginRoot,
      cleanup: () => rmSync(stage, { recursive: true, force: true }),
    };
  } catch (error) {
    rmSync(stage, { recursive: true, force: true });
    throw error;
  }
}
