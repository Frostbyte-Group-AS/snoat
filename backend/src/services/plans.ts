import { config } from "../config.js";
import { logger } from "../lib/logger.js";
import { supabase } from "../lib/supabase.js";
import {
  DeployError,
  type Project,
  type Subscription,
  type SubscriptionTier,
} from "../types.js";
import * as containers from "./containers.js";

/**
 * Hva en plan gir. Dette er den eneste definisjonen av grensene i backend –
 * `containers.ts` og `deploy.ts` leser herfra, ikke fra `config`.
 */
export interface PlanLimits {
  /** Samtidig kjørende dynamiske apper. Statiske sider teller ikke. */
  maxRunningProjects: number;
  /** Minne per container, i MB. */
  memoryMb: number;
  /** CPU-andel per container. */
  cpus: number;
  /** Byggeminutter per kalendermåned, på tvers av alle prosjekter. */
  buildMinutesPerMonth: number;
  /** Høyere tall går foran i byggekøen. */
  queuePriority: number;
}

/**
 * ⚠️ Statiske sider er med vilje uten tak på antall.
 *
 * En statisk side kjører ingen container (`static_output_dir` i 0003) og koster
 * noen megabyte på disk. Det er hele grunnlaget for at gratisplanen kan tilby
 * dem ubegrenset – kostnaden ligger i kjørende prosesser, ikke i filer.
 *
 * Merk at båndbredde bevisst **ikke** står her. Vi måler den ikke i dag: Caddys
 * access-logger samles ikke inn noe sted, og en grense vi ikke kan måle er en
 * grense vi ikke kan håndheve. Prissiden sier derfor «rimelig bruk» i stedet for
 * et GB-tall. Se `CONTEXT_FOR_AI/12_billing_and_plans.md`.
 */
export const PLAN_LIMITS: Record<SubscriptionTier, PlanLimits> = {
  free: {
    maxRunningProjects: 1,
    memoryMb: 256,
    cpus: 0.5,
    buildMinutesPerMonth: 100,
    queuePriority: 0,
  },
  pro: {
    maxRunningProjects: 5,
    memoryMb: 1024,
    cpus: 1,
    buildMinutesPerMonth: 500,
    queuePriority: 10,
  },
  business: {
    maxRunningProjects: 20,
    memoryMb: 8192,
    cpus: 4,
    buildMinutesPerMonth: 2000,
    queuePriority: 20,
  },
  /**
   * Integrasjonspartnere som drifter mange kundesider under én konto.
   *
   * Tallene er høye, men ikke `Infinity`. Et tak som aldri kan nås er et tak vi
   * aldri får se virke: en løpsk integrasjon som starter bygg i loop skal treffe
   * *noe* før den tar ned verten for alle de andre. `buildMinutesPerMonth` er
   * derfor satt til noe som ville tatt uker å bruke opp ved normal drift, og
   * som likevel stopper en feil før den blir en hendelse.
   *
   * `maxRunningProjects` er nesten teoretisk: kundesidene er statiske og teller
   * ikke mot taket (`assertCanDeploy` returnerer tidlig for dem). Den bremser
   * bare hvis en partner begynner å deploye apper som faktisk kjører.
   */
  agency: {
    maxRunningProjects: 50,
    memoryMb: 1024,
    cpus: 1,
    buildMinutesPerMonth: 20_000,
    queuePriority: 5,
  },
};

/**
 * Priser og mva bor **ikke** her lenger – de ligger i `services/markets.ts`.
 *
 * Grensene over er like i alle markeder; prisene er det ikke. Da `PLAN_PRICES_ORE`
 * og `VAT_RATE = 0.25` sto her, var norske kroner og norsk mva bakt inn i den
 * eneste definisjonen av hva en plan *er*, og et euro-marked kunne ikke legges
 * til uten å endre håndhevingen.
 */

