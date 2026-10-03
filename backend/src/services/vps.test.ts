import assert from "node:assert/strict";
import { describe, it } from "node:test";

/**
 * Tester for de rene delene av VPS-funksjonen og de ekstra domenesuffiksene.
 *
 * RAM-regnestykket er det viktigste: reservasjonen er det som hindrer at én VPS
 * spiser hele verten. Leses den feil – en tom kommentar blir 0, eller et tall
 * under minimum slipper gjennom – kan VPS-gruppen ta minnet Snoat-plattformen
 * lever av. `await import` av samme grunn som i plans.test.ts: config.ts avviser
 * et tomt miljø ved import.
 */
process.env.NODE_ENV ??= "test";
process.env.SUPABASE_URL ??= "http://localhost:54321";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "test-service-role";
process.env.SUPABASE_ANON_KEY ??= "test-anon";
process.env.SNOAT_WORKSPACE_DIR ??= "/tmp/snoat-test";
process.env.SNOAT_APP_DOMAIN_SUFFIX = ".snoat.com";
process.env.SNOAT_EXTRA_APP_DOMAIN_SUFFIXES = " 88-99-100-186.sslip.io, ,.88-99-100-186.sslip.io";

const vps = await import("./vps.js");
const caddy = await import("../lib/caddy.js");

describe("RAM-reservasjonen", () => {
  it("leser tallet fra poolkommentaren", () => {
    assert.equal(vps.parseReservert("VPS-er for eier. ram-reservert-mb=57344"), 57344);
  });

  it("faller tilbake til standarden når tallet mangler – aldri til 0", () => {
    assert.equal(vps.parseReservert(""), 57344);
    assert.equal(vps.parseReservert(null), 57344);
  });

  it("slipper aldri under minimum, uansett hva som står", () => {
    assert.equal(vps.parseReservert("ram-reservert-mb=0"), vps.MIN_RESERVERT_MB);
    assert.equal(vps.parseReservert("ram-reservert-mb=100"), vps.MIN_RESERVERT_MB);
  });

  it("bytter tallet uten å røre resten av kommentaren", () => {
    assert.equal(vps.medReservert("Tekst. ram-reservert-mb=1 mer", 65536), "Tekst. ram-reservert-mb=65536 mer");
    assert.equal(vps.medReservert("Tekst.", 65536), "Tekst. ram-reservert-mb=65536");
    assert.equal(vps.medReservert(undefined, 65536), "ram-reservert-mb=65536");
  });
});

describe("garantert RAM per VPS", () => {
  it("er 0 når beskrivelsen ikke sier noe", () => {
    assert.equal(vps.parseMinRam("Snoat-VPS «a»"), 0);
  });

  it("legges til og byttes i beskrivelsen", () => {
    const en = vps.medMinRam("Snoat-VPS «a»", 1024);
    assert.equal(vps.parseMinRam(en), 1024);
    assert.equal(vps.parseMinRam(vps.medMinRam(en, 2048)), 2048);
    assert.equal(vps.medMinRam(en, 2048).match(/snoat-ram-min-mb/g)?.length, 1);
  });
});

describe("adresser", () => {
  it("leser IP-en fra net0", () => {
    assert.equal(vps.ipFraNet0("name=eth0,bridge=vmbr1,ip=10.10.10.101/24,gw=10.10.10.1"), "10.10.10.101");
    assert.equal(vps.ipFraNet0("name=eth0,bridge=vmbr1,ip=dhcp"), null);
  });

  it("velger første ledige IP i området", () => {
    const brukt = new Set(["10.10.10.100", "10.10.10.101"]);
    assert.equal(vps.ledigIp(brukt, "10.10.10", 100, 250), "10.10.10.102");
    assert.equal(vps.ledigIp(new Set(["10.10.10.100"]), "10.10.10", 100, 100), null);
  });

  it("gir SSH-port bare innenfor VPS-området", () => {
    assert.equal(vps.sshPortFor(2000, 2000, 22000), 22000);
    assert.equal(vps.sshPortFor(2017, 2000, 22000), 22017);
    assert.equal(vps.sshPortFor(100, 2000, 22000), null);
    assert.equal(vps.sshPortFor(3000, 2000, 22000), null);
  });

  it("godtar bare gyldige vertsnavn", () => {
    assert.ok(vps.gyldigVpsNavn("jarvis"));
    assert.ok(vps.gyldigVpsNavn("n8n-prod"));
    assert.ok(!vps.gyldigVpsNavn("a"));
    assert.ok(!vps.gyldigVpsNavn("9lives"));
    assert.ok(!vps.gyldigVpsNavn("slutter-"));
    assert.ok(!vps.gyldigVpsNavn("Store"));
    assert.ok(!vps.gyldigVpsNavn("a.b"));
  });
});

describe("ekstra domenesuffikser", () => {
  it("normaliserer og fjerner tomme og doble ledd", () => {
    assert.deepEqual(caddy.extraAppDomainSuffixes, [".88-99-100-186.sslip.io"]);
    assert.deepEqual(caddy.parseSuffixes(""), []);
    assert.deepEqual(caddy.parseSuffixes(" , . ,"), []);
  });

  it("gir ett ekstra vertsnavn per suffiks", () => {
    assert.deepEqual(caddy.extraAppHostnames("osia"), ["osia.88-99-100-186.sslip.io"]);
  });

  it("TLS-sjekken kjenner slugen under både hoved- og ekstrasuffikset", () => {
    assert.equal(caddy.slugFromHostname("osia.snoat.com"), "osia");
    assert.equal(caddy.slugFromHostname("osia.88-99-100-186.sslip.io"), "osia");
  });

  it("avviser dypere navn og fremmede suffikser", () => {
    assert.equal(caddy.slugFromHostname("a.osia.88-99-100-186.sslip.io"), null);
    assert.equal(caddy.slugFromHostname("osia.1-2-3-4.sslip.io"), null);
    assert.equal(caddy.slugFromHostname(".88-99-100-186.sslip.io"), null);
  });
});
