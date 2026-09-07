import { config } from "../config.js";
import { docker } from "../lib/docker.js";
import { logger } from "../lib/logger.js";
import { parseStderr } from "../lib/stderr-parse.js";
import { supabase } from "../lib/supabase.js";
import type { Project } from "../types.js";
import * as containers from "./containers.js";
import { recordError } from "./error-ingest.js";

/**
 * Ufangede unntak i appenes egne prosesser, lest ut av containernes stderr.
 *
 * ## Hvorfor et sveip og ikke en strøm
 *
 * Den åpenbare løsningen er å holde en `docker logs --follow` per container.
 * Den er også feil her: hver strøm er en åpen socket mot Docker-demonen som må
 * gjenopprettes hver gang en container byttes ut – og det skjer ved hver eneste
 * utrulling, for hver app. Femti apper ville betydd femti strømmer å holde
 * levende gjennom hver deploy, og en lekket strøm per feilet gjenoppkobling.
 *
 * Sveipet spør i stedet med `since` og henter kun det som har kommet siden
 * forrige runde. Prisen er at en feil kan ligge inntil ett intervall før den
 * dukker opp. For noe som leses av et menneske om morgenen, eller av en agent
 * kl. 05:00, er det ingen pris i det hele tatt.
 *
 * ## Hva som regnes som en feil
 *
 * stderr er ikke et feillogg-felt. Rammeverk skriver oppstartsbanner,
 * advarsler om utdaterte pakker og fremdriftsindikatorer dit. `parseStderr()`
 * plukker derfor ut det som faktisk har form som et unntak, og forkaster
 * resten. Det gir falske negativer – en app som logger feilene sine i et format
 * vi ikke kjenner, blir ikke fanget – og det er riktig vei å bomme. Et
 * feilverktøy som roper om hver `npm WARN deprecated` blir slått av.
 */

/**
 * Hvor langt hvert prosjekt er lest.
 *
 * Kun i minnet. En omstart av backend betyr at vi begynner på nytt ett intervall
 * tilbake – og siden feil grupperes på fingerprint, blir en feil vi allerede har
 * sett bare en høyere teller, ikke en ny rad. Å lagre dette i basen ville løst
 * et problem som ikke finnes.
 */
const readUpTo = new Map<string, number>();

async function sweepProject(project: Project, sinceSeconds: number): Promise<void> {
  const name = await containers.currentContainerName(project);
  if (!name) return;

  const stream = await docker.getContainer(name).logs({
    stdout: false,
    stderr: true,
    since: sinceSeconds,
    timestamps: true,
    // Uansett hvor mye som har kommet siden sist: en app i loggstorm skal ikke
    // kunne dra hele bufferet sitt inn i minnet vårt hvert sveip.
    tail: 500,
  });

  const text = Buffer.isBuffer(stream) ? stream.toString("utf-8") : String(stream);
  if (!text.trim()) return;

  for (const exception of parseStderr(text)) {
    recordError({
      projectId: project.id,
      kind: "server",
      message: exception.message,
      file: exception.file,
      line: exception.line,
      col: exception.col,
      stack: exception.stack,
    });
  }
}

/** Ett sveip. Eksportert slik at det kan kjøres manuelt fra et skript. */
export async function sweepRuntimeErrors(): Promise<void> {
  const { data, error } = await supabase
    .from("projects")
    .select("*")
    .is("stopped_at", null)
    .is("static_output_dir", null);

  if (error) {
    logger.warn({ err: error.message }, "Kunne ikke lese prosjekter for feilsveipet");
    return;
  }

  const projects = (data ?? []) as Project[];
  const running = await containers.runningProjectIds();
  const now = Math.floor(Date.now() / 1000);
  const window = Math.ceil(config.SNOAT_ERRORS_STDERR_SWEEP_MS / 1000);

  for (const project of projects) {
    if (!running.has(project.id)) continue;

    const since = readUpTo.get(project.id) ?? now - window;
    readUpTo.set(project.id, now);

    try {
      await sweepProject(project, since);
    } catch (err: unknown) {
      // En container kan forsvinne mellom listingen og logg-kallet. Det er ikke
      // en feil verdt å rope om – helsesveipet er det som eier den tilstanden.
      logger.debug({ project: project.name, err }, "Kunne ikke lese stderr");
    }
  }
}

export function startRuntimeErrorSweep(): void {
  const run = () => {
    void sweepRuntimeErrors().catch((error: unknown) => {
      logger.error({ err: error }, "stderr-sveipet feilet");
    });
  };

  setInterval(run, config.SNOAT_ERRORS_STDERR_SWEEP_MS).unref();

  // Første kjøring venter ett intervall. Ved oppstart er det uansett ingenting
  // nytt å lese, og backend har viktigere ting å gjøre de første sekundene.
  setTimeout(run, config.SNOAT_ERRORS_STDERR_SWEEP_MS).unref();

  logger.info(
    { intervalMs: config.SNOAT_ERRORS_STDERR_SWEEP_MS },
    "stderr-sveip aktivt – ufangede unntak i appene havner i feilsporingen",
  );
}