/** Statuser der kunden er i god stand og planen gjelder uten forbehold. */
const HEALTHY: ReadonlySet<Subscription["status"]> = new Set(["active", "trialing"]);

/** Statuser der betalingen har feilet, men kunden er i nådeperioden. */
const DELINQUENT: ReadonlySet<Subscription["status"]> = new Set(["past_due", "unpaid"]);

/**
 * Planen som gjelder for en bruker akkurat nå, med grensene som følger med.
 *
 * `plan` er den *effektive* planen – den grensene regnes ut fra. `billedPlan` er
 * den kunden faktisk abonnerer på. De to er ulike bare når betalingen har feilet
 * og nådeperioden er utløpt; da faller grensene til `free` uten at abonnementet
 * er borte, slik at alt kommer tilbake av seg selv når kortet fornyes.
 */
export interface Entitlement {
  plan: SubscriptionTier;
  billedPlan: SubscriptionTier;
  status: Subscription["status"];
  limits: PlanLimits;
  /** Sant når betalingen har feilet og grensene er falt til gratisnivå. */
  downgraded: boolean;
  /** Når nådeperioden løper ut. Null når betalingen er i orden. */
  graceEndsAt: string | null;
  subscription: Subscription | null;
}

/** Fallback når brukeren ikke har en rad ennå – strengeste plan, aldri løseste. */
function freeEntitlement(subscription: Subscription | null): Entitlement {
  return {
    plan: "free",
    billedPlan: subscription?.plan ?? "free",
    status: subscription?.status ?? "active",
    limits: PLAN_LIMITS.free,
    downgraded: Boolean(subscription && subscription.plan !== "free"),
    graceEndsAt: null,
    subscription,
  };
}

export async function loadSubscription(userId: string): Promise<Subscription | null> {
  const { data, error } = await supabase
    .from("subscriptions")
    .select("*")
    .eq("user_id", userId)
    .maybeSingle();

  if (error) {
    // Vi kaster ikke: en databasefeil her skal ikke stoppe en deployment for en
    // kunde som betaler. Kallerne faller tilbake til gratisgrensene, som er den
    // trygge retningen – vi risikerer å gi en Pro-kunde 256 MB i noen minutter,
    // ikke å gi bort Business til alle.
    logger.error({ userId, err: error }, "Kunne ikke lese abonnementet");
    return null;
  }

  return (data as Subscription | null) ?? null;
}

/** Nådeperiodens slutt for et forfalt abonnement. */
function graceEnd(subscription: Subscription): Date {
  // `delinquent_since` settes av webhooken ved første feilede trekk. Mangler
  // den – for eksempel fordi raden ble satt for hånd – bruker vi slutten på
  // perioden det er betalt for. Begge deler er «da sluttet pengene å komme».
  const from = subscription.delinquent_since ?? subscription.current_period_end;
  const start = from ? new Date(from) : new Date();
  return new Date(start.getTime() + config.SNOAT_BILLING_GRACE_DAYS * 24 * 60 * 60 * 1000);
}

export function entitlementFrom(subscription: Subscription | null): Entitlement {
  if (!subscription) return freeEntitlement(null);

  if (HEALTHY.has(subscription.status)) {
    return {
      plan: subscription.plan,
      billedPlan: subscription.plan,
      status: subscription.status,
      limits: PLAN_LIMITS[subscription.plan],
      downgraded: false,
      graceEndsAt: null,
      subscription,
    };
  }

  if (DELINQUENT.has(subscription.status)) {
    const ends = graceEnd(subscription);

    // Innenfor fristen beholder kunden alt. Poenget er at et utløpt kort ikke
    // skal ta ned produksjonen til noen mens Stripe fortsatt prøver på nytt.
    if (Date.now() < ends.getTime()) {
      return {
        plan: subscription.plan,
        billedPlan: subscription.plan,
        status: subscription.status,
        limits: PLAN_LIMITS[subscription.plan],
        downgraded: false,
        graceEndsAt: ends.toISOString(),
        subscription,
      };
    }

    return { ...freeEntitlement(subscription), graceEndsAt: ends.toISOString() };
  }

  // `canceled` og `incomplete`: ingen aktiv avtale, altså gratisgrensene.
  return freeEntitlement(subscription);
}

