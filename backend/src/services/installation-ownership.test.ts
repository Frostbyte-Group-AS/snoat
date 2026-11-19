import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { OwnershipFacts } from "./installation-ownership.js";

/**
 * Hvem får koble en GitHub-installasjon til kontoen sin – og, like viktig, hvem
 * får det ikke. Installasjons-ID-er er sekvensielle, så «ID-en finnes hos
 * GitHub» må aldri alene være nok.
 *
 * `await import` av samme grunn som i `plans.test.ts`: `config.ts` avviser et
 * miljø uten de påkrevde variablene allerede ved import.
 */
process.env.NODE_ENV ??= "test";
process.env.SUPABASE_URL ??= "http://localhost:54321";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "test-service-role";
process.env.SUPABASE_ANON_KEY ??= "test-anon";
process.env.SNOAT_WORKSPACE_DIR ??= "/tmp/snoat-test";

const { ownershipReason } = await import("./installation-ownership.js");
const { authenticatedCloneUrl, GithubError } = await import("../lib/github.js");

const NOW = Date.parse("2026-11-19T12:00:00Z");
const MIN = 60_000;

function facts(overrides: Partial<OwnershipFacts> = {}): OwnershipFacts {
  return {
    alreadyLinked: false,
    ownerAccount: false,
    githubUserIds: [],
    installation: { accountType: "Organization", accountId: 999, createdAt: "2025-01-01T00:00:00Z" },
    freshInstallWindowMs: null,
    now: NOW,
    ...overrides,
  };
}

describe("ownershipReason", () => {
  it("avviser en fremmed, gammel org-installasjon – angrepet dette lukker", () => {
    assert.equal(ownershipReason(facts()), null);
    assert.equal(ownershipReason(facts({ freshInstallWindowMs: 30 * MIN })), null);
  });

  it("godtar en kobling kalleren allerede har", () => {
    assert.equal(ownershipReason(facts({ alreadyLinked: true })), "already_linked");
  });

  it("godtar eierkontoen (plattformens egne integrasjoner)", () => {
    assert.equal(ownershipReason(facts({ ownerAccount: true })), "owner_account");
  });

  it("godtar en personlig installasjon på kallerens egen GitHub-konto", () => {
    const own = facts({
      githubUserIds: ["4242"],
      installation: { accountType: "User", accountId: 4242, createdAt: "2025-01-01T00:00:00Z" },
    });
    assert.equal(ownershipReason(own), "github_identity");
  });

  it("avviser en personlig installasjon på en annens GitHub-konto", () => {
    const other = facts({
      githubUserIds: ["4242"],
      installation: { accountType: "User", accountId: 1337, createdAt: "2025-01-01T00:00:00Z" },
    });
    assert.equal(ownershipReason(other), null);
  });

  it("matcher ikke org-ID mot bruker-ID selv om tallene er like", () => {
    const org = facts({
      githubUserIds: ["999"],
      installation: { accountType: "Organization", accountId: 999, createdAt: "2025-01-01T00:00:00Z" },
    });
    assert.equal(ownershipReason(org), null);
  });

  it("godtar en fersk installasjon bare i nettleserflyten, innenfor vinduet", () => {
    const fresh = { accountType: "Organization", accountId: 999, createdAt: new Date(NOW - 5 * MIN).toISOString() };
    assert.equal(ownershipReason(facts({ installation: fresh, freshInstallWindowMs: 30 * MIN })), "fresh_install");
    // Samme installasjon over API-et (ingen signert state) slipper ikke gjennom.
    assert.equal(ownershipReason(facts({ installation: fresh })), null);

    const stale = { ...fresh, createdAt: new Date(NOW - 31 * MIN).toISOString() };
    assert.equal(ownershipReason(facts({ installation: stale, freshInstallWindowMs: 30 * MIN })), null);
  });

  it("avviser når GitHub ikke oppgir opprettelsestid", () => {
    const unknown = { accountType: "Organization", accountId: 999, createdAt: null };
    assert.equal(ownershipReason(facts({ installation: unknown, freshInstallWindowMs: 30 * MIN })), null);
  });
});

describe("authenticatedCloneUrl", () => {
  it("nekter å legge installasjonstokenet i en URL til en annen vert enn github.com", async () => {
    for (const url of [
      "https://gitlab.com/offer/repo.git",
      "https://github.com.angriper.example/x.git",
      "http://github.com/eier/repo.git",
    ]) {
      await assert.rejects(authenticatedCloneUrl(url, 1), GithubError, url);
    }
  });
});

describe("assertSafeApiPath (MCP)", async () => {
  const { assertSafeApiPath } = await import("./mcp-tools.js");

  it("godtar vanlige stier, også med spørrestreng", () => {
    assert.doesNotThrow(() => assertSafeApiPath("/projects/9b58d1df-3eb1-4bfc-80d8-63a63d51370d/deploy"));
    assert.doesNotThrow(() => assertSafeApiPath("/projects/abc/analytics?range=7d"));
  });

  it("stopper punktum-segmenter og kodede varianter", () => {
    for (const path of [
      "/projects/../../api-keys?/deploy",
      "/projects/./x",
      "/projects/%2e%2e/api-keys",
      "/projects/a%2fb",
      "/projects/a\\b",
      "/projects/a#b",
      "projects/x",
    ]) {
      assert.throws(() => assertSafeApiPath(path), Error, path);
    }
  });
});
