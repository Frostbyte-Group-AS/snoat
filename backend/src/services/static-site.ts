import { execa } from "execa";
import { mkdir, readdir, readlink, rm, stat } from "node:fs/promises";
import path from "node:path";
import { config } from "../config.js";
import { logger } from "../lib/logger.js";
import { DeployError, type Project } from "../types.js";
import type { LogStream } from "./log-stream.js";

/**
 * Publisering av prosjekter som bare er filer.
 *
 * En statisk side har ingen prosess å holde i live. Vi bygger den fortsatt med
 * nixpacks – rammeverksdeteksjonen og byggecachen er like nyttig – men i stedet
 * for å starte en container henter vi ut byggeresultatet og lar Caddy servere
 * det fra disk. Kostnaden ved en side ingen besøker går da fra «en container med
 * minnetak» til null.
 *
 * Vi gjetter aldri på om et prosjekt er statisk. `projects.static_output_dir`
 * settes av brukeren, fordi et feilgjett gir en side som ser levende ut helt til
 * noe server-side kalles – og det er en verre feil enn å kjøre en container for
 * mye.
 */

/** Katalogen én bestemt deployment av en side ligger i. */
export function siteDirFor(projectId: string, deploymentId: string): string {
  return path.join(config.SNOAT_SITES_DIR, projectId, deploymentId);
}

/**
 * Godtar bare en enkel relativ katalogsti.
 *
 * Verdien kommer fra et skjema i UI-et og havner i et `docker cp`-argument og i
 * en filsti på verten. Databasen har samme constraint, men service-role-nøkkelen
 * omgår ikke bare RLS – den omgår også den. Derfor sjekkes det her også, der det
 * faktisk brukes.
 */
