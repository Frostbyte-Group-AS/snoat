import assert from "node:assert/strict";
import { describe, it } from "node:test";

/**
 * Wildcard-sertifikater: policyen Caddy får, listen over navn Caddy holder,
 * hvilke navn wildcardet dekker, sjekken av Cloudflare-tokenet, og at tokenet
 * aldri kommer ut gjennom API-et.
 *
 * `await import` fordi `config.ts` avviser et tomt miljø ved import.
 */
process.env.NODE_ENV ??= "test";
process.env.SUPABASE_URL ??= "http://localhost:54321";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "test-service-role";
process.env.SUPABASE_ANON_KEY ??= "test-anon";
process.env.SNOAT_WORKSPACE_DIR ??= "/tmp/snoat-test";

const { coveredBy, toStatus, verifyCloudflareToken, WildcardCertError } = await import("./wildcard-certs.js");
const { mergeAutomateList, wildcardPolicyId, wildcardTlsPolicy } = await import("../lib/caddy.js");

const TOKEN = "cf_test_token_abcdefghijklmnopqrstuvwxyz";

describe("wildcardTlsPolicy", () => {
  it("gir DNS-01 mot Cloudflare for *.domenet, uten on-demand", () => {
    const policy = wildcardTlsPolicy("mittvel.no", { provider: "cloudflare", apiToken: TOKEN }, "drift@example.no");
    assert.deepEqual(policy, {
      "@id": "snoat_wildcard_mittvel.no",
      subjects: ["*.mittvel.no"],
      issuers: [
        {
          module: "acme",
          email: "drift@example.no",
          challenges: { dns: { provider: { name: "cloudflare", api_token: TOKEN } } },
        },
      ],
    });
    assert.equal("on_demand" in policy, false);
  });

  it("utelater e-post når den mangler", () => {
    const policy = wildcardTlsPolicy("mittvel.no", { provider: "cloudflare", apiToken: TOKEN }, undefined);
    assert.equal("email" in (policy.issuers[0] ?? {}), false);
  });

  it("har stabil @id per domene", () => {
    assert.equal(wildcardPolicyId("mittvel.no"), "snoat_wildcard_mittvel.no");
  });
});

describe("mergeAutomateList", () => {
  it("legger til uten duplikater og rører ikke andre navn", () => {
    assert.deepEqual(mergeAutomateList(["a.no"], ["*.mittvel.no"], []), ["a.no", "*.mittvel.no"]);
    assert.deepEqual(mergeAutomateList(["*.mittvel.no"], ["*.mittvel.no"], []), ["*.mittvel.no"]);
  });

  it("fjerner bare det som skal ut", () => {
    assert.deepEqual(mergeAutomateList(["a.no", "*.mittvel.no"], [], ["*.mittvel.no"]), ["a.no"]);
  });

  it("tåler at listen mangler eller er rar", () => {
    assert.deepEqual(mergeAutomateList(undefined, ["*.x.no"], []), ["*.x.no"]);
    assert.deepEqual(mergeAutomateList([1, "a.no"], [], []), ["a.no"]);
  });
});

describe("coveredBy", () => {
  it("dekker nøyaktig én etikett under domenet", () => {
    assert.equal(coveredBy("vel.mittvel.no", "mittvel.no"), true);
    assert.equal(coveredBy("a.b.mittvel.no", "mittvel.no"), false);
    assert.equal(coveredBy("mittvel.no", "mittvel.no"), false);
    assert.equal(coveredBy("vel.ikkemittvel.no", "mittvel.no"), false);
    assert.equal(coveredBy(".mittvel.no", "mittvel.no"), false);
  });
});

describe("toStatus", () => {
  it("viser aldri tokenet", () => {
    const status = toStatus({
      project_id: "p",
      domain: "mittvel.no",
      dns_provider: "cloudflare",
      api_token: TOKEN,
      created_at: "2026-11-23T00:00:00Z",
      updated_at: "2026-11-23T00:00:00Z",
    });
    assert.equal(JSON.stringify(status).includes(TOKEN), false);
    assert.equal(status.wildcard, "*.mittvel.no");
  });
});

describe("verifyCloudflareToken", () => {
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
  const fake =
    (verify: Response, zones: Response) =>
    async (url: string): Promise<Response> =>
      url.includes("/tokens/verify") ? verify.clone() : zones.clone();

  it("godtar et aktivt token som ser sonen", async () => {
    await verifyCloudflareToken(
      TOKEN,
      "mittvel.no",
      fake(json(200, { success: true, result: { status: "active" } }), json(200, { success: true, result: [{ name: "mittvel.no" }] })),
    );
  });

  it("avviser et ugyldig token", async () => {
    await assert.rejects(
      verifyCloudflareToken(TOKEN, "mittvel.no", fake(json(401, { success: false }), json(200, { success: true, result: [] }))),
      (error: unknown) => error instanceof WildcardCertError && error.status === 400,
    );
  });

  it("avviser et token som ikke ser sonen", async () => {
    await assert.rejects(
      verifyCloudflareToken(
        TOKEN,
        "mittvel.no",
        fake(json(200, { success: true, result: { status: "active" } }), json(200, { success: true, result: [{ name: "annet.no" }] })),
      ),
      (error: unknown) => error instanceof WildcardCertError && /ser ikke sonen/.test(error.message),
    );
  });

  it("nettverksfeil gir 502", async () => {
    await assert.rejects(
      verifyCloudflareToken(TOKEN, "mittvel.no", async () => {
        throw new Error("ECONNRESET");
      }),
      (error: unknown) => error instanceof WildcardCertError && error.status === 502,
    );
  });
});
