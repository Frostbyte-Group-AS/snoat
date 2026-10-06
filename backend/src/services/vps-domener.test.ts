import assert from "node:assert/strict";
import { describe, it } from "node:test";

/**
 * Tester for de rene delene av VPS-domenene: hva et domene blir til, og hva
 * Caddy får.
 *
 * Det som er farlig å få feil: et domene som normaliseres ulikt fra
 * omdirigeringene slipper forbi kollisjonssjekken, en rute uten `www.` gir et
 * halvt domene, og en upstream med feil form gir 502 uten at noe i Snoat sier
 * hvorfor.
 *
 * `await import` av samme grunn som i `plans.test.ts`: `config.ts` avviser et
 * tomt miljø ved import.
 */
process.env.NODE_ENV ??= "test";
process.env.SUPABASE_URL ??= "http://localhost:54321";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "test-service-role";
process.env.SUPABASE_ANON_KEY ??= "test-anon";
process.env.SNOAT_WORKSPACE_DIR ??= "/tmp/snoat-test";
process.env.SNOAT_APP_DOMAIN_SUFFIX = ".snoat.com";

const { gyldigPort, upstreamFor, vpsDomene } = await import("./vps-domener.js");
const { VpsError } = await import("./vps.js");
const { routeCoversHost, vpsRoute } = await import("../lib/caddy.js");

describe("vpsDomene", () => {
  it("normaliserer som omdirigeringene", () => {
    assert.equal(vpsDomene("https://www.Von.osia.no/v1/systemone"), "von.osia.no");
    assert.equal(vpsDomene("  von.osia.no:443 "), "von.osia.no");
  });

  it("avviser Snoats egne navn med en VPS-feil", () => {
    assert.throws(
      () => vpsDomene("von.snoat.com"),
      (error: unknown) => error instanceof VpsError && error.code === "vps.platform_domain" && /kobles til en VPS/.test(error.message),
    );
  });

  it("avviser ting som ikke er domener", () => {
    for (const raw of ["localhost", "10.10.10.100", "ikke et domene", ""]) {
      assert.throws(() => vpsDomene(raw), VpsError, raw);
    }
  });
});

describe("port og upstream", () => {
  it("godtar bare heltall 1–65535", () => {
    assert.ok(gyldigPort(8000));
    for (const port of [0, 65536, 80.5, "8000", null]) assert.equal(gyldigPort(port), false, String(port));
  });

  it("upstream er ip:port", () => {
    assert.equal(upstreamFor("10.10.10.100", 8000), "10.10.10.100:8000");
  });
});

describe("vpsRoute", () => {
  it("sender domenet og www. videre til VPS-en", () => {
    const route = vpsRoute("abc", "von.osia.no", "10.10.10.100:8000");
    assert.deepEqual(route, {
      "@id": "snoat_vps_abc",
      match: [{ host: ["von.osia.no", "www.von.osia.no"] }],
      handle: [{ handler: "reverse_proxy", upstreams: [{ dial: "10.10.10.100:8000" }] }],
      terminal: true,
    });
    assert.ok(routeCoversHost(route, "von.osia.no"));
    assert.ok(routeCoversHost(route, "www.von.osia.no"));
    assert.equal(routeCoversHost(route, "osia.no"), false);
  });

  it("har et annet prefiks enn omdirigeringene, så oppryddingen ikke tar feil ruter", () => {
    assert.ok(String(vpsRoute("x", "a.no", "1.2.3.4:1")["@id"]).startsWith("snoat_vps_"));
  });
});
