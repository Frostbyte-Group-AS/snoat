import { randomBytes } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { config } from "../config.js";

/**
 * Snoat oppdaterer seg selv fra main – denne siden av det.
 *
 * Selve utrullingen gjøres av `infra/selvoppdatering/snoat-selvoppdatering` på
 * verten, utenfor containerne: den restarter backend og Caddy, og kan ikke
 * kjøre inne i noen av dem. Backend leser bare filene skriptet legger igjen, og
 * skriver bestillinger skriptet plukker opp (en systemd path-enhet starter det
 * med en gang en fil dukker opp i `jobber/`).
 *
 * Filene er hele grensesnittet med vilje. Det finnes ingen socket, ingen port og
 * ingen databasetabell mellom de to – en ødelagt backend kan derfor ikke hindre
 * at forrige versjon rulles ut igjen, og en ødelagt utrulling kan ikke ta med
 * seg historikken.
 */

const DIR = config.SNOAT_SELVOPPDATERING_DIR;
const BYGG_ID = /^\d{8}T\d{6}Z-[0-9a-f]{1,7}$/;
const COMMIT = /^[0-9a-f]{7,40}$/;
const MAKS_LOGG = 400_000;

export type ByggStatus = "bygger" | "ok" | "feilet" | "rullet_tilbake";

export interface Bygg {
  id: string;
  commit: string;
  melding: string;
  kilde: "main" | "manuell";
  bestiltAv: string | null;
  forrigeCommit: string | null;
  status: ByggStatus;
  startet: string;
  ferdig: string | null;
  feil: string | null;
}

export interface PlattformStatus {
  /** Skriptet er installert og har kjørt minst én gang. */
  aktivert: boolean;
  repo: string;
  deployetCommit: string | null;
  mainCommit: string | null;
  /** Main-commiten som feilet sist; prøves ikke automatisk før main flytter seg. */
  feiletCommit: string | null;
  pause: boolean;
  kjorer: boolean;
  sistSjekket: string | null;
  ventendeBestillinger: number;
  bygg: Bygg[];
}

export class SelvoppdateringError extends Error {
  constructor(
    readonly status: 400 | 404 | 409 | 503,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "SelvoppdateringError";
  }
}

async function lesTekst(fil: string): Promise<string | null> {
  try {
    return (await readFile(join(DIR, fil), "utf8")).trim() || null;
  } catch {
    return null;
  }
}

async function finnes(fil: string): Promise<boolean> {
  return await stat(join(DIR, fil)).then(
    () => true,
    () => false,
  );
}

async function lesJson<T>(fil: string): Promise<T | null> {
  const tekst = await lesTekst(fil);
  if (!tekst) return null;
  try {
    return JSON.parse(tekst) as T;
  } catch {
    return null;
  }
}

async function antallFiler(mappe: string, slutt: string): Promise<string[]> {
  try {
    return (await readdir(join(DIR, mappe))).filter((navn) => navn.endsWith(slutt));
  } catch {
    return [];
  }
}

export async function hentStatus(antallBygg = 20): Promise<PlattformStatus> {
  const status = await lesJson<{ sjekket?: string; main?: string; kjorer?: boolean }>("status.json");

  // Filnavnene begynner med tidsstempelet, så navnesortering er tidssortering.
  const filer = (await antallFiler("bygg", ".json")).sort().reverse().slice(0, antallBygg);
  const bygg = (await Promise.all(filer.map((navn) => lesJson<Bygg>(join("bygg", navn))))).filter(
    (b): b is Bygg => b !== null,
  );

  return {
    aktivert: status !== null,
    repo: "Frostbyte-Group-AS/snoat",
    deployetCommit: await lesTekst("deployet-commit"),
    mainCommit: status?.main || null,
    feiletCommit: await lesTekst("feilet-commit"),
    pause: await finnes("pause"),
    kjorer: status?.kjorer === true,
    sistSjekket: status?.sjekket ?? null,
    ventendeBestillinger: (await antallFiler("jobber", ".json")).length,
    bygg,
  };
}

export async function hentLogg(byggId: string): Promise<string> {
  if (!BYGG_ID.test(byggId)) {
    throw new SelvoppdateringError(400, "plattform.ugyldig_bygg", "Ugyldig bygg-ID.");
  }
  const logg = await lesTekst(join("bygg", `${byggId}.log`));
  if (logg === null) {
    throw new SelvoppdateringError(404, "plattform.ukjent_bygg", "Fant ingen logg for bygget.");
  }
  // Et bygg som feiler tidlig er kort; ett som går hele veien er noen hundre
  // kilobyte med docker-utskrift. Slutten er der feilen står.
  return logg.length > MAKS_LOGG ? `… (avkortet)\n${logg.slice(-MAKS_LOGG)}` : logg;
}

async function krevAktivert(): Promise<void> {
  if (!(await finnes("status.json"))) {
    throw new SelvoppdateringError(
      503,
      "plattform.ikke_installert",
      "Selvoppdateringen er ikke installert på serveren (infra/selvoppdatering/installer).",
    );
  }
}

/**
 * Ber verten deploye. Uten commit: main slik den er når skriptet starter. Med:
 * den commiten, som må ligge på main – skriptet sjekker det, siden det er der
 * git-klonen er.
 */
export async function bestill(commit: string | null, bestiltAv: string): Promise<{ bestilt: true }> {
  await krevAktivert();

  if (commit !== null && !COMMIT.test(commit)) {
    throw new SelvoppdateringError(400, "plattform.ugyldig_commit", "Commit må være en SHA (7–40 heksadesimale tegn).");
  }

  const jobber = join(DIR, "jobber");
  await mkdir(jobber, { recursive: true });

  // Skrives til en midlertidig fil og flyttes på plass: path-enheten reagerer på
  // `*.json`, og skal aldri se en halvskrevet bestilling.
  const navn = `${Date.now()}-${randomBytes(4).toString("hex")}`;
  const tmp = join(jobber, `${navn}.tmp`);
  await writeFile(tmp, JSON.stringify({ commit, bestiltAv, bestilt: new Date().toISOString() }));
  await rename(tmp, join(jobber, `${navn}.json`));
  return { bestilt: true };
}

/** Pause stopper bare den automatiske utrullingen av main; bestillinger går. */
export async function settPause(pause: boolean): Promise<{ pause: boolean }> {
  await krevAktivert();
  const fil = join(DIR, "pause");
  if (pause) await writeFile(fil, `${new Date().toISOString()}\n`);
  else await rm(fil, { force: true });
  return { pause };
}
