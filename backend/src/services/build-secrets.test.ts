import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { describe, it } from "node:test";

import {
  isSecretKey,
  renderSecretFile,
  rewriteDockerfile,
  secretsHash,
} from "./build-secrets.js";

/** Slik Nixpacks 1.41 skriver Dockerfilen (målt 2026-11-19). */
const NIXPACKS_DOCKERFILE = `FROM ghcr.io/railwayapp/nixpacks:ubuntu-1745885067

ENTRYPOINT ["/bin/bash", "-l", "-c"]
WORKDIR /app/


COPY .nixpacks/nixpkgs-abc.nix .nixpacks/nixpkgs-abc.nix
RUN nix-env -if .nixpacks/nixpkgs-abc.nix && nix-collect-garbage -d


ARG CI MY_SECRET NEXT_PUBLIC_X NIXPACKS_METADATA NODE_ENV NODE_OPTIONS NPM_CONFIG_PRODUCTION PORT
ENV CI=$CI MY_SECRET=$MY_SECRET NEXT_PUBLIC_X=$NEXT_PUBLIC_X NIXPACKS_METADATA=$NIXPACKS_METADATA NODE_ENV=$NODE_ENV NODE_OPTIONS=$NODE_OPTIONS NPM_CONFIG_PRODUCTION=$NPM_CONFIG_PRODUCTION PORT=$PORT

# install phase
ENV NIXPACKS_PATH=/app/node_modules/.bin:$NIXPACKS_PATH
COPY . /app/.
RUN --mount=type=cache,id=x-/root/npm,target=/root/.npm npm i

# build phase
COPY . /app/.
RUN --mount=type=cache,id=x-node_modules/cache,target=/app/node_modules/.cache npm run build

RUN printf '\\nPATH=/app/node_modules/.bin:$PATH' >> /root/.profile

COPY . /app
CMD ["npm run start"]`;

describe("isSecretKey", () => {
  it("holder offentlige og byggestyrende variabler utenfor", () => {
    for (const key of [
      "NEXT_PUBLIC_SUPABASE_URL",
      "VITE_X",
      "NIXPACKS_NODE_VERSION",
      "PORT",
      "NODE_OPTIONS",
    ]) {
      assert.equal(isSecretKey(key), false, key);
    }
    for (const key of [
      "SUPABASE_SERVICE_ROLE_KEY",
      "STRIPE_SECRET_KEY",
      "DATABASE_URL",
    ]) {
      assert.equal(isSecretKey(key), true, key);
    }
  });
});

describe("rewriteDockerfile", () => {
  const ut = rewriteDockerfile(NIXPACKS_DOCKERFILE, ["MY_SECRET"]);

  it("fjerner hemmeligheten fra ARG og ENV, og legger til hashen", () => {
    assert.match(
      ut,
      /^ARG CI NEXT_PUBLIC_X NIXPACKS_METADATA NODE_ENV NODE_OPTIONS NPM_CONFIG_PRODUCTION PORT SNOAT_BUILD_SECRETS_HASH$/m,
    );
    assert.doesNotMatch(ut, /MY_SECRET/);
    assert.match(ut, /^ENV CI=\$CI NEXT_PUBLIC_X=\$NEXT_PUBLIC_X /m);
    assert.match(
      ut,
      /^ENV NIXPACKS_PATH=\/app\/node_modules\/\.bin:\$NIXPACKS_PATH$/m,
      "andre ENV-linjer står",
    );
  });

  it("gir hver RUN etter variablene secret-mounten, og lar nix-steget være", () => {
    assert.match(ut, /^RUN nix-env -if /m);
    assert.match(
      ut,
      /^RUN --mount=type=cache,id=x-\/root\/npm,target=\/root\/\.npm --mount=type=secret,id=snoat-env if \[ -f \/run\/secrets\/snoat-env \]; then \. \/run\/secrets\/snoat-env; fi; npm i$/m,
    );
    assert.match(ut, /--mount=type=secret,id=snoat-env if .*; npm run build$/m);
    assert.match(ut, /^RUN --mount=type=secret,id=snoat-env if .*; printf /m);
    assert.match(ut, /^CMD \["npm run start"\]$/m);
  });
});

describe("renderSecretFile", () => {
  it("siterer verdier trygt for sh", () => {
    const env = { A: "a b'c $(touch /tmp/x) `id`", B: "", "UGYLDIG-NAVN": "x" };
    const { content, skipped } = renderSecretFile(env, [
      "A",
      "B",
      "UGYLDIG-NAVN",
    ]);
    assert.deepEqual(skipped, ["UGYLDIG-NAVN"]);
    const lest = execFileSync("sh", [
      "-c",
      `${content}printf '%s|%s' "$A" "$B"`,
    ]).toString();
    assert.equal(lest, env.A + "|");
  });
});

describe("secretsHash", () => {
  it("endres med verdien, ikke med rekkefølgen", () => {
    const a = secretsHash("p", { X: "1", Y: "2" }, ["X", "Y"]);
    assert.equal(a, secretsHash("p", { Y: "2", X: "1" }, ["Y", "X"]));
    assert.notEqual(a, secretsHash("p", { X: "1", Y: "3" }, ["X", "Y"]));
  });
});
