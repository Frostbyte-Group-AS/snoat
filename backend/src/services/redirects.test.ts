import assert from "node:assert/strict";
import { describe, it } from "node:test";

/**
 * Tester for de rene delene av omdirigeringene: hva et domene og et mål blir til,
 * og hva Caddy får.
 *
 * Det som testes her er det som er farlig å få feil: et domene som normaliseres
 * ulikt på lagring og oppslag gir et sertifikat som aldri utstedes, en løkke gir
 * «for mange omdirigeringer» i nettleseren, og en `{` i målet kunne fått Caddy
 * til å skrive ut miljøvariablene sine i `Location`-headeren.
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

const { RedirectError, assertValidDomain, normalizeDomain, normalizeTargetUrl } = await import("./redirects.js");
const { redirectHosts, redirectLocation, routeCoversHost } = await import("../lib/caddy.js");
const { scopeAllowsPath } = await import("../middleware/auth.js");

describe("normalizeDomain", () => {
  it("tar bort skjema, sti, port, www og store bokstaver", () => {
    assert.equal(normalizeDomain("https://www.Gammelt.no/om-oss?x=1"), "gammelt.no");
    assert.equal(normalizeDomain("  gammelt.no:443  "), "gammelt.no");
    assert.equal(normalizeDomain("gammelt.no."), "gammelt.no");
  });

  it("gjør norske tegn om til punycode", () => {
    assert.equal(normalizeDomain("blåbær.no"), "xn--blbr-roah.no");
  });

  it("lar subdomener stå", () => {
    assert.equal(normalizeDomain("kampanje.gammelt.no"), "kampanje.gammelt.no");
  });
});

describe("assertValidDomain", () => {
  it("godtar vanlige domener", () => {
    assert.equal(assertValidDomain("bedriftshjerne.no"), "bedriftshjerne.no");
  });

  it("avviser ting som ikke er domener", () => {
    for (const raw of ["localhost", "1.2.3.4", "ikke et domene", "-a.no", "a..no", ""]) {
      assert.throws(() => assertValidDomain(raw), RedirectError, raw);
    }
  });

  it("avviser Snoats egne navn", () => {
    for (const raw of ["snoat.com", "osia.snoat.com", "api.snoat.com"]) {
      assert.throws(() => assertValidDomain(raw), /hører til Snoat/, raw);
    }
  });
});

describe("normalizeTargetUrl", () => {
  it("godtar http og https", () => {
    assert.equal(
      normalizeTargetUrl("https://osia.no/artikler/hva-er-en-bedriftshjerne"),
      "https://osia.no/artikler/hva-er-en-bedriftshjerne",
    );
    assert.equal(normalizeTargetUrl("http://nytt.no"), "http://nytt.no/");
  });

  it("avviser andre skjemaer, relative adresser og innlogging i URL-en", () => {
    for (const raw of ["javascript:alert(1)", "ftp://x.no", "/relativ", "https://bruker:pass@x.no"]) {
      assert.throws(() => normalizeTargetUrl(raw), RedirectError, raw);
    }
  });

  it("koder klammeparenteser, så Caddy ikke tolker dem som plassholdere", () => {
    const href = normalizeTargetUrl("https://nytt.no/?q={env.SUPABASE_SERVICE_ROLE_KEY}#{http.request.host}");
    assert.ok(!href.includes("{") && !href.includes("}"), href);
    assert.match(href, /%7Benv\.SUPABASE_SERVICE_ROLE_KEY%7D/);
  });
});

describe("Caddy-ruten", () => {
  it("dekker www-varianten av hvert domene, uten duplikater", () => {
    assert.deepEqual(redirectHosts(["a.no", "b.no", "a.no"]), ["a.no", "www.a.no", "b.no", "www.b.no"]);
  });

  it("sender alt til målet når stien ikke skal følge med", () => {
    assert.equal(redirectLocation("https://nytt.no/side", false), "https://nytt.no/side");
  });

  it("henger på sti og spørring uten dobbel skråstrek når stien skal følge med", () => {
    assert.equal(redirectLocation("https://nytt.no/", true), "https://nytt.no{http.request.uri}");
    assert.equal(redirectLocation("https://nytt.no/blogg", true), "https://nytt.no/blogg{http.request.uri}");
  });

  it("vet hvilke vertsnavn en rute svarer på", () => {
    const route = { "@id": "x", match: [{ host: ["a.no", "*.b.no"] }], handle: [], terminal: true };
    assert.equal(routeCoversHost(route, "a.no"), true);
    assert.equal(routeCoversHost(route, "x.b.no"), true);
    assert.equal(routeCoversHost(route, "b.no"), false);
    assert.equal(routeCoversHost(route, "y.x.b.no"), false);
    assert.equal(routeCoversHost(null, "a.no"), false);
  });
});

describe("avgrensede API-nøkler", () => {
  it("slipper en redirects-nøkkel inn på omdirigeringene, utenfra og fra MCP", () => {
    for (const path of ["/api/redirects", "/api/redirects/", "/api/redirects/abc/status", "/redirects/abc"]) {
      assert.equal(scopeAllowsPath("redirects", path), true, path);
    }
  });

  it("stenger alt annet, også nøkkelutstedelsen", () => {
    for (const path of ["/api/api-keys", "/api/projects", "/api/redirectsx", "/api/vps", "/projects/abc/domain"]) {
      assert.equal(scopeAllowsPath("redirects", path), false, path);
    }
  });
});
