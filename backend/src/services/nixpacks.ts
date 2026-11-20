import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execa } from "execa";
import { config } from "../config.js";
import { DeployError, type Project } from "../types.js";
import { describeBuildFailure } from "./build-diagnosis.js";
import {
  SECRET_HASH_ARG,
  SECRET_ID,
  renderSecretFile,
  rewriteDockerfile,
  secretKeysOf,
  secretsHash,
} from "./build-secrets.js";
import type { LogStream } from "./log-stream.js";
import { resolveRuntimeVersions } from "./runtime-versions.js";

/**
 * Hvor mye av byggeoutputen vi holder på for å kunne stille en diagnose.
 *
 * Feilen står alltid nederst, mens starten av loggen er nedlasting av nix-stier
 * og docker-lag. Et fullt bygg kan produsere titalls megabyte, og hele loggen
 * ligger allerede i `LogStream` – dette er kun arbeidskopien vi kjører
 * mønstergjenkjenning mot, så halen holder.
 */
const DIAGNOSIS_TAIL_CHARS = 64_000;

/** Image-navnet et prosjekt bygges til. Overskrives ved hver deployment. */
export function imageNameFor(project: Project): string {
  return `snoat/${project.name}`;
}

/**
 * Bygger et OCI-image fra kildekoden med Nixpacks.
 *
 * Vi følger Dokploy sin argumentoppbygging (`--name`, `--env`, `--build-cmd`),
 * men kaller binæren direkte med et argument-array i stedet for å bygge en
 * bash-streng. Da slipper vi å shell-escape brukerens miljøvariabler, som er en
 * enkel vei til kommandoinjeksjon når verdiene kommer fra et skjema i UI-et.
 *
 * Nixpacks lager bare planen og Dockerfilen (`--out`); selve `docker build`
 * kjører vi, slik at prosjektets hemmelige variabler kan gis som en
 * BuildKit-secret i stedet for `--build-arg` (se `build-secrets.ts`). Ellers
 * lå de i image-konfigurasjonen og lag-historikken.
 */
