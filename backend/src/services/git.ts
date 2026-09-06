import { execa } from "execa";
import { rm, mkdir } from "node:fs/promises";
import path from "node:path";
import { config } from "../config.js";
import * as github from "../lib/github.js";
import { redactCredentials } from "../lib/redact.js";
import { DeployError } from "../types.js";
import type { LogStream } from "./log-stream.js";

/**
 * Tillater kun http(s)-URL-er.
 *
 * Uten denne kunne `repo_url` vært `--upload-pack=...` eller en `ext::`-URL,
 * som får git til å kjøre vilkårlige kommandoer. Verdien kommer fra brukeren,
 * så den valideres før den når git.
 */
export function assertSafeRepoUrl(repoUrl: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(repoUrl);
  } catch {
    throw new DeployError("clone", `Ugyldig repository-URL: ${repoUrl}`);
  }

  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new DeployError("clone", `Kun http(s)-URL-er støttes, fikk «${parsed.protocol}»`);
  }

  return parsed;
}

/**
 * Grennavn vi er villige til å sende til git.
 *
 * Første tegn må være en bokstav, et tall eller en understrek. Det er ikke pynt:
 * verdien havner som `--branch <verdi>` på kommandolinjen, og git tolker et
 * argument som starter med `-` som en opsjon – `--upload-pack=…` gjør en klone
 * til vilkårlig kommandokjøring på verten, akkurat som beskrevet over. Kan
 * første tegn aldri være en bindestrek, finnes ikke den veien.
 *
 * Resten er git sine egne regler fra `git check-ref-format`, i konservativ form.
 * Vi tillater med vilje mindre enn git gjør – ingen mellomrom, ingen `~^:?*[`,
 * ingen kontrolltegn – fordi et grennavn som trenger dem er sjeldnere enn et
 * grennavn som er et angrep.
 */
const BRANCH_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9._/-]{0,254}$/;

/**
 * Validerer grenen prosjektet har valgt, og returnerer den trimmet.
 *
 * Speiler check-constrainten `projects_branch_check` (migrasjon 0012). Det er
 * ikke dobbeltarbeid: constrainten verner mot dashboardet, som skriver raden
 * selv med brukerens sesjon, og denne funksjonen verner mot backend, som omgår
 * constrainten med service-role-nøkkelen.
 */
export function assertSafeBranch(branch: string): string {
  const value = branch.trim();

  if (
    !BRANCH_PATTERN.test(value) ||
    value.includes("..") ||
    value.includes("//") ||
    value.endsWith("/") ||
    value.endsWith(".lock") ||
    value.includes("@{")
  ) {
    throw new DeployError(
      "clone",
      `Ugyldig grennavn: «${branch}». Bruk bokstaver, tall, punktum, understrek, ` +
        "bindestrek og skråstrek, og la navnet begynne med en bokstav, et tall eller en understrek.",
    );
  }

  return value;
}

/** Katalogen kildekoden for én deployment klones til. */
export function workspaceFor(projectId: string, deploymentId: string): string {
  return path.join(config.SNOAT_WORKSPACE_DIR, projectId, deploymentId);
}

export interface CloneResult {
  directory: string;
  commitHash: string;
  /**
   * Grenen som faktisk ble sjekket ut.
   *
   * Er `projects.branch` satt, er det den. Er den NULL, er det repoets
   * standardgren – og da er dette det eneste stedet svaret finnes, siden
   * ingenting i databasen sier hva GitHub valgte. `null` bare hvis
   * `rev-parse` mot alle odds ikke svarer.
   */
  branch: string | null;
}

/**
 * Hva git sier når grenen ikke finnes.
 *
 * Tre formuleringer fordi git har byttet ordlyd mellom versjoner, og fordi
 * `--branch` mot en ukjent ref treffer to ulike kodeveier (remote-oppslag og
 * checkout). Alle tre er tekst git skriver ordrett – vi gjetter ikke på en
 * delstreng som kan bety noe annet.
 */
const MISSING_BRANCH =
  /not found in upstream|Could not find remote branch|couldn't find remote ref/i;

