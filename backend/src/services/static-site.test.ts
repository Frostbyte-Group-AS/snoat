import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

/**
 * Symlenker i en statisk side må ikke kunne peke ut av den publiserte katalogen:
 * Caddy følger dem, og TLS-nøklene ligger i samme container.
 */
process.env.NODE_ENV ??= "test";
process.env.SUPABASE_URL ??= "http://localhost:54321";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "test-service-role";
process.env.SUPABASE_ANON_KEY ??= "test-anon";
process.env.SNOAT_WORKSPACE_DIR ??= "/tmp/snoat-test";

const { removeEscapingSymlinks } = await import("./static-site.js");

async function exists(p: string): Promise<boolean> {
  return lstat(p).then(
    () => true,
    () => false,
  );
}

describe("removeEscapingSymlinks", () => {
  it("fjerner lenker ut av katalogen og lar interne lenker stå", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "snoat-static-"));
    try {
      await mkdir(path.join(root, "assets", "img"), { recursive: true });
      await writeFile(path.join(root, "index.html"), "<h1>hei</h1>");
      await symlink("/data/caddy/certificates/snoat.com.key", path.join(root, "k"));
      await symlink("../../../../etc/passwd", path.join(root, "assets", "img", "p"));
      await symlink("../index.html", path.join(root, "assets", "home.html"));
      await symlink(path.join(root, "index.html"), path.join(root, "abs-inside.html"));

      const removed = (await removeEscapingSymlinks(root)).sort();

      assert.deepEqual(removed, [path.join("assets", "img", "p"), "k"].sort());
      assert.equal(await exists(path.join(root, "k")), false);
      assert.equal(await exists(path.join(root, "assets", "img", "p")), false);
      assert.equal(await exists(path.join(root, "assets", "home.html")), true);
      assert.equal(await exists(path.join(root, "abs-inside.html")), true);
      assert.equal(await exists(path.join(root, "index.html")), true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fjerner en lenke til en nabokatalog med samme prefiks", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "snoat-static-"));
    try {
      await symlink(`${root}-annen/fil`, path.join(root, "x"));
      assert.deepEqual(await removeEscapingSymlinks(root), ["x"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
