import assert from "node:assert/strict";
import { describe, it } from "node:test";

/**
 * Tester for de rene delene av teamet: hva en e-postadresse blir til, hva som
 * vises til feil konto, og når en invitasjon regnes som utløpt.
 *
 * E-posten er det invitasjonen godtas på. Normaliseres den ulikt ved utsendelse
 * og ved godtak, kan riktig mottaker aldri godta – og slipper en ugyldig adresse
 * gjennom her, svarer Postgres 500 på check-constrainten i stedet for 400.
 *
 * `await import` av samme grunn som i `plans.test.ts`: `config.ts` avviser et
 * tomt miljø ved import.
 */
process.env.NODE_ENV ??= "test";
process.env.SUPABASE_URL ??= "http://localhost:54321";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "test-service-role";
process.env.SUPABASE_ANON_KEY ??= "test-anon";
process.env.SNOAT_WORKSPACE_DIR ??= "/tmp/snoat-test";

const { invitationStatus, maskEmail, normalizeEmail } = await import("./team.js");

describe("normalizeEmail", () => {
  it("fjerner mellomrom og gjør alt til små bokstaver", () => {
    assert.equal(normalizeEmail("  Ola.Nordmann@Firma.NO "), "ola.nordmann@firma.no");
  });

  it("avviser det som ikke er en adresse", () => {
    for (const value of ["", "ola", "ola@", "@firma.no", "ola@firma", "ola nordmann@firma.no", 42, null]) {
      assert.equal(normalizeEmail(value), null, String(value));
    }
  });

  it("avviser adresser lengre enn 254 tegn", () => {
    assert.equal(normalizeEmail(`${"a".repeat(250)}@x.no`), null);
  });
});

describe("maskEmail", () => {
  it("viser første tegn og domenet", () => {
    assert.equal(maskEmail("ola.nordmann@firma.no"), "o•••@firma.no");
  });
});

describe("invitationStatus", () => {
  const base = {
    id: "i",
    project_id: "p",
    email: "a@b.no",
    invited_by: null,
    created_at: "2026-01-01T00:00:00Z",
    sent_at: "2026-01-01T00:00:00Z",
    accepted_at: null,
    accepted_by: null,
    revoked_at: null,
  };
  const now = Date.parse("2026-01-10T00:00:00Z");

  it("er åpen fram til utløpet", () => {
    assert.equal(
      invitationStatus({ ...base, expires_at: "2026-01-15T00:00:00Z", declined_at: null }, now),
      "pending",
    );
  });

  it("er utløpt fra og med utløpstidspunktet", () => {
    assert.equal(
      invitationStatus({ ...base, expires_at: "2026-01-10T00:00:00Z", declined_at: null }, now),
      "expired",
    );
  });

  it("et avslag vinner over utløp", () => {
    assert.equal(
      invitationStatus(
        { ...base, expires_at: "2026-01-05T00:00:00Z", declined_at: "2026-01-02T00:00:00Z" },
        now,
      ),
      "declined",
    );
  });
});
