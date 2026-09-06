import { config } from "../config.js";
import { logger } from "../lib/logger.js";
import { supabase } from "../lib/supabase.js";
import type { Project } from "../types.js";
import * as containers from "./containers.js";
import { notifyContainerRecovered, notifyContainerUnhealthy } from "./notify.js";

/**
 * Oppdager at en container har dødd, og retter tilstanden i basen.
 *
 * ## Hendelsen som viste at dette manglet
 *
 * `eierfullstack` sto som `success`/Live i produksjon lenge etter at containeren
 * var borte: `docker stats` viste `0B / 0B` på `snoat-app-eierfullstack-…`, Caddy
 * hadde fortsatt ruten, og `eierfullstack.snoat.com` svarte 502. To ting gjorde
 * at ingen merket det:
 *
 *   1. **Helsesjekken ved utrulling er ett vindu.** `assertStillRunning()` i
 *      `containers.ts` sjekker at containeren står stabilt i `SNOAT_STABLE_FOR_MS`
 *      rett etter oppstart – og aldri mer. En container som dør en time, en dag
 *      eller en uke senere er utenfor det vinduet.
 *   2. **`reconcileRoutes()` kjører bare ved backend-oppstart** (`index.ts`).
 *      Restarter ikke backend, blir avviket stående for alltid.
 *
 * ## Hva sveipet gjør
 *
 * Periodisk (hvert `SNOAT_HEALTH_CHECK_INTERVAL_MS`, standard 2 minutter):
 * finn hvert prosjekt som databasen påstår har en kjørende container – ikke
 * stoppet, ikke statisk (statiske sider har ingen container å miste), og med
 * minst én vellykket deployment – og sammenlign mot hva Docker faktisk har
 * (`containers.runningProjectIds()`, samme ett-kalls-oppslag reconcile og
 * plangrensene bruker).
 *
 * Finner sveipet et avvik, **rettes basen**: `projects.container_died_at` settes
 * til tidspunktet avviket ble oppdaget. Det er den bokstavelige rettelsen
 * problemet krevde – en app stemplet `success` skal ikke få lov til å stå som
 * «Live» i dashboardet når den ikke svarer. Kommer containeren tilbake (Docker
 * sin egen `on-failure`-restart lyktes til slutt, eller noen rettet det manuelt),
 * nullstilles feltet på samme måte.
 *
 * ## Hva sveipet bevisst IKKE gjør
 *
 * Det rører verken Docker eller Caddy. Ingen restart, ingen sletting, ingen
 * omdirigering av ruten bort fra den døde containeren – bare det å oppdage
 * avviket og rette *databasens* påstand om det. Caddy-ruten blir stående til en
 * ny deployment bytter den, eller til noen griper inn manuelt; se
 * `CONTEXT_FOR_AI/03_deployment_flow.md` for hvorfor det ikke er sveipets jobb å
 * gjøre det ene eller det andre.
 */

interface HealthMismatch {
  project: Project;
  detail: string;
}

/**
 * Prosjektene som *skal* ha en kjørende container akkurat nå: ikke stoppet av
 * brukeren, ikke statisk, og med minst én vellykket deployment. Et prosjekt som
 * aldri er deployet er ikke et avvik – det har aldri påstått å kjøre noe.
 */
async function candidateProjects(): Promise<Project[]> {
  const { data, error } = await supabase
    .from("projects")
    .select("*")
    .is("stopped_at", null)
    .is("static_output_dir", null);

  if (error) throw new Error(`Kunne ikke lese prosjekter: ${error.message}`);

  const rows = (data ?? []) as Project[];
  if (rows.length === 0) return [];

  const { data: deployedRows, error: deployedError } = await supabase
    .from("deployments")
    .select("project_id")
    .eq("status", "success")
    .in(
      "project_id",
      rows.map((project) => project.id),
    );

  if (deployedError) {
    throw new Error(`Kunne ikke lese vellykkede deployments: ${deployedError.message}`);
  }

  const hasSuccess = new Set((deployedRows ?? []).map((row) => row.project_id as string));
  return rows.filter((project) => hasSuccess.has(project.id));
}

