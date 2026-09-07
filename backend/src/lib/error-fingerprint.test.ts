import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { fingerprint, normalizeFile, normalizeMessage } from "./error-fingerprint.js";
import { parseStderr, stripDockerPrefix } from "./stderr-parse.js";

/**
 * Tester for de to reglene i feilsporingen som kan være feil uten at noe
 * krasjer.
 *
 * Resten av systemet feiler høyt: en RPC som ikke finnes gir en feilmelding, en
 * rute som ikke svarer gir en 502. Grupperingen og stderr-tolkningen gjør ikke
 * det. De produserer bare et dashboard som ser rimelig ut og er ubrukelig – for
 * løs gruppering slår sammen feil som ikke har noe med hverandre å gjøre, for
 * streng gruppering gir én rad per forekomst, og en for ivrig stderr-parser
 * fyller lista med `npm WARN`-linjer til noen slår av hele fanen.
 */

describe("normalizeMessage", () => {
  it("samler samme feil med ulike IDer i én gruppe", () => {
    const a = normalizeMessage("Bruker 4711 finnes ikke");
    const b = normalizeMessage("Bruker 9312 finnes ikke");

    assert.equal(a, b);
  });

  it("tar UUID før tall, slik at hele UUID-en blir ett symbol", () => {
    const normalized = normalizeMessage(
      "Fant ikke prosjekt 160d2008-4dc1-407f-9b56-25c6faf668e9",
    );

    assert.equal(normalized, "Fant ikke prosjekt <uuid>");
  });

  it("skjuler URL-er, som ellers ville gitt én gruppe per kunde-domene", () => {
    assert.equal(
      normalizeMessage("Timeout mot https://kunde.example.com/api/v2/ting?id=9"),
      "Timeout mot <url>",
    );
  });

  it("holder ulike feil fra hverandre", () => {
    assert.notEqual(
      normalizeMessage("Cannot read properties of undefined (reading 'id')"),
      normalizeMessage("Cannot read properties of undefined (reading 'navn')"),
    );
  });
});

describe("normalizeFile", () => {
  it("fjerner innholdshashen, slik at en gruppe overlever neste bygg", () => {
    assert.equal(
      normalizeFile("https://app.snoat.com/_next/static/chunks/main-a3f9c1.js"),
      "/_next/static/chunks/main.js",
    );
  });

  it("gir samme sti uansett hvilket domene appen svarte på", () => {
    assert.equal(
      normalizeFile("https://osia.no/assets/index.js"),
      normalizeFile("https://osia.snoat.com/assets/index.js"),
    );
  });

  it("lar en vanlig sti stå", () => {
    assert.equal(normalizeFile("/app/src/server.js"), "/app/src/server.js");
  });

  it("tåler null", () => {
    assert.equal(normalizeFile(null), null);
  });
});

describe("fingerprint", () => {
  it("er lik for samme feil på samme sted", () => {
    assert.equal(
      fingerprint("client", "Bruker 1 mangler", "/app/x.js", 12),
      fingerprint("client", "Bruker 2 mangler", "/app/x.js", 12),
    );
  });

  it("skiller samme melding i to ulike filer", () => {
    assert.notEqual(
      fingerprint("client", "Noe feilet", "/app/a.js", 12),
      fingerprint("client", "Noe feilet", "/app/b.js", 12),
    );
  });

  it("skiller en klientfeil fra et serverunntak med samme tekst", () => {
    assert.notEqual(
      fingerprint("client", "Noe feilet", "/app/a.js", 12),
      fingerprint("server", "Noe feilet", "/app/a.js", 12),
    );
  });
});

describe("stripDockerPrefix", () => {
  it("fjerner tidsstempelet Docker setter foran hver linje", () => {
    assert.equal(
      stripDockerPrefix("2026-09-07T05:00:01.123456789Z TypeError: x"),
      "TypeError: x",
    );
  });
});

describe("parseStderr", () => {
  it("plukker ut et Node-unntak med fil og linje", () => {
    const [found] = parseStderr(
      [
        "2026-09-07T05:00:01.000Z TypeError: Cannot read properties of undefined (reading 'id')",
        "2026-09-07T05:00:01.000Z     at hentBruker (/app/src/db.js:42:17)",
        "2026-09-07T05:00:01.000Z     at /app/node_modules/express/lib/router.js:281:22",
      ].join("\n"),
    );

    assert.ok(found);
    assert.equal(found.message, "TypeError: Cannot read properties of undefined (reading 'id')");
    // Ramma i node_modules hoppes over: den er rammeverkskode, og å gruppere på
    // den ville slått sammen alle feil som passerer gjennom Express' router.
    assert.equal(found.file, "/app/src/db.js");
    assert.equal(found.line, 42);
    assert.equal(found.col, 17);
  });

  it("ignorerer en linje som nevner Error uten å ha rammer", () => {
    const found = parseStderr(
      ["Error handling middleware registered", "Server lytter på :3000"].join("\n"),
    );

    assert.deepEqual(found, []);
  });

  it("ignorerer vanlig oppstartsstøy", () => {
    const found = parseStderr(
      [
        "npm WARN deprecated inflight@1.0.6: This module is not supported",
        "▲ Next.js 15.0.0",
        "  - Local: http://localhost:3000",
        "✓ Ready in 1.2s",
      ].join("\n"),
    );

    assert.deepEqual(found, []);
  });

  it("finner to unntak i samme bolk", () => {
    const found = parseStderr(
      [
        "TypeError: a",
        "    at f (/app/a.js:1:1)",
        "noe helt annet i loggen",
        "RangeError: b",
        "    at g (/app/b.js:2:2)",
      ].join("\n"),
    );

    assert.equal(found.length, 2);
    assert.equal(found[0]?.file, "/app/a.js");
    assert.equal(found[1]?.file, "/app/b.js");
  });

  it("tar med rammene i stacktracen, uten tidsstemplene", () => {
    const [found] = parseStderr(
      ["2026-09-07T05:00:01.000Z Error: x", "2026-09-07T05:00:01.000Z     at f (/app/a.js:1:1)"].join(
        "\n",
      ),
    );

    assert.equal(found?.stack, "Error: x\n    at f (/app/a.js:1:1)");
  });
});
