import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
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
    // npm ci already installed the pinned runtime dependencies. Copy only those
    // into the packed artifact: this models a production install without another
    // registry round trip or installing the OpenClaw peer into the plugin root.
    const manifest = JSON.parse(readFileSync(join(pluginRoot, "package.json"), "utf8"));
    for (const name of Object.keys(manifest.dependencies ?? {})) {
      const source = join(repoRoot, "node_modules", name);
      if (!existsSync(source)) throw new Error(`missing installed runtime dependency: ${name}`);
      const destination = join(pluginRoot, "node_modules", name);
      mkdirSync(join(destination, ".."), { recursive: true });
      cpSync(source, destination, { recursive: true });
    }
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