/** Ett sveip. Eksportert slik at det kan kjøres manuelt fra et skript. */
export async function sweepContainerHealth(): Promise<{ diedNow: number; recovered: number }> {
  const candidates = await candidateProjects();
  if (candidates.length === 0) return { diedNow: 0, recovered: 0 };

  // Ett Docker-kall for hele verten, ikke ett per prosjekt – samme mønster som
  // plangrensene bruker (`containers.runningProjectIds()`), og av samme grunn:
  // en installasjon med hundrevis av prosjekter skal ikke koste hundrevis av kall
  // hvert sveip.
  const running = await containers.runningProjectIds();

  const diedNow: HealthMismatch[] = [];
  const recovered: Project[] = [];

  for (const project of candidates) {
    const shouldBeRunning = running.has(project.id);
    const alreadyMarkedDead = Boolean(project.container_died_at);

    if (!shouldBeRunning && !alreadyMarkedDead) {
      diedNow.push({
        project,
        detail: `Ingen kjørende container for prosjektet, men siste deployment er «success» og prosjektet er ikke stoppet.`,
      });
    } else if (shouldBeRunning && alreadyMarkedDead) {
      recovered.push(project);
    }
  }

  if (diedNow.length > 0) {
    const { error } = await supabase
      .from("projects")
      .update({ container_died_at: new Date().toISOString() })
      .in(
        "id",
        diedNow.map(({ project }) => project.id),
      );

    if (error) {
      // Databasen er fasiten dashboardet leser – rekker ikke oppdateringen fram,
      // fortsetter appene å stå som Live. Neste sveip prøver igjen.
      logger.error({ err: error, projects: diedNow.map(({ project }) => project.name) },
        "Kunne ikke rette container_died_at etter et helseavvik");
    } else {
      for (const { project, detail } of diedNow) {
        logger.error({ project: project.name, projectId: project.id }, `Container død: ${detail}`);
        void notifyContainerUnhealthy(project, detail).catch((err: unknown) => {
          logger.warn({ project: project.name, err }, "Kunne ikke sende helsevarsel");
        });
      }
    }
  }

  if (recovered.length > 0) {
    const { error } = await supabase
      .from("projects")
      .update({ container_died_at: null })
      .in(
        "id",
        recovered.map((project) => project.id),
      );

    if (error) {
      logger.error({ err: error, projects: recovered.map((project) => project.name) },
        "Kunne ikke nullstille container_died_at etter at containeren kom tilbake");
    } else {
      for (const project of recovered) {
        logger.info({ project: project.name, projectId: project.id }, "Container tilbake – basen rettet til Live");
        void notifyContainerRecovered(project).catch((err: unknown) => {
          logger.warn({ project: project.name, err }, "Kunne ikke sende helsevarsel");
        });
      }
    }
  }

  return { diedNow: diedNow.length, recovered: recovered.length };
}

/**
 * Nullstiller avviket for ett prosjekt umiddelbart. Kalt fra `deploy.ts` når en
 * deployment lykkes.
 *
 * Uten dette kunne et prosjekt som nettopp ble reddet med en ny, frisk
 * deployment fortsatt vist «Nede» i opptil `SNOAT_HEALTH_CHECK_INTERVAL_MS` til
 * neste sveip oppdaget det selv – nøyaktig den typen løgn i grensesnittet
 * denne funksjonen finnes for å luke ut, bare i motsatt retning. En vellykket
 * deployment er det sterkeste beviset som finnes på at containeren lever, så
 * sveipet trenger ikke bekrefte det på nytt før basen rettes tilbake.
 *
 * Kaster aldri: en pipeline som nettopp lyktes skal ikke kunne feile på denne
 * siste, rent kosmetiske rettelsen.
 */
export async function clearHealthFlag(project: Project): Promise<void> {
  const { error } = await supabase
    .from("projects")
    .update({ container_died_at: null })
    .eq("id", project.id);

  if (error) {
    logger.warn(
      { project: project.name, err: error },
      "Kunne ikke nullstille container_died_at etter en vellykket deployment",
    );
  }
}

/**
 * Starter sveipet i bakgrunnen.
 *
 * `unref()` gjør at timeren ikke alene holder Node i live – uten den nekter
 * prosessen å avslutte pent på SIGTERM. Kjører også én gang ved oppstart: var
 * backend nede da en container døde, skal avviket oppdages med en gang, ikke
 * først om `SNOAT_HEALTH_CHECK_INTERVAL_MS`.
 */
export function startHealthSweep(): void {
  const run = () => {
    void sweepContainerHealth().catch((error: unknown) => {
      logger.error({ err: error }, "Containerhelse-sveipet feilet");
    });
  };

  run();
  setInterval(run, config.SNOAT_HEALTH_CHECK_INTERVAL_MS).unref();

  logger.info(
    { intervalMs: config.SNOAT_HEALTH_CHECK_INTERVAL_MS },
    "Containerhelse-sveip aktivt – sammenligner det basen påstår mot det Docker faktisk har",
  );
}
