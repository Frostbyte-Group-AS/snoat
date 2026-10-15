import assert from "node:assert/strict";
import { describe, it } from "node:test";

/**
 * Rekkefølgen på apprutene: en rute med et eksakt vertsnavn må stå foran en
 * wildcard-rute som også dekker navnet, ellers blir den aldri nådd.
 */
process.env.NODE_ENV ??= "test";
process.env.SUPABASE_URL ??= "http://localhost:54321";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "test-service-role";
process.env.SUPABASE_ANON_KEY ??= "test-anon";
process.env.SNOAT_WORKSPACE_DIR ??= "/tmp/snoat-test";
process.env.SNOAT_APP_DOMAIN_SUFFIX = ".snoat.com";

const { indeksForanDekkendeWildcard } = await import("./caddy.js");

const rute = (id: string, host: string[]) => ({ "@id": id, match: [{ host }] });

describe("indeksForanDekkendeWildcard", () => {
  it("flytter en dev-side foran prosjektet som eier *.domenet", () => {
    const routes = [
      rute("snoat_redirect_a", ["gammelt.no", "www.gammelt.no"]),
      rute("snoat_app_mittvel", ["mittvel.snoat.com", "mittvel.no", "*.mittvel.no"]),
      rute("snoat_app_osia", ["osia.snoat.com", "osia.no", "*.osia.no"]),
      rute("snoat_app_mittvel-main", ["mittvel-main.snoat.com", "main.mittvel.snoat.com", "sudo.mittvel.no", "*.sudo.mittvel.no"]),
    ];
    assert.equal(indeksForanDekkendeWildcard(routes, "snoat_app_mittvel-main"), 1);
  });

  it("lar ruten stå når den alt står foran", () => {
    const routes = [
      rute("snoat_app_mittvel-main", ["sudo.mittvel.no"]),
      rute("snoat_app_mittvel", ["mittvel.no", "*.mittvel.no"]),
    ];
    assert.equal(indeksForanDekkendeWildcard(routes, "snoat_app_mittvel-main"), null);
  });

  it("flytter ikke prosjektet bak sin egen wildcard", () => {
    const routes = [rute("snoat_app_mittvel", ["mittvel.no", "*.mittvel.no"])];
    assert.equal(indeksForanDekkendeWildcard(routes, "snoat_app_mittvel"), null);
  });

  it("wildcard dekker bare én etikett, som Caddy", () => {
    const routes = [
      rute("snoat_app_mittvel", ["mittvel.no", "*.mittvel.no"]),
      rute("snoat_app_dyp", ["a.b.mittvel.no"]),
    ];
    assert.equal(indeksForanDekkendeWildcard(routes, "snoat_app_dyp"), null);
  });

  it("ignorerer ruter uten treff og ukjente id-er", () => {
    const routes = [rute("snoat_app_a", ["a.no", "*.a.no"]), rute("snoat_app_b", ["b.no"])];
    assert.equal(indeksForanDekkendeWildcard(routes, "snoat_app_b"), null);
    assert.equal(indeksForanDekkendeWildcard(routes, "finnes_ikke"), null);
  });

  it("en rute med samme eksakte navn teller ikke som dekkende wildcard", () => {
    const routes = [
      rute("snoat_app_a", ["x.no", "*.x.no"]),
      rute("snoat_app_b", ["x.no"]),
    ];
    assert.equal(indeksForanDekkendeWildcard(routes, "snoat_app_b"), null);
  });
});
