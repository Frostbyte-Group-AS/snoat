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

const { guardedHandlers, routeIsProtected, routeRoot, routeUpstream, SHARE_PARAM, toGuard } = await import(
  "./caddy.js"
);

const app = [{ handler: "reverse_proxy", upstreams: [{ dial: "snoat-app:3000" }] }];
const now = new Date("2026-11-20T12:00:00Z");
const token = "abcdefghijklmnopqrstuvwx";

type Route = { match?: Array<Record<string, any>>; handle: Array<Record<string, any>>; terminal?: boolean };

describe("guardedHandlers", () => {
  it("lar en åpen app være uendret", () => {
    assert.deepEqual(guardedHandlers(null, app, now), app);
  });

  it("setter passordvakten først uten delelenker", () => {
    const handlers = guardedHandlers(toGuard("$2a$12$hash"), app, now);
    assert.equal(handlers[0]?.handler, "authentication");
    assert.deepEqual(handlers.slice(1), app);
  });

  it("slipper inn på token i URL og i informasjonskapsel, og faller ellers til passord", () => {
    const expiresAt = new Date(now.getTime() + 60 * 60_000);
    const [subroute] = guardedHandlers({ hash: "$2a$12$hash", shareTokens: [{ token, expiresAt }] }, app, now);
    assert.equal(subroute?.handler, "subroute");

    const routes = subroute?.routes as Route[];
    assert.equal(routes.length, 3);

    const [viaQuery, viaCookie, fallback] = routes as [Route, Route, Route];
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
    assert.equal(fallback.handle[0]?.handler, "authentication");
  });

  it("tar ikke med utløpte eller utrygge tokener", () => {
    const handlers = guardedHandlers(
      {
        hash: "$2a$12$hash",
        shareTokens: [
          { token, expiresAt: new Date(now.getTime() - 1) },
          { token: "kort", expiresAt: new Date(now.getTime() + 60_000) },
          { token: `${token}"; evil`, expiresAt: new Date(now.getTime() + 60_000) },
        ],
      },
      app,
      now,
    );
    assert.equal(handlers[0]?.handler, "authentication");
    assert.equal(handlers.length, 1 + app.length);
  });

  it("lar ruteleserne finne upstream, root og beskyttelse i den nye formen", () => {
    const expiresAt = new Date(now.getTime() + 60_000);
    const handle = guardedHandlers({ hash: "$2a$12$hash", shareTokens: [{ token, expiresAt }] }, app, now);
    const route = { "@id": "snoat_app_x", match: [{ host: ["x.snoat.com"] }], handle, terminal: true };
    assert.equal(routeUpstream(route), "snoat-app:3000");
    assert.equal(routeIsProtected(route), true);

    const statisk = [{ handler: "vars", root: "/srv/sites/x" }, { handler: "file_server" }];
    const statiskRute = {
      "@id": "snoat_app_x",
      match: [{ host: ["x.snoat.com"] }],
      handle: guardedHandlers({ hash: "$2a$12$hash", shareTokens: [{ token, expiresAt }] }, statisk, now),
      terminal: true,
    };
    assert.equal(routeRoot(statiskRute), "/srv/sites/x");
  });
});