export async function buildImage(
  project: Project,
  directory: string,
  logs: LogStream,
  /**
   * Heap-tak for bygget, i MB — fra `buildMemoryFor()` i `services/plans.ts`.
   *
   * Kommer som argument og ikke fra `config`, fordi tallet avhenger av kundens
   * PLAN. Leste vi det her, ville alle planer fått samme byggetak, og det var
   * nettopp feilen: en betalende kunde fikk ikke mer å bygge med enn en
   * gratisbruker.
   *
   * `null` betyr «ingen grense» og forekommer bare på en eierkonto. Da settes
   * flagget ikke i det hele tatt, og V8 dimensjonerer heapen etter verten. Det
   * er den eneste gyldige oversettelsen av uendelig: `--max-old-space-size` tar
   * et tall, og det finnes ikke noe tall som betyr «uten tak».
   */
  buildMemoryMb: number | null,
): Promise<string> {
  const image = imageNameFor(project);

  // Felles for `nixpacks plan` og `nixpacks build --out`: alt som former planen.
  const args: string[] = [];

  // Nixpacks nøkler cache-monteringene (npm-cachen, `.next/cache`,
  // `node_modules/.cache`) på mappestien når ingen nøkkel er oppgitt – og hvert
  // bygg får en ny arbeidsmappe. Da ble cachen aldri gjenbrukt, og BuildKit satt
  // igjen med én foreldreløs kopi per bygg (35 GB målt 2026-10-04). Nøkkelen er
  // prosjektets ID: stabil mellom bygg, og aldri delt med et annet prosjekt, så
  // ett prosjekt kan ikke legge noe i et annets cache.
  const cacheKey = `snoat-${project.id}`;

  // zstd i stedet for gzip når laget eksporteres – se SNOAT_BUILD_DOCKER_OUTPUT.
  const output = config.SNOAT_BUILD_DOCKER_OUTPUT.trim();

  // Applikasjonen må lytte på den porten Caddy ruter til.
  args.push("--env", `PORT=${config.SNOAT_APP_PORT}`);

  const userEnv = project.env_vars ?? {};
  for (const [key, value] of Object.entries(userEnv)) {
    args.push("--env", `${key}=${value}`);
  }

  if (project.build_command) {
    args.push("--build-cmd", project.build_command);
  }

  logs.step("Bygger image med Nixpacks");

  // Språkversjoner avgjøres før kommandoen skrives ut, slik at loggen viser hva
  // bygget faktisk kjører med.
  for (const runtime of await resolveRuntimeVersions(directory)) {
    // Har brukeren satt variabelen selv, er saken avgjort: den ligger allerede i
    // argumentlista over, og en ny `--env` med samme nøkkel ville overstyrt den.
    if (Object.hasOwn(userEnv, runtime.variable)) {
      logs.write(
        `${runtime.label}-versjon: styrt av ${runtime.variable} i prosjektets miljøvariabler.`,
      );
      continue;
    }

    if (runtime.inject) {
      args.push("--env", `${runtime.variable}=${runtime.version}`);
    }

    logs.write(
      `${runtime.label}-versjon: ${runtime.version} (${runtime.source}).`,
    );
  }

  // Minnetak for selve byggingen. `next build` og `vite build` tar så mye heap de
  // får lov til; uten et tak er det verten som setter grensen, og da har den
  // allerede begynt å swappe. Med taket feiler bygget med en forklarlig
  // heap-feil i stedet for å ta ned plattformen for alle andre.
  if (!Object.hasOwn(userEnv, "NODE_OPTIONS")) {
    if (buildMemoryMb === null) {
      logs.write("Ingen minnetak under bygging – kontoen har ingen grenser.");
    } else {
      args.push("--env", `NODE_OPTIONS=--max-old-space-size=${buildMemoryMb}`);
      logs.write(
        `Minnetak under bygging: ${buildMemoryMb} MB heap (fra planen).`,
      );
    }
  }

  // 1. Planen: variablene Nixpacks vil bygge med (prosjektets egne pluss
  //    standardverdiene, f.eks. NODE_ENV og CI).
  const plan = await runLogged(
    "nixpacks",
    ["plan", directory, "--format", "json", ...args],
    logs,
    false,
  );
  const variables = parsePlanVariables(plan);

  // 2. Dockerfilen, uten å bygge.
  await runLogged(
    "nixpacks",
    [
      "build",
      directory,
      "--out",
      directory,
      "--name",
      image,
      "--cache-key",
      cacheKey,
      ...args,
    ],
    logs,
    true,
  );

  const secretKeys = secretKeysOf(userEnv);
  const dockerfilePath = path.join(directory, ".nixpacks", "Dockerfile");
  await writeFile(
    dockerfilePath,
    rewriteDockerfile(await readFile(dockerfilePath, "utf8"), secretKeys),
  );

  const { content, skipped } = renderSecretFile(userEnv, secretKeys);
  if (secretKeys.length) {
    logs.write(
      `${secretKeys.length - skipped.length} hemmelige variabler er tilgjengelige under bygging, men legges ikke i image-et.`,
    );
  }
  if (skipped.length) {
    logs.write(
      `Ikke tilgjengelig under bygging (ugyldig navn i skallet, finnes i appen ved kjøring): ${skipped.join(", ")}`,
    );
  }

  const secretDir = await mkdtemp(path.join(os.tmpdir(), "snoat-build-"));
  const secretFile = path.join(secretDir, "env");
  try {
    await writeFile(secretFile, content, { mode: 0o600 });
    await chmod(secretFile, 0o600);

    const dockerArgs = ["build", directory, "-f", dockerfilePath, "-t", image];
    if (output && output !== "none") dockerArgs.push("--output", output);
    for (const [key, value] of Object.entries(variables)) {
      if (secretKeys.includes(key)) continue;
      dockerArgs.push("--build-arg", `${key}=${value}`);
    }
    dockerArgs.push(
      "--build-arg",
      `${SECRET_HASH_ARG}=${secretsHash(project.id, userEnv, secretKeys)}`,
    );
    dockerArgs.push("--secret", `id=${SECRET_ID},src=${secretFile}`);

    logs.write(`docker build ${directory} -t ${image}`);
    await runLogged("docker", dockerArgs, logs, true);
  } finally {
    await rm(secretDir, { recursive: true, force: true });
  }

  logs.write(`Image bygget: ${image}`);
  return image;
}

/** `variables` fra `nixpacks plan --format json`. */
export function parsePlanVariables(planJson: string): Record<string, string> {
  const plan = JSON.parse(planJson) as { variables?: Record<string, unknown> };
  return Object.fromEntries(
    Object.entries(plan.variables ?? {}).map(([key, value]) => [
      key,
      String(value),
    ]),
  );
}

/**
 * Kjører et byggesteg med samme tidsgrense og feildiagnose som før. `stream`
 * sender outputen til byggeloggen; planen (JSON) gjør ikke det.
 */
async function runLogged(
  command: string,
  args: string[],
  logs: LogStream,
  stream: boolean,
): Promise<string> {
  const child = execa(command, args, {
    timeout: config.SNOAT_BUILD_TIMEOUT_MS,
    all: true,
  });

  let tail = "";
  child.all?.on("data", (chunk: Buffer) => {
    const text = chunk.toString();
    if (stream) logs.write(text);
    tail = (tail + text).slice(-DIAGNOSIS_TAIL_CHARS);
  });

  try {
    const result = await child;
    return String(result.stdout ?? "");
  } catch (error) {
    if (!stream) logs.write(tail);
    const timedOut =
      error instanceof Error && "timedOut" in error && error.timedOut === true;
    throw new DeployError(
      "build",
      timedOut
        ? `Byggingen brukte mer enn ${Math.round(config.SNOAT_BUILD_TIMEOUT_MS / 60000)} minutter og ble avbrutt.`
        : describeBuildFailure(tail),
    );
  }
}