export async function entitlementFor(userId: string): Promise<Entitlement> {
  return entitlementFrom(await loadSubscription(userId));
}

/** Ressurstaket containeren skal kjøres under. */
export function resourcesFor(entitlement: Entitlement, project?: Project): containers.ContainerResources {
  const tier: SubscriptionTier = project?.plan ?? entitlement.plan;
  const limits = PLAN_LIMITS[tier] ?? entitlement.limits;
  return { memoryMb: limits.memoryMb, cpus: limits.cpus };
}

/** Første millisekund av inneværende kalendermåned, i UTC. */
function monthStart(): string {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
}

export interface Usage {
  /** Dynamiske apper som kjører nå. */
  runningProjects: number;
  /** Prosjekter totalt, uansett type. */
  totalProjects: number;
  /** Statiske prosjekter – teller ikke mot noen grense. */
  staticProjects: number;
  /** Byggeminutter brukt denne kalendermåneden, avrundet opp. */
  buildMinutesUsed: number;
}

/**
 * Forbruket til én bruker.
 *
 * Kjørende apper telles i Docker og ikke i databasen, fordi det er Docker som
 * har fasit: en container kan ha krasjet eller blitt stoppet uten at noen rad
 * endret seg.
 */
export async function usageFor(userId: string): Promise<Usage> {
  const { data, error } = await supabase
    .from("projects")
    .select("id, static_output_dir")
    .eq("user_id", userId);

  if (error) throw new Error(`Kunne ikke lese prosjektene: ${error.message}`);

  const projects = (data ?? []) as Array<Pick<Project, "id" | "static_output_dir">>;
  const dynamic = projects.filter((project) => !project.static_output_dir);

  const running = await containers.runningProjectIds().catch((err: unknown) => {
    logger.warn({ userId, err }, "Kunne ikke telle kjørende containere");
    return new Set<string>();
  });

  return {
    runningProjects: dynamic.filter((project) => running.has(project.id)).length,
    totalProjects: projects.length,
    staticProjects: projects.length - dynamic.length,
    buildMinutesUsed: await buildMinutesUsed(userId),
  };
}

/**
 * Byggeminutter brukt denne kalendermåneden.
 *
 * Summerer `duration_ms` på tvers av brukerens prosjekter. `!inner` gjør
 * join-en til en filtrering: uten den ville PostgREST returnert deployments for
 * *alle* brukere med `projects: null` på de som ikke matchet.
 *
 * Feilede bygg teller med. De brukte de samme minuttene på verten, og uten dem
 * ville et repo som feiler i minutt 29 hver gang vært gratis å kjøre i loop.
 */
export async function buildMinutesUsed(userId: string): Promise<number> {
  const { data, error } = await supabase
    .from("deployments")
    .select("duration_ms, projects!inner(user_id)")
    .eq("projects.user_id", userId)
    .gte("created_at", monthStart());

  if (error) {
    logger.error({ userId, err: error }, "Kunne ikke summere byggeminutter");
    return 0;
  }

  const totalMs = ((data ?? []) as Array<{ duration_ms: number | null }>).reduce(
    (sum, row) => sum + (row.duration_ms ?? 0),
    0,
  );

  return Math.ceil(totalMs / 60_000);
}

