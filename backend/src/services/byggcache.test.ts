import assert from "node:assert/strict";
import { describe, it } from "node:test";

process.env.NODE_ENV ??= "test";
process.env.SUPABASE_URL ??= "http://localhost:54321";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "test-service-role";
process.env.SUPABASE_ANON_KEY ??= "test-anon";
process.env.SNOAT_WORKSPACE_DIR ??= "/tmp/snoat-test";

const { buildPruneQuery } = await import("./byggcache.js");

describe("buildPruneQuery", () => {
  it("sender taket i bytes for både ny og gammel Docker-API", () => {
    // Uten taket tømmer `/build/prune` hele cachen, og neste bygg starter fra null.
    assert.deepEqual(buildPruneQuery(20), {
      "max-used-space": "21474836480",
      "keep-storage": "21474836480",
    });
  });
});
