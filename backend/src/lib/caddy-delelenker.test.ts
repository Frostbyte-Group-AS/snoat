import assert from "node:assert/strict";
import { describe, it } from "node:test";

/**
 * Vakten foran en beskyttet app med delelenker (migrasjon 0023): formen Caddy
 * får, og at utløpte eller utrygge tokener aldri havner i ruten.
 */
process.env.NODE_ENV ??= "test";
process.env.SUPABASE_URL ??= "http://localhost:54321";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "test-service-role";
process.env.SUPABASE_ANON_KEY ??= "test-anon";
process.env.SNOAT_WORKSPACE_DIR ??= "/tmp/snoat-test";
process.env.SNOAT_APP_DOMAIN_SUFFIX = ".snoat.com";

const {
  ACCESS_GATE_PATH,
  ACCESS_HEADERS,
  accessGateUpstream,
  guardedHandlers,
  routeIsProtected,
  routeRoot,
  routeUpstream,
  SHARE_PARAM,
} = await import("./caddy.js");

const app = [{ handler: "reverse_proxy", upstreams: [{ dial: "snoat-app:3000" }] }];
const now = new Date("2026-11-20T12:00:00Z");
const token = "abcdefghijklmnopqrstuvwx";
const guard = (shareTokens: Array<{ token: string; expiresAt: Date }> = []) => ({
  projectId: "11111111-1111-4111-8111-111111111111",
  version: "0123456789abcdef0123456789abcdef",
  shareTokens,
});

type Route = { match?: Array<Record<string, any>>; handle: Array<Record<string, any>>; terminal?: boolean };