/**
 * Sperren som faktisk håndhever planen.
 *
 * Kalles fra `startDeployment`, ikke fra prosjektopprettelsen. Det er et bevisst
 * valg med to grunner:
 *
 *   1. **Frontend oppretter prosjekter direkte i Supabase** med RLS
 *      (`dashboard.tsx`), uten å røre backend. En sjekk der ville ikke vært en
 *      sjekk i det hele tatt.
 *   2. Et prosjekt uten deployment koster ingenting. Det er containeren som
 *      spiser minne, og det er den vi tar betalt for.
 *
 * Kaster `DeployError` med en melding som er ment å vises til kunden.
 *
 * ⚠️ Meldingen er **norsk og for loggen**; det er `detail.code` frontend viser.
 * Backend kjenner ikke visningsspråket til den som utløste bygget – en
 * auto-deploy fra en GitHub-push har ingen bruker i den andre enden i det hele
 * tatt – så å skrive ferdig kundetekst her ville låst dashboardet til norsk
 * uansett hvor mange oversettelser frontend har.
 */
export async function assertCanDeploy(project: Project, entitlement: Entitlement): Promise<void> {
  const { limits } = entitlement;

  const used = await buildMinutesUsed(project.user_id);
  if (used >= limits.buildMinutesPerMonth) {
    throw new DeployError(
      "plan",
      `Du har brukt ${used} av ${limits.buildMinutesPerMonth} byggeminutter denne måneden. ` +
        `Kvoten nullstilles den 1. – oppgrader planen for å bygge mer nå.`,
      { code: "plan.build_minutes_exhausted", params: { used, limit: limits.buildMinutesPerMonth } },
    );
  }

  // Statiske sider kjører ingen container og teller ikke mot apptaket.
  if (project.static_output_dir) return;

  const running = await containers.runningProjectIds();

  // En app som allerede kjører, skal alltid kunne deployes på nytt. Uten dette
  // ville en Free-bruker med én app blitt låst ute fra sin egen neste versjon,
  // fordi appen hen holder på å oppdatere fyller den ene plassen.
  if (running.has(project.id)) return;

  const { data, error } = await supabase
    .from("projects")
    .select("id, static_output_dir")
    .eq("user_id", project.user_id);

  if (error) {
    // Kan vi ikke telle, sperrer vi ikke. En databasefeil skal ikke se ut som en
    // plangrense for kunden – da leter hen etter feil på feil sted.
    logger.error({ project: project.name, err: error }, "Kunne ikke telle prosjekter mot plangrensen");
    return;
  }

  const active = ((data ?? []) as Array<Pick<Project, "id" | "static_output_dir">>).filter(
    (row) => !row.static_output_dir && running.has(row.id),
  ).length;

  if (active >= limits.maxRunningProjects) {
    const suffix = entitlement.downgraded
      ? ` Betalingen for ${planName(entitlement.billedPlan)} har feilet, så kontoen kjører på gratisgrensene inntil den er i orden.`
      : ` Oppgrader planen, eller stopp en app du ikke bruker.`;

    throw new DeployError(
      "plan",
      `Planen ${planName(entitlement.plan)} tillater ${limits.maxRunningProjects} ` +
        `${limits.maxRunningProjects === 1 ? "app" : "apper"} samtidig, og du har ${active} som kjører.${suffix}`,
      {
        // To koder og ikke én med et flagg: de to tilfellene ber kunden om helt
        // ulike ting – «oppgrader» mot «fiks kortet ditt» – og en oversetter
        // som ser dem hver for seg skriver bedre tekst enn en som må sy sammen
        // en setning av en betingelse.
        code: entitlement.downgraded
          ? "plan.apps_limit_reached_downgraded"
          : "plan.apps_limit_reached",
        params: {
          plan: entitlement.plan,
          billedPlan: entitlement.billedPlan,
          limit: limits.maxRunningProjects,
          running: active,
        },
      },
    );
  }
}

const PLAN_NAMES: Record<SubscriptionTier, string> = {
  free: "Free",
  pro: "Pro",
  business: "Business",
  agency: "Byrå",
};

export function planName(plan: SubscriptionTier): string {
  return PLAN_NAMES[plan] ?? plan;
}
