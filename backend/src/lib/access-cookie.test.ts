import assert from "node:assert/strict";
import { describe, it } from "node:test";

/**
 * `access-cookie.ts` drar med seg `config.ts`, som avviser et tomt miljø ved
 * import – samme grunn til `await import` som i `services/plans.test.ts`.
 */
process.env.NODE_ENV ??= "test";
process.env.SUPABASE_URL ??= "http://localhost:54321";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "test-service-role";
process.env.SUPABASE_ANON_KEY ??= "test-anon";
process.env.SNOAT_WORKSPACE_DIR ??= "/tmp/snoat-test";

const { accessCookieTtlSeconds, accessVersion, issueAccessToken, verifyAccessToken } = await import(
  "./access-cookie.js"
);

const P = "11111111-1111-4111-8111-111111111111";
const V = accessVersion("$2b$12$etthashetpassord");

describe("adgangscookien", () => {
  it("verifiserer et token den nettopp utstedte, for samme prosjekt, vert og passord", () => {
    const token = issueAccessToken(P, "app.snoat.com", V);
    assert.equal(verifyAccessToken(token, P, "app.snoat.com", V), true);
  });

  it("avviser tokenet på et annet vertsnavn", () => {
    const token = issueAccessToken(P, "app.snoat.com", V);
    assert.equal(verifyAccessToken(token, P, "annen-app.snoat.com", V), false);
  });

  it("avviser tokenet for et annet prosjekt på samme vert", () => {
    const token = issueAccessToken(P, "app.snoat.com", V);
    assert.equal(verifyAccessToken(token, "22222222-2222-4222-8222-222222222222", "app.snoat.com", V), false);
  });

  it("avviser tokenet etter at passordet er byttet", () => {
    const token = issueAccessToken(P, "app.snoat.com", V);
    const nyVersjon = accessVersion("$2b$12$etnyttpassord");
    assert.notEqual(nyVersjon, V);
    assert.equal(verifyAccessToken(token, P, "app.snoat.com", nyVersjon), false);
  });

  it("avviser et utløpt token, og et med utløp lenger fram enn vi utsteder", () => {
    const now = Date.now();
    const token = issueAccessToken(P, "app.snoat.com", V, now);
    const etterUtlop = now + (accessCookieTtlSeconds() + 1) * 1000;
    assert.equal(verifyAccessToken(token, P, "app.snoat.com", V, etterUtlop), false);

    const [, signatur] = token.split(".");
    const forLangt = `${Math.floor(now / 1000) + 10 * accessCookieTtlSeconds()}.${signatur}`;
    assert.equal(verifyAccessToken(forLangt, P, "app.snoat.com", V, now), false);
  });

  it("avviser et token med endret utløp (signaturen dekker det)", () => {
    const token = issueAccessToken(P, "app.snoat.com", V);
    const [utlop, signatur] = token.split(".") as [string, string];
    const endret = `${Number(utlop) + 60}.${signatur}`;
    assert.equal(verifyAccessToken(endret, P, "app.snoat.com", V), false);
  });

  it("avviser søppel", () => {
    for (const token of ["", "bare-en-streng", "a.b.c", "1.", ".abc", "-1.abc", "1e9.abc"]) {
      assert.equal(verifyAccessToken(token, P, "app.snoat.com", V), false, token);
    }
  });

  it("har ikke prosjekt-ID-en i klartekst", () => {
    const token = issueAccessToken(P, "app.snoat.com", V);
    assert.match(token, /^\d+\.[A-Za-z0-9_-]+$/);
    assert.ok(!token.includes(P));
  });

  it("gir en fast versjon uten hash, og den er ulik enhver ekte", () => {
    assert.equal(accessVersion(null), accessVersion(null));
    assert.notEqual(accessVersion(null), V);
    assert.match(V, /^[0-9a-f]{32}$/);
  });
});