describe("guardedHandlers", () => {
  it("lar en åpen app være uendret", () => {
    assert.deepEqual(guardedHandlers(null, app, now), app);
  });

  it("uten delelenker: passordsiden, så sjekken foran appen", () => {
    const [subroute, ...rest] = guardedHandlers(guard(), app, now);
    assert.equal(rest.length, 0);
    assert.equal(subroute?.handler, "subroute");

    const routes = subroute?.routes as Route[];
    assert.equal(routes.length, 2);
    const [side, fallback] = routes as [Route, Route];

    assert.deepEqual(side.match, [{ path: [ACCESS_GATE_PATH] }]);
    assert.equal(side.terminal, true);
    assert.equal(side.handle.length, 2);
    assert.deepEqual(side.handle[0], { handler: "request_body", max_size: 16 * 1024 });
    assert.equal(side.handle[1]?.handler, "reverse_proxy");
    assert.equal(side.handle[1]?.upstreams[0].dial, accessGateUpstream());
    assert.equal(side.handle[1]?.rewrite, undefined, "siden skal få metode og body uendret");

    assert.equal(fallback.match, undefined);
    const sjekk = fallback.handle[0]!;
    assert.equal(sjekk.handler, "reverse_proxy");
    assert.equal(sjekk.upstreams[0].dial, accessGateUpstream());
    // GET til sjekken: Caddy sender da ikke med bodyen, så appen får den.
    assert.equal(sjekk.rewrite.method, "GET");
    assert.deepEqual(sjekk.handle_response, [{ match: { status_code: [2] }, routes: [] }]);
    assert.deepEqual(fallback.handle.slice(1), app);

    // Headerne settes (overskriver klientens), og bærer prosjekt og versjon.
    const set = sjekk.headers.request.set as Record<string, string[]>;
    assert.deepEqual(set[ACCESS_HEADERS.project], ["11111111-1111-4111-8111-111111111111"]);
    assert.deepEqual(set[ACCESS_HEADERS.version], ["0123456789abcdef0123456789abcdef"]);
    assert.deepEqual(set[ACCESS_HEADERS.host], ["{http.request.host}"]);
    assert.deepEqual(set[ACCESS_HEADERS.uri], ["{http.request.orig_uri}"]);
    assert.deepEqual(set[ACCESS_HEADERS.clientIp], ["{http.request.client_ip}"]);
    assert.equal(sjekk.headers.request.add, undefined);

    // Ingenting av passordet står i Caddy.
    assert.ok(!JSON.stringify(subroute).includes("$2"));
    assert.ok(!JSON.stringify(subroute).includes("http_basic"));
  });

  it("slipper inn på token i URL og i informasjonskapsel, og faller ellers til passord", () => {
    const expiresAt = new Date(now.getTime() + 60 * 60_000);
    const [subroute] = guardedHandlers(guard([{ token, expiresAt }]), app, now);
    assert.equal(subroute?.handler, "subroute");

    const routes = subroute?.routes as Route[];
    assert.equal(routes.length, 4);

    const [side, viaQuery, viaCookie, fallback] = routes as [Route, Route, Route, Route];
    assert.deepEqual(side.match, [{ path: [ACCESS_GATE_PATH] }]);
    assert.deepEqual(viaQuery.match, [{ query: { [SHARE_PARAM]: [token] } }]);
    const cookie = viaQuery.handle[0]?.response.add["Set-Cookie"][0] as string;
    assert.match(cookie, new RegExp(`^${SHARE_PARAM}=${token}; Path=/; Max-Age=3600; HttpOnly; Secure; SameSite=Lax$`));
    assert.deepEqual(viaQuery.handle.slice(1), app);

    const pattern = viaCookie.match?.[0]?.header_regexp.Cookie.pattern as string;
    assert.ok(new RegExp(pattern).test(`a=1; ${SHARE_PARAM}=${token}`));
    assert.ok(new RegExp(pattern).test(`${SHARE_PARAM}=${token}`));
    assert.ok(!new RegExp(pattern).test(`${SHARE_PARAM}=${token}x`));
    assert.ok(!new RegExp(pattern).test(`x${SHARE_PARAM}=${token}`));
    assert.deepEqual(viaCookie.handle, app);

    assert.equal(fallback.match, undefined);
    assert.equal(fallback.handle[0]?.upstreams[0].dial, accessGateUpstream());
    assert.deepEqual(fallback.handle.slice(1), app);
  });

  it("tar ikke med utløpte eller utrygge tokener", () => {
    const handlers = guardedHandlers(
      guard([
        { token, expiresAt: new Date(now.getTime() - 1) },
        { token: "kort", expiresAt: new Date(now.getTime() + 60_000) },
        { token: `${token}"; evil`, expiresAt: new Date(now.getTime() + 60_000) },
      ]),
      app,
      now,
    );
    assert.equal(handlers.length, 1);
    assert.equal((handlers[0]?.routes as Route[]).length, 2);
  });

  it("lar ruteleserne finne upstream, root og beskyttelse i den nye formen", () => {
    const expiresAt = new Date(now.getTime() + 60_000);
    const handle = guardedHandlers(guard([{ token, expiresAt }]), app, now);
    const route = { "@id": "snoat_app_x", match: [{ host: ["x.snoat.com"] }], handle, terminal: true };
    assert.equal(routeUpstream(route), "snoat-app:3000");
    assert.equal(routeIsProtected(route), true);

    const statisk = [{ handler: "vars", root: "/srv/sites/x" }, { handler: "file_server" }];
    const statiskRute = {
      "@id": "snoat_app_x",
      match: [{ host: ["x.snoat.com"] }],
      handle: guardedHandlers(guard([{ token, expiresAt }]), statisk, now),
      terminal: true,
    };
    assert.equal(routeRoot(statiskRute), "/srv/sites/x");
  });

  it("routeUpstream hopper over vakten – også uten delelenker, der vakten står først", () => {
    const route = {
      "@id": "snoat_app_x",
      match: [{ host: ["x.snoat.com"] }],
      handle: guardedHandlers(guard(), app, now),
      terminal: true,
    };
    assert.equal(routeUpstream(route), "snoat-app:3000");
    assert.equal(routeIsProtected(route), true);

    const statisk = [{ handler: "vars", root: "/srv/sites/x" }, { handler: "file_server" }];
    const statiskRute = { "@id": "snoat_app_x", match: [], handle: guardedHandlers(guard(), statisk, now), terminal: true };
    assert.equal(routeUpstream(statiskRute), null, "en statisk side har ingen upstream, vakten teller ikke");
    assert.equal(routeRoot(statiskRute), "/srv/sites/x");
  });

  it("kjenner igjen den gamle http_basic-vakten som beskyttet, så migreringen kan ses", () => {
    const gammel = {
      "@id": "snoat_app_x",
      match: [],
      terminal: true,
      handle: [{ handler: "authentication", providers: { http_basic: {} } }, ...app],
    };
    assert.equal(routeIsProtected(gammel), true);
    assert.equal(routeUpstream(gammel), "snoat-app:3000");
    assert.equal(routeIsProtected({ "@id": "snoat_app_x", match: [], handle: app, terminal: true }), false);
  });
});
