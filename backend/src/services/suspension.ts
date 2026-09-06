import { config } from "../config.js";
import { logger } from "../lib/logger.js";
import { supabase } from "../lib/supabase.js";
import type { Project, Subscription } from "../types.js";
import * as containers from "./containers.js";
import { teardownProject } from "./deploy.js";
import { entitlementFrom, PLAN_LIMITS, runningOverLimit } from "./plans.js";

/**
 * Stopper apper som ligger over gratisgrensen etter at nådefristen for en
 * feilet betaling er ute.
 *
 * ⚠️ **Dette er den ene mekanismen i plattformen som tar ned kjørende
 * kundeapper uten at et menneske trykker på noe.** Den er derfor bygget etter
 * tre regler:
 *
 *   1. **Nådefristen først.** `entitlementFrom()` avgjør – ikke denne filen – om
 *      kunden faktisk har falt til gratisnivå. Så lenge Stripe prøver kortet på
 *      nytt, skjer det ingenting. Et utløpt kort skal ikke koste noen
 *      produksjonen sin mens dunning pågår.
 *   2. **Bare det som er over grensen.** Kunden beholder det gratisplanen gir.
 *      Vi stopper de *nyeste* appene og lar de eldste stå, fordi den eldste
 *      oftest er den viktigste.
 *
 *      ⚠️ «Grensen» er fra 6. september 2026 **to** tall, ikke ett:
 *      `maxRunningProjects` og `maxRunningDevSites`, kappet hver for seg av
 *      `runningOverLimit()`. Beholdt vi den gamle blandede tellingen her, ville
 *      sveipet talt en dev-side som en app – og da kunne en konto blitt fratatt
 *      en produksjonsapp for å gi plass til et testmiljø gratisplanen uansett
 *      ikke tillater. Merk konsekvensen: gratisplanen har null dev-sider, så en
 *      konto som er falt ut av nådeperioden mister *alle* dev-sidene sine, også
 *      den eldste. Det er tilsiktet – det er selve funksjonen som er betalt.
 *   3. **Av som standard.** `SNOAT_BILLING_SUSPEND_ENABLED` styrer om sveipet
 *      handler eller bare logger hva det ville gjort. Slå den på først når
 *      dunning-flyten er observert i produksjon.
 *
 * Prosjektet slettes aldri. `teardownProject` fjerner ruten og containerne;
 * raden, historikken og miljøvariablene står urørt, og en ny deployment etter
 * betaling setter alt tilbake.
 */

/** Hvor ofte sveipet kjører. Timesoppløsning holder for en nådefrist på dager. */
const SWEEP_INTERVAL_MS = 60 * 60 * 1000;

interface SuspensionCandidate {
  userId: string;
  billedPlan: string;
  projects: Project[];
}

/**
 * Kontoene som har falt ut av nådeperioden og kjører flere apper enn
 * gratisplanen tillater.
 */
async function candidates(): Promise<SuspensionCandidate[]> {
  const { data, error } = await supabase
    .from("subscriptions")
    .select("*")
    .in("status", ["past_due", "unpaid", "canceled"]);

  if (error) throw new Error(`Kunne ikke lese forfalte abonnement: ${error.message}`);

  const delinquent = (data ?? []) as Subscription[];
  if (delinquent.length === 0) return [];

  const running = await containers.runningProjectIds();
  const found: SuspensionCandidate[] = [];

  for (const subscription of delinquent) {
    const entitlement = entitlementFrom(subscription);

    // Fortsatt innenfor fristen, eller allerede på Free uten noe å miste.
    if (!entitlement.downgraded) continue;

    const { data: projectRows, error: projectError } = await supabase
      .from("projects")
      .select("*")
      .eq("user_id", subscription.user_id)
      .order("created_at", { ascending: true });

    if (projectError) {
      logger.warn(
        { userId: subscription.user_id, err: projectError },
        "Kunne ikke lese prosjektene til en forfalt konto",
      );
      continue;
    }

    // Radene kommer eldste først (`order("created_at")` over), og
    // `runningOverLimit()` bygger på nettopp det: den beholder starten av hver
    // liste og gir tilbake halen. Apper måles mot `maxRunningProjects`,
    // dev-sider mot `maxRunningDevSites` – samme deling som `assertCanDeploy()`
    // bruker, fra samme kilde, slik at de to ikke kan komme i utakt.
    const overLimit = runningOverLimit(
      (projectRows ?? []) as Project[],
      running,
      PLAN_LIMITS.free,
    );

    if (overLimit.length === 0) continue;

    found.push({
      userId: subscription.user_id,
      billedPlan: subscription.plan,
      projects: overLimit,
    });
  }

  return found;
}

/** Ett sveip. Eksportert slik at den kan kjøres manuelt fra et skript. */
export async function sweepSuspensions(): Promise<{ suspended: number; wouldSuspend: number }> {
  const targets = await candidates();
  let suspended = 0;
  let wouldSuspend = 0;

  for (const target of targets) {
    for (const project of target.projects) {
      if (!config.SNOAT_BILLING_SUSPEND_ENABLED) {
        wouldSuspend += 1;
        logger.warn(
          { userId: target.userId, project: project.name, plan: target.billedPlan },
          "Ville suspendert appen (SNOAT_BILLING_SUSPEND_ENABLED er av)",
        );
        continue;
      }

      try {
        await teardownProject(project);
        suspended += 1;
        logger.warn(
          { userId: target.userId, project: project.name, plan: target.billedPlan },
          "App suspendert – betalingen har feilet og nådefristen er ute",
        );
      } catch (error) {
        // Én app som ikke lot seg stoppe skal ikke stoppe resten av sveipet.
        logger.error(
          { userId: target.userId, project: project.name, err: error },
          "Kunne ikke suspendere appen",
        );
      }
    }
  }

  if (suspended > 0 || wouldSuspend > 0) {
    logger.info({ suspended, wouldSuspend }, "Suspensjonssveip fullført");
  }

  return { suspended, wouldSuspend };
}

/**
 * Starter sveipet i bakgrunnen.
 *
 * `unref()` gjør at timeren ikke holder Node i live på egen hånd – serveren gjør
 * allerede den jobben, og uten den ville prosessen nektet å avslutte pent på
 * SIGTERM.
 *
 * Kjører også én gang ved oppstart. Var backend nede da en nådefrist løp ut,
 * skal det oppdages med en gang og ikke om en time.
 */
export function startSuspensionSweep(): void {
  const run = () => {
    void sweepSuspensions().catch((error: unknown) => {
      logger.error({ err: error }, "Suspensjonssveipet feilet");
    });
  };

  run();
  setInterval(run, SWEEP_INTERVAL_MS).unref();

  logger.info(
    {
      intervalMinutes: SWEEP_INTERVAL_MS / 60_000,
      enabled: config.SNOAT_BILLING_SUSPEND_ENABLED,
      graceDays: config.SNOAT_BILLING_GRACE_DAYS,
    },
    config.SNOAT_BILLING_SUSPEND_ENABLED
      ? "Suspensjonssveip aktivt – apper over gratisgrensen stoppes etter nådefristen"
      : "Suspensjonssveip kjører i tørrmodus – logger hva det ville gjort",
  );
}