/**
 * Kloner repoet til arbeidsområdet.
 *
 * `--depth 1` fordi vi bare trenger arbeidstreet for å bygge, ikke historikken.
 *
 * `branch` er grenen prosjektet har valgt, eller `null`/`undefined` for «bruk
 * repoets default branch». Er den satt, legger vi til `--branch` og
 * `--single-branch`: den første velger grenen, den andre sier at vi ikke vil ha
 * noe annet med – `--depth 1` impliserer det allerede, men eksplisitt er bedre
 * enn å hvile på en implikasjon som kan endre seg mellom git-versjoner.
 */
export async function cloneRepository(
  repoUrl: string,
  projectId: string,
  deploymentId: string,
  logs: LogStream,
  installationId?: number | null,
  branch?: string | null,
): Promise<CloneResult> {
  const url = assertSafeRepoUrl(repoUrl);
  // Valideres før noe klones, ikke etter: det er denne verdien som blir et
  // kommandolinje-argument.
  const wanted = branch ? assertSafeBranch(branch) : null;
  const directory = workspaceFor(projectId, deploymentId);

  await rm(directory, { recursive: true, force: true });
  await mkdir(directory, { recursive: true });

  // Er repoet valgt gjennom GitHub App-en, kloner vi med et kortlevd
  // installasjonstoken. Da fungerer private repoer, og tokenet utløper av seg
  // selv en time senere uansett hva som skjer med arbeidsområdet.
  const cloneTarget = installationId
    ? await github.authenticatedCloneUrl(url.toString(), installationId)
    : url.toString();

  const branchArgs = wanted ? ["--single-branch", "--branch", wanted] : [];

  logs.step("Kloner repository");
  logs.write(["git clone --depth 1", ...branchArgs, redactCredentials(cloneTarget)].join(" "));

  try {
    const clone = execa("git", ["clone", "--depth", "1", ...branchArgs, cloneTarget, directory], {
      env: {
        // Ingen interaktiv passordprompt – manglende tilgang skal feile raskt og
        // tydelig i stedet for å henge til build-timeouten slår inn.
        GIT_TERMINAL_PROMPT: "0",
        GIT_ASKPASS: "echo",
      },
    });
    clone.stderr?.on("data", (chunk: Buffer) => logs.write(redactCredentials(chunk.toString())));
    await clone;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const detail = message.split("\n")[0] ?? message;

    // En gren som ikke finnes gir en helt annen feil enn manglende tilgang, og
    // skal si det. Uten dette leste meldingen «Er repoet offentlig?» på et repo
    // som er både offentlig og klonbart – feilen lå i ett tegn i et
    // innstillingsfelt, og ingenting pekte dit.
    if (wanted && MISSING_BRANCH.test(message)) {
      throw new DeployError(
        "clone",
        `Grenen «${wanted}» finnes ikke i repositoryet. Sjekk stavemåten under ` +
          "Innstillinger, eller la feltet stå tomt for å bygge repoets standardgren.",
      );
    }

    throw new DeployError(
      "clone",
      installationId
        ? `Kunne ikke klone repositoryet. Har Snoat fortsatt tilgang til det på GitHub? (${redactCredentials(detail)})`
        : `Kunne ikke klone repositoryet. Er det offentlig? (${redactCredentials(detail)})`,
    );
  }

  const { stdout: commitHash } = await execa("git", ["-C", directory, "rev-parse", "HEAD"]);

  // Hvilken gren ble faktisk bygget? Spørsmålet dukker opp hver gang noen lurer
  // på hvorfor en endring ikke er med, og svaret skal stå i loggen – også når
  // prosjektet ikke har valgt noen gren, for da er det GitHub som bestemte.
  const checkedOut = await execa("git", ["-C", directory, "rev-parse", "--abbrev-ref", "HEAD"])
    .then((result) => result.stdout.trim())
    .catch(() => null);

  logs.write(
    wanted
      ? `Gren: ${wanted}`
      : `Gren: ${checkedOut ?? "ukjent"} (repoets standardgren – ingen gren er valgt for prosjektet)`,
  );
  logs.write(`Commit: ${commitHash}`);

  return { directory, commitHash: commitHash.trim(), branch: wanted ?? checkedOut };
}

/** Rydder bort kildekoden etter en deployment. Imaget er det vi trenger videre. */
export async function cleanupWorkspace(projectId: string, deploymentId: string): Promise<void> {
  await rm(workspaceFor(projectId, deploymentId), { recursive: true, force: true });
}