export function assertSafeOutputDir(dir: string): string {
  const trimmed = dir.trim().replace(/^\.\//, "").replace(/\/+$/, "");

  if (trimmed === "" || trimmed.length > 128) {
    throw new DeployError("static", `Ugyldig output-katalog: «${dir}»`);
  }

  if (path.isAbsolute(trimmed) || trimmed.split("/").includes("..")) {
    throw new DeployError(
      "static",
      `Output-katalogen må være en relativ sti uten «..» – fikk «${dir}».`,
    );
  }

  if (!/^[A-Za-z0-9._][A-Za-z0-9._/-]*$/.test(trimmed)) {
    throw new DeployError("static", `Output-katalogen inneholder ugyldige tegn: «${dir}»`);
  }

  return trimmed;
}

/**
 * Henter byggeresultatet ut av image-et og legger det på det delte volumet.
 *
 * Image-et startes aldri. `docker create` materialiserer bare filsystemet, vi
 * kopierer ut katalogen vi er ute etter, og fjerner containeren igjen – ingen
 * prosess har kjørt, og ingenting blir stående etterpå.
 *
 * Hver deployment får sin egen katalog. Ruten byttes først når filene ligger der,
 * så en feilet publisering lar den forrige versjonen stå urørt.
 */
export async function publishStaticSite(
  project: Project,
  deploymentId: string,
  image: string,
  logs: LogStream,
): Promise<string> {
  const outputDir = assertSafeOutputDir(project.static_output_dir ?? "");
  const destination = siteDirFor(project.id, deploymentId);

  logs.step("Publiserer statiske filer");
  logs.write(`Henter /app/${outputDir} ut av image-et.`);

  await rm(destination, { recursive: true, force: true });
  await mkdir(destination, { recursive: true });

  const { stdout: containerId } = await execa("docker", ["create", image]);
  const created = containerId.trim();

  try {
    // Etterstilt `/.` kopierer *innholdet* i katalogen inn i destinasjonen, i
    // stedet for å legge katalogen selv inni den.
    await execa("docker", ["cp", `${created}:/app/${outputDir}/.`, destination]);
  } catch (error) {
    await rm(destination, { recursive: true, force: true }).catch(() => undefined);

    const detail = error instanceof Error ? error.message.split("\n")[0] : String(error);
    throw new DeployError(
      "static",
      `Fant ikke katalogen «${outputDir}» i byggeresultatet. Sjekk at prosjektet ` +
        `faktisk bygger til den katalogen – Vite bruker «dist», Next.js med ` +
        `output: 'export' bruker «out», Astro bruker «dist». (${detail})`,
    );
  } finally {
    await execa("docker", ["rm", "-f", created]).catch((error: unknown) => {
      logger.warn({ container: created, err: error }, "Kunne ikke rydde midlertidig container");
    });
  }

  const removed = await removeEscapingSymlinks(destination);
  if (removed.length > 0) {
    logs.write(
      `Fjernet ${removed.length} symbolsk(e) lenke(r) som pekte ut av «${outputDir}»: ` +
        removed.slice(0, 5).join(", ") +
        (removed.length > 5 ? " …" : ""),
    );
  }

  const { files, bytes } = await measure(destination);

  if (files === 0) {
    await rm(destination, { recursive: true, force: true }).catch(() => undefined);
    throw new DeployError("static", `Katalogen «${outputDir}» er tom i byggeresultatet.`);
  }

  // En statisk side uten index.html gir 404 på forsiden. Det er nesten alltid
  // feil katalog, og det er langt bedre å si det nå enn å la kunden oppdage en
  // tom nettside selv.
  const hasIndex = await stat(path.join(destination, "index.html")).then(
    () => true,
    () => false,
  );

  if (!hasIndex) {
    logs.write(
      `Advarsel: fant ingen index.html i «${outputDir}». Er dette riktig output-katalog?`,
    );
  }

  // Ingen sporingskode skrives inn i filene her. Caddy serverer dem uendret,
  // og statistikken hentes ut av access-loggen i stedet – se
  // `services/analytics-ingest.ts`. Det som ligger i katalogen er nøyaktig det
  // kunden bygget.

  logs.write(`${files} filer (${formatBytes(bytes)}) klare til servering.`);

  return destination;
}

/**
 * Fjerner gamle versjoner av en side, men beholder den som serveres nå.
 *
 * De gjenværende katalogene er det som gjør en fremtidig «rull tilbake» til et
 * rutebytte i stedet for en ny build.
 */
export async function pruneOldSites(projectId: string, keepDeploymentId: string): Promise<void> {
  const projectDir = path.join(config.SNOAT_SITES_DIR, projectId);

  let entries: string[];
  try {
    entries = await readdir(projectDir);
  } catch {
    return;
  }

  const others = entries.filter((entry) => entry !== keepDeploymentId);
  if (others.length === 0) return;

  const withTime = await Promise.all(
    others.map(async (entry) => {
      const modified = await stat(path.join(projectDir, entry)).then(
        (info) => info.mtimeMs,
        () => 0,
      );
      return { entry, modified };
    }),
  );

  withTime.sort((a, b) => b.modified - a.modified);

  // Den som serveres nå teller som én av versjonene vi beholder.
  for (const { entry } of withTime.slice(config.SNOAT_STATIC_KEEP_VERSIONS - 1)) {
    await rm(path.join(projectDir, entry), { recursive: true, force: true }).catch(
      (error: unknown) => {
        logger.warn({ projectId, entry, err: error }, "Kunne ikke rydde gammel statisk versjon");
      },
    );
  }
}

/** Fjerner alle filer for et prosjekt. Brukes når prosjektet slettes. */
export async function removeProjectSites(projectId: string): Promise<void> {
  await rm(path.join(config.SNOAT_SITES_DIR, projectId), { recursive: true, force: true });
}

/**
 * Fjerner symbolske lenker som peker ut av den publiserte katalogen.
 *
 * `docker cp` tar med lenkene fra imaget ordrett, og Caddys `file_server` følger
 * dem. En lenke som `dist/k -> /data/caddy/certificates/...` ville ellers latt
 * hvem som helst laste ned filer fra Caddy-containeren – TLS-privatnøklene og
 * ACME-kontonøkkelen ligger i `/data`. Lenker som holder seg innenfor katalogen
 * (relative lenker mellom egne filer) får stå.
 *
 * Målet vurderes leksikalt, ikke med `realpath`: lenken skal tolkes slik Caddy
 * ville tolket den, og målet finnes ofte ikke i backend-containeren i det hele
 * tatt. En lenke til en annen lenke vurderes for seg, så kjeder som til slutt
 * peker ut, brytes der de forlater katalogen.
 *
 * Eksportert for test.
 */
export async function removeEscapingSymlinks(root: string): Promise<string[]> {
  const removed: string[] = [];
  const base = path.resolve(root);

  const walk = async (current: string): Promise<void> => {
    const entries = await readdir(current, { withFileTypes: true });

    for (const entry of entries) {
      const full = path.join(current, entry.name);

      if (entry.isSymbolicLink()) {
        const target = await readlink(full);
        const resolved = path.resolve(path.dirname(full), target);
        if (resolved !== base && !resolved.startsWith(base + path.sep)) {
          await rm(full, { force: true });
          removed.push(path.relative(base, full));
        }
      } else if (entry.isDirectory()) {
        await walk(full);
      }
    }
  };

  await walk(base);
  return removed;
}

async function measure(directory: string): Promise<{ files: number; bytes: number }> {
  let files = 0;
  let bytes = 0;

  const walk = async (current: string): Promise<void> => {
    const entries = await readdir(current, { withFileTypes: true });

    for (const entry of entries) {
      const full = path.join(current, entry.name);

      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile()) {
        files += 1;
        bytes += await stat(full).then((info) => info.size, () => 0);
      }
    }
  };

  await walk(directory);

  return { files, bytes };
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} kB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
