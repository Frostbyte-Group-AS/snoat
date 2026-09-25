import { test } from "node:test";
import assert from "node:assert/strict";
import { EnvVarError, mergeEnvVars } from "./env-vars.js";

const existing = { DATABASE_URL: "postgres://hemmelig", RESEND_API_KEY: "re_abc", TOM: "" };

test("setter én nøkkel uten å røre de andre", () => {
  const result = mergeEnvVars(existing, { set: { RESEND_API_KEY: "re_ny" } });
  assert.deepEqual(result.envVars, { DATABASE_URL: "postgres://hemmelig", RESEND_API_KEY: "re_ny", TOM: "" });
  assert.deepEqual(result.changed, ["RESEND_API_KEY"]);
  assert.deepEqual(result.added, []);
});

test("legger til ny nøkkel og skiller den fra endrede", () => {
  const result = mergeEnvVars(existing, { set: { NY: "1", DATABASE_URL: "postgres://hemmelig" } });
  assert.deepEqual(result.added, ["NY"]);
  assert.deepEqual(result.changed, [], "samme verdi er ikke en endring");
  assert.equal(result.envVars.NY, "1");
});

test("fjerner nøkler og rapporterer de som ikke fantes", () => {
  const result = mergeEnvVars(existing, { unset: ["TOM", "FINNES_IKKE", "TOM"] });
  assert.deepEqual(Object.keys(result.envVars), ["DATABASE_URL", "RESEND_API_KEY"]);
  assert.deepEqual(result.removed, ["TOM"]);
  assert.deepEqual(result.missing, ["FINNES_IKKE"]);
});

test("tom verdi er lov – det er ikke det samme som å fjerne", () => {
  const result = mergeEnvVars(existing, { set: { RESEND_API_KEY: "" } });
  assert.equal(result.envVars.RESEND_API_KEY, "");
  assert.ok("RESEND_API_KEY" in result.envVars);
});

test("muterer ikke det eksisterende objektet", () => {
  const before = { A: "1" };
  mergeEnvVars(before, { set: { B: "2" }, unset: ["A"] });
  assert.deepEqual(before, { A: "1" });
});

test("tåler at prosjektet ikke har noen variabler ennå", () => {
  assert.deepEqual(mergeEnvVars(null, { set: { A: "1" } }).envVars, { A: "1" });
});

test("avviser samme nøkkel i set og unset", () => {
  assert.throws(() => mergeEnvVars(existing, { set: { A: "1" }, unset: ["A"] }), EnvVarError);
});

test("avviser ugyldige nøkler og ikke-strenger", () => {
  assert.throws(() => mergeEnvVars({}, { set: { "1ABC": "x" } }), EnvVarError);
  assert.throws(() => mergeEnvVars({}, { set: { "A-B": "x" } }), EnvVarError);
  assert.throws(() => mergeEnvVars({}, { set: { A: 1 as unknown as string } }), EnvVarError);
  assert.throws(() => mergeEnvVars({}, { set: ["A"] }), EnvVarError);
  assert.throws(() => mergeEnvVars({}, { unset: "A" }), EnvVarError);
  assert.throws(() => mergeEnvVars({}, { unset: ["ugyldig nøkkel"] }), EnvVarError);
});
