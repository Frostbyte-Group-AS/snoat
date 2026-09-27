import { test } from "node:test";
import assert from "node:assert/strict";
import { moveCandidates, previousFullName } from "./repo-move.js";

test("moveCandidates: samme reponavn under annen eier er kandidat", () => {
  const projects = [
    { name: "osia", repo_url: "https://github.com/Frostbyte-Group-AS/osia.git" },
    { name: "dev", repo_url: "https://github.com/frostbyte-group-as/osia" },
  ];
  assert.deepEqual(moveCandidates(projects, "osia-as/osia").map((p) => p.name), ["osia", "dev"]);
});

test("moveCandidates: samme repo, annet navn eller prefiks-treff er ikke kandidat", () => {
  const projects = [
    { name: "allerede", repo_url: "https://github.com/osia-as/osia.git" },
    { name: "annet", repo_url: "https://github.com/eier/osia-docs" },
    { name: "prefiks", repo_url: "https://github.com/eier/osia2" },
    { name: "ikke-github", repo_url: "https://gitlab.com/eier/osia" },
  ];
  assert.deepEqual(moveCandidates(projects, "osia-as/osia"), []);
});

test("previousFullName: transferred gir gammel eier", () => {
  assert.equal(
    previousFullName({
      action: "transferred",
      repository: { full_name: "osia-as/osia" },
      changes: { owner: { from: { organization: { login: "Frostbyte-Group-AS" } } } },
    }),
    "Frostbyte-Group-AS/osia",
  );
  assert.equal(
    previousFullName({
      action: "transferred",
      repository: { full_name: "org/app" },
      changes: { owner: { from: { user: { login: "person" } } } },
    }),
    "person/app",
  );
});

test("previousFullName: renamed gir gammelt navn", () => {
  assert.equal(
    previousFullName({
      action: "renamed",
      repository: { full_name: "eier/nytt" },
      changes: { repository: { name: { from: "gammelt" } } },
    }),
    "eier/gammelt",
  );
});

test("previousFullName: andre handlinger og uendret navn gir null", () => {
  assert.equal(previousFullName({ action: "publicized", repository: { full_name: "eier/app" } }), null);
  assert.equal(previousFullName({ action: "renamed", repository: { full_name: "eier/app" } }), null);
  assert.equal(previousFullName({ action: "transferred", repository: {} }), null);
});
