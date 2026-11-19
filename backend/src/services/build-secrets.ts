import { createHash } from "node:crypto";

/**
 * Hemmelige miljøvariabler under bygging, uten at de havner i image-et.
 *
 * Nixpacks gjør hver `--env` til `ARG` + `ENV` i Dockerfilen og sender verdien
 * som `--build-arg`. Da ligger verdien i image-konfigurasjonen (`docker
 * inspect`) og i lag-historikken (`docker history`) for alltid, og i
 * byggcachen. Containeren trenger dem ikke derfra: `containers.ts` gir den alle
 * prosjektets variabler når den starter.
 *
 * Her skrives Dockerfilen om: de hemmelige nøklene fjernes fra `ARG`/`ENV`, og
 * hver `RUN` etter variabellinjen får en BuildKit-secret-mount som leser dem
 * inn i skallet bare mens kommandoen kjører. Mounten lagres ikke i laget.
 *
 * Bare det som uansett er offentlig, eller som styrer selve bygget, går som
 * vanlige byggeargumenter.
 */

export const SECRET_ID = "snoat-env";
const SECRET_PATH = `/run/secrets/${SECRET_ID}`;

/**
 * Brukes BuildKit-cachen til å se at en hemmelighet er endret. Secret-mounts
 * er ikke med i cache-nøkkelen, så uten dette ville et nytt bygg av samme
 * commit med ny API-nøkkel gjenbrukt det gamle `npm run build`-laget.
 */
export const SECRET_HASH_ARG = "SNOAT_BUILD_SECRETS_HASH";

/** Prefikser for variabler som havner i nettleserkoden uansett. */
const PUBLIC_PREFIXES = [
  "NEXT_PUBLIC_",
  "VITE_",
  "PUBLIC_",
  "REACT_APP_",
  "EXPO_PUBLIC_",
  "NUXT_PUBLIC_",
  "GATSBY_",
  "NIXPACKS_",
];

/** Byggeoppsett som ikke er hemmelig. */
const PLAIN_KEYS = new Set([
  "PORT",
  "NODE_ENV",
  "NODE_OPTIONS",
  "CI",
  "NPM_CONFIG_PRODUCTION",
  "TZ",
]);

const SHELL_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function isSecretKey(key: string): boolean {
  if (PLAIN_KEYS.has(key)) return false;
  return !PUBLIC_PREFIXES.some((prefix) => key.startsWith(prefix));
}

/** Hemmelighetene fra prosjektets egne variabler. */
export function secretKeysOf(userEnv: Record<string, string>): string[] {
  return Object.keys(userEnv).filter(isSecretKey);
}

const singleQuote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;

/**
 * Innholdet i secret-filen: én `export` per gyldig nøkkel. En nøkkel som ikke
 * er et gyldig skallnavn kan ikke eksporteres, og står bare i containerens
 * miljø ved kjøring (`skipped`).
 */
export function renderSecretFile(
  env: Record<string, string>,
  keys: string[],
): { content: string; skipped: string[] } {
  const skipped: string[] = [];
  const lines: string[] = [];
  for (const key of keys) {
    if (!SHELL_NAME.test(key)) {
      skipped.push(key);
      continue;
    }
    lines.push(`export ${key}=${singleQuote(env[key] ?? "")}`);
  }
  return { content: lines.length ? `${lines.join("\n")}\n` : "", skipped };
}

/** Endres når en hemmelig verdi endres, uten å avsløre verdiene. */
export function secretsHash(
  projectId: string,
  env: Record<string, string>,
  keys: string[],
): string {
  const sorted = [...keys].sort().map((key) => [key, env[key] ?? ""]);
  return createHash("sha256")
    .update(projectId)
    .update("\0")
    .update(JSON.stringify(sorted))
    .digest("hex")
    .slice(0, 32);
}

const LOAD = `if [ -f ${SECRET_PATH} ]; then . ${SECRET_PATH}; fi; `;

/**
 * Skriver om Nixpacks' Dockerfile.
 *
 * - `ARG`-linja med variablene mister de hemmelige nøklene og får
 *   `SNOAT_BUILD_SECRETS_HASH`.
 * - `ENV`-linja (bare `K=$K`-par) mister de hemmelige nøklene.
 * - Hver `RUN` i skallform etter variabellinjen får secret-mounten og leser
 *   filen før kommandoen.
 */
export function rewriteDockerfile(
  dockerfile: string,
  secretKeys: string[],
): string {
  const secret = new Set(secretKeys);
  let seenVars = false;

  const out = dockerfile.split("\n").flatMap((line) => {
    const argMatch = /^ARG\s+(.+)$/.exec(line);
    if (argMatch && !seenVars) {
      seenVars = true;
      const keys = (argMatch[1] ?? "")
        .trim()
        .split(/\s+/)
        .filter((key) => !secret.has(key));
      return [`ARG ${[...keys, SECRET_HASH_ARG].join(" ")}`];
    }

    const envMatch = /^ENV\s+(.+)$/.exec(line);
    if (envMatch) {
      const pairs = (envMatch[1] ?? "").trim().split(/\s+/);
      const varsLine = pairs.every((pair) =>
        /^([A-Za-z_][A-Za-z0-9_]*)=\$\1$/.test(pair),
      );
      if (varsLine) {
        const kept = pairs.filter(
          (pair) => !secret.has(pair.slice(0, pair.indexOf("="))),
        );
        return kept.length ? [`ENV ${kept.join(" ")}`] : [];
      }
      return [line];
    }

    const runMatch = /^RUN\s+(.*)$/.exec(line);
    const rest = runMatch?.[1] ?? "";
    if (runMatch && seenVars && !rest.trimStart().startsWith("[")) {
      // Flaggene (`--mount=…`) står først; kommandoen er resten.
      const tokens = rest.split(" ");
      let i = 0;
      while (i < tokens.length && (tokens[i] ?? "").startsWith("--")) i++;
      const flags = tokens.slice(0, i);
      const command = tokens.slice(i).join(" ");
      return [
        `RUN ${[...flags, `--mount=type=secret,id=${SECRET_ID}`].join(" ")} ${LOAD}${command}`,
      ];
    }

    return [line];
  });

  if (!seenVars && secretKeys.length) {
    // Uten variabellinje har Nixpacks ikke fått noen variabler å bake inn.
    return dockerfile;
  }
  return out.join("\n");
}
