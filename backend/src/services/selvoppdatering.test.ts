import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

/**
 * Backend-siden av selvoppdateringen leser og skriver bare filer. Testene kjører
 * mot en midlertidig mappe med samme oppsett som skriptet på verten lager
 * (`infra/selvoppdatering/snoat-selvoppdatering`).
 *
 * `await import` av samme grunn som i `plans.test.ts`: `config.ts` leser miljøet
 * ved import, og mappa må være satt før det.
 */
const dir = await mkdtemp(join(tmpdir(), "snoat-selv-"));
process.env.NODE_ENV ??= "test";
process.env.SUPABASE_URL ??= "http://localhost:54321";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "test-service-role";
process.env.SUPABASE_ANON_KEY ??= "test-anon";
process.env.SNOAT_WORKSPACE_DIR ??= "/tmp/snoat-test";
process.env.SNOAT_SELVOPPDATERING_DIR = dir;

const selv = await import("./selvoppdatering.js");

describe("selvoppdateringen sett fra backend", () => {
  it("er av til skriptet har skrevet status.json, og nekter bestillinger da", async () => {
    assert.equal((await selv.hentStatus()).aktivert, false);
    await assert.rejects(selv.bestill(null, "test"), /ikke installert/);
  });

  it("leser status, deployet commit og byggene, nyeste først", async () => {
    await mkdir(join(dir, "bygg"), { recursive: true });
    await writeFile(join(dir, "status.json"), JSON.stringify({ sjekket: "2026-10-05T10:00:00Z", main: "b".repeat(40), kjorer: true }));
    await writeFile(join(dir, "deployet-commit"), `${"a".repeat(40)}\n`);
    for (const [id, status] of [
      ["20261005T090000Z-aaaaaaa", "ok"],
      ["20261005T100000Z-bbbbbbb", "bygger"],
    ] as const) {
      await writeFile(join(dir, "bygg", `${id}.json`), JSON.stringify({ id, commit: id.slice(-7), status }));
      await writeFile(join(dir, "bygg", `${id}.log`), `logg for ${id}\n`);
    }

    const status = await selv.hentStatus();
    assert.equal(status.aktivert, true);
    assert.equal(status.kjorer, true);
    assert.equal(status.deployetCommit, "a".repeat(40));
    assert.equal(status.mainCommit, "b".repeat(40));
    assert.deepEqual(
      status.bygg.map((b) => b.status),
      ["bygger", "ok"],
    );
  });

  it("gir loggen for et bygg, og avviser ID-er som kunne gått utenfor mappa", async () => {
    assert.equal(await selv.hentLogg("20261005T090000Z-aaaaaaa"), "logg for 20261005T090000Z-aaaaaaa");
    for (const id of ["../status", "..%2Fstatus", "20261005T090000Z-aaaaaaa/../../x", ""]) {
      await assert.rejects(selv.hentLogg(id), /Ugyldig bygg-ID/, id);
    }
    await assert.rejects(selv.hentLogg("20261005T110000Z-ccccccc"), /Fant ingen logg/);
  });

  it("skriver en bestilling som ferdig .json, og bare med en gyldig commit", async () => {
    await selv.bestill(null, "dashboard:daniel");
    await selv.bestill("abcdef1", "mcp:daniel");
    await assert.rejects(selv.bestill("main; rm -rf /", "x"), /SHA/);

    const filer = await readdir(join(dir, "jobber"));
    assert.equal(filer.filter((f) => f.endsWith(".json")).length, 2);
    assert.equal(filer.filter((f) => f.endsWith(".tmp")).length, 0);

    const innhold = await Promise.all(filer.map(async (f) => JSON.parse(await readFile(join(dir, "jobber", f), "utf8"))));
    assert.deepEqual(innhold.map((j) => j.commit).sort(), ["abcdef1", null].sort());
    assert.equal((await selv.hentStatus()).ventendeBestillinger, 2);
  });

  it("setter og opphever pause", async () => {
    await selv.settPause(true);
    assert.equal((await selv.hentStatus()).pause, true);
    await selv.settPause(false);
    assert.equal((await selv.hentStatus()).pause, false);
  });
});
