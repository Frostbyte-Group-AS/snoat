import { execa } from "execa";
import { config } from "../config.js";
import { DeployError, type Project } from "../types.js";
import { describeBuildFailure } from "./build-diagnosis.js";
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
 * Nixpacks kjører `docker build` mot host-daemonen. Derfor må `directory` være
 * en sti daemonen selv kan løse – se SNOAT_WORKSPACE_DIR i README.
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
   */
  buildMemoryMb: number,
): Promise<string> {
  const image = imageNameFor(project);

  const args = ["build", directory, "--name", image];

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
      logs.write(`${runtime.label}-versjon: styrt av ${runtime.variable} i prosjektets miljøvariabler.`);
      continue;
    }

    if (runtime.inject) {
      args.push("--env", `${runtime.variable}=${runtime.version}`);
    }

    logs.write(`${runtime.label}-versjon: ${runtime.version} (${runtime.source}).`);
  }

  // Minnetak for selve byggingen. `next build` og `vite build` tar så mye heap de
  // får lov til; uten et tak er det verten som setter grensen, og da har den
  // allerede begynt å swappe. Med taket feiler bygget med en forklarlig
  // heap-feil i stedet for å ta ned plattformen for alle andre.
  if (!Object.hasOwn(userEnv, "NODE_OPTIONS")) {
    args.push("--env", `NODE_OPTIONS=--max-old-space-size=${buildMemoryMb}`);
    logs.write(`Minnetak under bygging: ${buildMemoryMb} MB heap (fra planen).`);
  }

  logs.write(`nixpacks build ${directory} --name ${image}`);

  const build = execa("nixpacks", args, {
    timeout: config.SNOAT_BUILD_TIMEOUT_MS,
    all: true,
  });

  let tail = "";

  build.all?.on("data", (chunk: Buffer) => {
    const text = chunk.toString();
    logs.write(text);
    tail = (tail + text).slice(-DIAGNOSIS_TAIL_CHARS);
  });

  try {
    await build;
  } catch (error) {
    const timedOut = error instanceof Error && "timedOut" in error && error.timedOut === true;
    throw new DeployError(
      "build",
      timedOut
        ? `Byggingen brukte mer enn ${Math.round(config.SNOAT_BUILD_TIMEOUT_MS / 60000)} minutter og ble avbrutt.`
        : describeBuildFailure(tail),
    );
  }

  logs.write(`Image bygget: ${image}`);
  return image;
}
