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
  /**
   * Samtidig kjørende dynamiske apper. Statiske sider teller ikke – og fra
   * 6. september 2026 teller heller ikke dev-sider, som har sitt eget tak under.
   */
  maxRunningProjects: number;
  /**
   * Samtidig kjørende dev-sider.
   *
   * ── HVORFOR DETTE ER ET EGET TALL ────────────────────────────────────────
   *
   * En dev-side er en ordinær prosjektrad med `parent_project_id` satt
   * (`services/dev-sites.ts`, migrasjon 0013): samme repo, annen gren, eget
   * vertsnavn, egen container. Fram til nå telte den derfor som en hel app, og
   * det gjorde at ett produkt med testmiljø kostet to plasser. Pro var reelt
   * «2–3 produkter med dev-miljø», ikke ti apper.
   *
   * Beslutningen er at en dev-gren **ikke skal allokeres eller belastes som en
   * fullverdig applikasjonsinstans**. Den er en avledning av noe kunden alt
   * betaler for, og skal ikke spise en produksjonsplass.
   *
   * Men den kan ikke være gratis heller. Ti apper med hver sin dev-side er tjue
   * containere på verten, og «teller ikke» uten et eget tak er et smutthull, ikke
   * en beslutning. Derfor: eget tak, satt til **halvparten av apptaket** på de to
   * utviklerplanene.
   *
   * Halvparten og ikke én per app, fordi det er den ærlige beskrivelsen av
   * arbeidsflyten taket skal romme: man har et testmiljø på det man jobber med
   * nå, ikke på alt man noen gang har rullet ut. En Pro-konto som fyller begge
   * takene binder 15 containere, ikke 20 – og siden en dev-side kjører på halvt
   * minne (`resourcesFor()`), er det verten merker en økning på ~25 %, ikke 100 %.
   * Det er prisen på beslutningen, og den er verdt å se skrevet ned.
   *
   * `free: 0` er ikke gjerrighet: gratisplanen gir én kjørende app, og en dev-side
   * er per definisjon en container nummer to for det samme produktet. Å gi den
   * bort ville doblet fotavtrykket til den billigste planen. En dev-side som
   * *allerede* kjører kan fortsatt rulles ut på nytt – `assertCanDeploy()`
   * slipper alltid gjennom noe som står og går – så dette rammer bare nye.
   */
  maxRunningDevSites: number;
  /** Minne per container når appen KJØRER, i MB. */
  memoryMb: number;
  /**
   * Heap-tak for Node under BYGGING, i MB.
   *
   * ── HVORFOR DETTE ER ET EGET TALL ────────────────────────────────────────
   *
   * Å bygge og å kjøre koster ikke det samme. `next build` holder hele
   * modulgrafen, typeinformasjonen og alle chunkene i minnet samtidig; den
   * ferdige serveren serverer ferdige filer. Et bygg kan trenge fire ganger så
   * mye som appen bruker etterpå.
   *
   * Fram til 6. september 2026 fantes bare ETT tall, `SNOAT_BUILD_NODE_MEMORY_MB`
   * i config, likt for alle planer. En kunde som betalte fikk altså nøyaktig
   * samme byggetak som en gratisbruker — planen ga flere kjørende apper og mer
   * kjøreminne, men ikke én megabyte mer å bygge med. For et prosjekt som var
   * for stort til å bygge, hjalp det ikke å betale.
   *
   * Byggene er dessuten serialisert (`SNOAT_MAX_CONCURRENT_BUILDS`, standard 1)
   * og varer i minutter. Verten kan derfor låne ut mye mer til ett bygg enn den
   * kan binde opp i en app som står døgnet rundt.
   */
  buildMemoryMb: number;
  /** CPU-andel per container. */
  cpus: number;
  /** Byggeminutter per kalendermåned, på tvers av alle prosjekter. */
  buildMinutesPerMonth: number;
  /** Høyere tall går foran i byggekøen. */
  queuePriority: number;
  /**
   * Om trafikkstatistikken er synlig for planen.
   *
   * Innsamlingen er ikke betinget – `analytics-ingest.ts` leser Caddys
   * access-logg for alle prosjekter uansett, fordi loggen er én felles strøm.
   * Det som koster er *oppslaget*: en aggregering over rader for hele kontoen,
   * hvert halvminutt så lenge fanen står åpen. Derfor er dette en visnings-
   * grense, ikke en innsamlingsgrense.
   */
  analytics: boolean;
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
    // Ingen dev-sider. Gratisplanen gir én kjørende container; en dev-side er
    // container nummer to for samme produkt, og det er nettopp den terskelen en
    // betalt plan skal ligge over.
    maxRunningDevSites: 0,
    memoryMb: 256,
    buildMemoryMb: 1024,
    cpus: 0.5,
    buildMinutesPerMonth: 100,
    queuePriority: 0,
    analytics: false,
  },
  pro: {
    /**
     * Hevet fra 5 til 10 den 6. september 2026.
     *
     * Grunnen er konkret, ikke en avrunding oppover: fem apper er det en enkelt
     * utvikler har i drift *før* hen begynner å teste noe. Med fem
     * kjørende apper var neste deployment sperret – og den neste deploymenten
     * var en passordbeskyttet dev-side for en app som alt lå på kontoen.
     *
     * ⚠️ En dev-side er en ordinær prosjektrad med `parent_project_id` satt
     * (`services/dev-sites.ts`, migrasjon 0013). Den kjører sin egen container
     * og teller derfor som en hel app her. Det er riktig for verten – minnet er
     * like ekte – men det betyr at en kunde som vil ha et testmiljø av noe hen
     * alt betaler for, bruker to plasser på én app. Taket måtte derfor være
     * romslig nok til at et dev-miljø ikke er et valg mot en produksjonsapp.
     *
     * ⚠️ Dette avsnittet beskriver hvordan det *var*. Dev-sider teller ikke
     * lenger mot dette tallet – de har `maxRunningDevSites` under. Taket på ti
     * står likevel: det var for lavt også uten dev-sidene.
     */
    maxRunningProjects: 10,
    /** Halvparten av apptaket: et testmiljø på det man jobber med, ikke på alt. */
    maxRunningDevSites: 5,
    memoryMb: 2048,
    buildMemoryMb: 4096,
    cpus: 2,
    buildMinutesPerMonth: 500,
    queuePriority: 10,
    analytics: true,
  },
  business: {
    maxRunningProjects: 20,
    /** Samme regel som Pro: halvparten av apptaket. */
    maxRunningDevSites: 10,
    memoryMb: 8192,
    buildMemoryMb: 8192,
    cpus: 4,
    buildMinutesPerMonth: 2000,
    queuePriority: 20,
    analytics: true,
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
    /**
     * Her brytes halvparts-regelen med vilje: 25 ville vært feil svar.
     *
     * `maxRunningProjects: 50` finnes for at en partner skal kunne drifte mange
     * *kundesider*, og de er statiske. En dev-side er derimot en
     * utviklerarbeidsflyt, brukt av partnerens eget team – og et team er lite
     * uansett hvor mange kunder det har. Å la dev-taket skalere med et tall som
     * finnes av en helt annen grunn ville gitt én konto lov til å binde 25
     * containere ingen har bedt om.
     *
     * Fem, som Pro, er derfor det riktige. Resten av raden er allerede identisk
     * med Pro sin.
     */
    maxRunningDevSites: 5,
    memoryMb: 2048,
    buildMemoryMb: 4096,
    cpus: 2,
    buildMinutesPerMonth: 20_000,
    queuePriority: 5,
    analytics: true,
  },
};

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * EIERKONTOEN — en konto uten grenser, og hvorfor den IKKE er en femte plan
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Daniel eier Snoat og skal kunne bruke plattformen uten å treffe et eneste
 * tak. Det er ikke et produkt noen kan kjøpe, og derfor står det ikke i
 * `PLAN_LIMITS` over: den tabellen beskriver hva en kunde får for pengene, og
 * en rad der som ingen kan betale for gjør tabellen usann.
 *
 * ── HVORFOR IKKE EN FEMTE `SubscriptionTier` ────────────────────────────────
 *
 * Det var den nærliggende løsningen – `agency` finnes jo allerede som en tier
 * ingen kan kjøpe. Tre ting gjorde den feil her:
 *
 *   1. **`subscription_tier` er en enum i Postgres** (0004, utvidet i 0010).
 *      En femte verdi krever en migrasjon. Og verre: `POST /projects` skriver
 *      `entitlementFor(userId).plan` rett inn i `projects.plan`
 *      (`routes/api.ts`), så eierens neste prosjekt ville feilet på en
 *      enum-verdi basen ikke kjenner.
 *   2. **`limitsFor()` foretrekker prosjektets egen plan framfor kontoens.**
 *      Eierens eksisterende prosjektrader sier `free`/`pro`, og de ville
 *      overstyrt en femte tier på kontoen. Fritaket ville altså virket for
 *      `assertCanDeploy()` og ikke for `resourcesFor()` – ni av ti steder, som
 *      er verre enn ingenting fordi det ser ut til å virke.
 *   3. `planCatalogue()` i `markets.ts` itererer nøklene i `PLAN_LIMITS`, og
 *      frontendens `SubscriptionTier` har bare tre verdier. En femte tier ville
 *      måttet filtreres bort tre nye steder for å ikke dukke opp som en gratis
 *      Business-plan på prissiden.
 *
 * ── LØSNINGEN: et flagg på kontoen, sjekket på ETT sted ─────────────────────
 *
 * `erEierkonto(userId)` avgjør, og svaret bæres videre som `Entitlement.eier`.
 * Alt som håndhever noe leser allerede enten `entitlement.limits` eller
 * `limitsFor()`, og begge svarer `EIER_LIMITS` for en eierkonto. Fritaket kan
 * derfor ikke glemmes på et sperrepunkt – det er ikke noe å huske.
 */

/**
 * Grensene til en eierkonto: ingen.
 *
 * ⚠️ **`Infinity` og ikke et stort tall.** Et stort tall er et tak, og et tak
 * blir truffet en dag – typisk den dagen man minst har lyst til å lete etter
 * hvorfor. `Infinity` oppfører seg riktig gjennom hver eneste sammenligning
 * håndhevingen gjør (`used >= limit`, `active < limit`, `slice(limit)`), og er
 * dessuten **synlig feil** hvis den slipper ut et sted den ikke hører hjemme:
 * `Infinity MB` i en logg er en bug man ser, mens `999999 MB` ser ut som noe
 * noen mente.
 *
 * ⚠️ **De to stedene `Infinity` ikke kan slippe ut, er Docker og V8.**
 * `HostConfig.Memory: Infinity` og `--max-old-space-size=Infinity` er ugyldige.
 * `resourcesFor()` og `buildMemoryFor()` oversetter derfor uendelig til `null`
 * = «ingen grense», og `containers.ts` gjør `null` om til Dockers egen måte å
 * si det samme på: `0`. Se `dockerMemoryBytes()` der.
 *
 * Merk at dette er motsatt av begrunnelsen for `agency`, der tallene med vilje
 * er høye og endelige. Forskjellen er hvem som sitter i den andre enden: en
 * integrasjon i en løkke har ingen menneskelig hånd som stopper den, mens en
 * eierkonto er ett menneske som eier verten det går ut over.
 */
export const EIER_LIMITS: PlanLimits = Object.freeze({
  maxRunningProjects: Infinity,
  maxRunningDevSites: Infinity,
  memoryMb: Infinity,
  buildMemoryMb: Infinity,
  cpus: Infinity,
  buildMinutesPerMonth: Infinity,
  // Høyere enn enhver plan, så et eierbygg settes inn foran alt annet i
  // `enqueue()`. To eierbygg beholder ankomstrekkefølgen seg imellom, fordi
  // sammenligningen der er streng: `Infinity < Infinity` er usant.
  queuePriority: Infinity,
  analytics: true,
});

/** Lista over hvem som er eier, delt i de to formene en oppføring kan ha. */
export interface Eierliste {
  ider: ReadonlySet<string>;
  eposter: ReadonlySet<string>;
}

/**
 * Leser `SNOAT_OWNER_ACCOUNTS`.
 *
 * ⚠️ **En tom liste gir to tomme sett, og et tomt sett fritar ingen.** Dette er
 * det farligste stedet i hele filen: en fritaksliste som tolker «ingenting
 * oppgitt» som «alle» ville slått av betalingsmuren i det øyeblikket variabelen
 * falt ut av miljøet. Derfor er regelen at fritak krever et *treff*, aldri et
 * fravær – og derfor er funksjonen ren og eksportert, slik at
 * `plans.test.ts` kan bevise nettopp den egenskapen.
 *
 * En oppføring med `@` i seg leses som e-post, alt annet som en bruker-ID.
 * Tomme ledd (`"a,,b"`, etterfølgende komma) forsvinner – de ville ellers blitt
 * en tom streng i settet, og en bruker uten e-post ville truffet den.
 */
export function parseEierliste(raw: string | null | undefined): Eierliste {
  const ider = new Set<string>();
  const eposter = new Set<string>();

  for (const del of (raw ?? "").split(",")) {
    const oppforing = del.trim().toLowerCase();
    if (!oppforing) continue;
    (oppforing.includes("@") ? eposter : ider).add(oppforing);
  }

  return { ider, eposter };
}

/** Står bruker-ID-en i lista? Tom ID eller tom liste gir alltid usant. */
export function erEierId(userId: string | null | undefined, liste: Eierliste): boolean {
  if (!userId) return false;
  return liste.ider.has(userId.toLowerCase());
}

/** Står e-posten i lista? En bruker uten e-post treffer aldri. */
export function erEierEpost(epost: string | null | undefined, liste: Eierliste): boolean {
  if (!epost) return false;
  return liste.eposter.has(epost.toLowerCase());
}

/** Lista slik den sto i miljøet da prosessen startet. */
const EIERLISTE = parseEierliste(config.SNOAT_OWNER_ACCOUNTS);

/**
 * Hvor mange oppføringer lista har, for oppstartsloggen.
 *
 * En fritaksliste som stilltiende er tom fordi variabelen ikke nådde
 * containeren, ser nøyaktig ut som en fritaksliste som virker – helt til eieren
 * treffer en grense. Tallene skal derfor stå i loggen ved oppstart.
 */
export function eierlisteAntall(): { ider: number; eposter: number } {
  return { ider: EIERLISTE.ider.size, eposter: EIERLISTE.eposter.size };
}

/**
 * E-postoppslag koster et kall til Supabase Auth, og `erEierkonto()` kalles i
 * deploy-stien. Svaret bufres per prosess.
 *
 * Et feilet oppslag bufres **ikke**: da ville et forbigående nettverksavbrudd
 * gjort eieren om til en vanlig konto helt til backend ble restartet.
 */
const eierBuffer = new Map<string, boolean>();

/**
 * Er dette eierens konto?
 *
 * Rekkefølgen er valgt for å holde det vanlige tilfellet gratis: tom liste
 * svarer med én gang, en ID-oppføring svarer uten nettverk, og bare en liste som
 * faktisk inneholder e-postadresser slår opp brukeren.
 *
 * Feiler oppslaget, svarer vi **usant**. Det er den trygge retningen: eieren
 * treffer i verste fall en grense og kan sette ID-en sin i lista i stedet,
 * mens motsatt svar ville gitt bort ubegrenset drift på en databasefeil.
 */
export async function erEierkonto(userId: string): Promise<boolean> {
  if (EIERLISTE.ider.size === 0 && EIERLISTE.eposter.size === 0) return false;
  if (erEierId(userId, EIERLISTE)) return true;
  if (EIERLISTE.eposter.size === 0) return false;

  const bufret = eierBuffer.get(userId);
  if (bufret !== undefined) return bufret;

  const { data, error } = await supabase.auth.admin.getUserById(userId);

  if (error || !data.user) {
    logger.warn({ userId, err: error }, "Kunne ikke slå opp e-posten mot eierlista");
    return false;
  }

  const treff = erEierEpost(data.user.email, EIERLISTE);
  eierBuffer.set(userId, treff);
  return treff;
}

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
  /**
   * Sant for en eierkonto: `limits` er `EIER_LIMITS`, og ingen grense gjelder.
   *
   * Flagget bæres på entitlementet og ikke slås opp på nytt i hvert sperrepunkt,
   * fordi et fritak som må huskes ti steder blir glemt på det ellevte. Se
   * `erEierkonto()` og kommentaren over `EIER_LIMITS`.
   */
  eier: boolean;
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
    eier: false,
    subscription,
  };
}

/**
 * Entitlementet til en eierkonto.
 *
 * `plan` og `billedPlan` beholder den faktiske abonnementsraden – kontoen har
 * fortsatt et abonnement, det er bare ingen grenser som regnes ut fra det.
 * `downgraded` er alltid usant, og det er ikke kosmetikk: det er det flagget
 * suspensjonssveipet plukker kandidater på, og en eierkonto skal aldri kunne bli
 * en kandidat der uansett hvilken tilstand kortet står i.
 */
function eierEntitlement(subscription: Subscription | null): Entitlement {
  return {
    plan: subscription?.plan ?? "free",
    billedPlan: subscription?.plan ?? "free",
    status: subscription?.status ?? "active",
    limits: EIER_LIMITS,
    downgraded: false,
    graceEndsAt: null,
    eier: true,
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

/**
 * ⚠️ `eier` må avgjøres av kalleren, fordi denne funksjonen er synkron og
 * `erEierkonto()` kan trenge et oppslag mot Supabase Auth. `entitlementFor()`
 * gjør det riktige; den ene andre kalleren – suspensjonssveipet – hopper over
 * eierkontoer før den kommer hit i det hele tatt.
 */
export function entitlementFrom(subscription: Subscription | null, eier = false): Entitlement {
  // Først av alt, og med vilje: en eierkonto skal ikke innom hverken
  // nådefristen eller nedgraderingen under. Ingen av dem gjelder for den.
  if (eier) return eierEntitlement(subscription);

  if (!subscription) return freeEntitlement(null);

  if (HEALTHY.has(subscription.status)) {
    return {
      plan: subscription.plan,
      billedPlan: subscription.plan,
      status: subscription.status,
      limits: PLAN_LIMITS[subscription.plan],
      downgraded: false,
      graceEndsAt: null,
      eier: false,
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
        eier: false,
        subscription,
      };
    }

    return { ...freeEntitlement(subscription), graceEndsAt: ends.toISOString() };
  }

  // `canceled` og `incomplete`: ingen aktiv avtale, altså gratisgrensene.
  return freeEntitlement(subscription);
}

export async function entitlementFor(userId: string): Promise<Entitlement> {
  // Parallelt: eierlista er som regel et rent oppslag i et sett, men i
  // e-postformen er den et kall til Supabase Auth, og det skal ikke legge seg
  // etter abonnementsspørringen i deploy-stien.
  const [subscription, eier] = await Promise.all([loadSubscription(userId), erEierkonto(userId)]);
  return entitlementFrom(subscription, eier);
}

/**
 * Grensene som gjelder for ett prosjekt.
 *
 * Prosjektets egen plan går foran kontoens. En byråkonto kan ha prosjekter på
 * ulike planer samtidig, og da er det raden som gjelder – ikke abonnementet.
 * Faller planen bort (ukjent verdi i databasen), brukes kontoens grenser, aldri
 * de løseste.
 */
export function limitsFor(entitlement: Entitlement, project?: Project): PlanLimits {
  // ⚠️ Eierkontoen sjekkes FØR prosjektets egen plan, og det er hele grunnen
  // til at fritaket er et flagg på kontoen og ikke en femte tier: eierens
  // prosjektrader sier `free` eller `pro`, og linjen under ville lest den og
  // gitt Pro-grenser til `resourcesFor()` og `buildMemoryFor()` mens
  // `assertCanDeploy()` slapp alt gjennom. Et fritak som gjelder ni av ti
  // steder er verre enn ingen, fordi det ser ut til å virke.
  if (entitlement.eier) return EIER_LIMITS;

  const tier: SubscriptionTier = project?.plan ?? entitlement.plan;
  return PLAN_LIMITS[tier] ?? entitlement.limits;
}

/** Er raden en dev-side, altså et miljø for et annet prosjekt? */
export function isDevSite(project?: Pick<Project, "parent_project_id">): boolean {
  return Boolean(project?.parent_project_id);
}

/**
 * Hvor stor andel av planens KJØREtid en dev-side får.
 *
 * ── HVORFOR EN HALV, OG HVORFOR AKKURAT KJØRETIDEN ───────────────────────────
 *
 * «Ressursbruken må optimaliseres deretter» gjelder det som er bundet opp
 * *hele tiden*. En dev-side står døgnet rundt som alle andre containere, men den
 * betjener en håndfull innloggede teammedlemmer bak et passord – ikke publikum.
 * Minnet som går til samtidige forespørsler er derfor nær null; det som blir
 * igjen er appens grunn-heap, og halvparten av planens apptall dekker den med
 * god margin på Pro (1024 MB) og Business (4096 MB).
 *
 * En firedel ble vurdert og forkastet. 512 MB til en Next-app er den klassiske
 * «virker helt til den ikke gjør det»-grensen: containeren blir OOM-drept av
 * Docker en tilfeldig tirsdag, og for kunden ser det ut som at Snoat mistet
 * appen – samme klasse uforståelig feil som `JavaScript heap out of memory`,
 * bare på en app som virket i går.
 *
 * Merk at `runContainer()` regner `NODE_OPTIONS=--max-old-space-size` ut fra
 * nøyaktig dette tallet. Kuttet treffer derfor V8 og Docker samtidig, som er det
 * eneste som er trygt: tror V8 den har mer heap enn `HostConfig.Memory` tillater,
 * rydder den for lat og containeren dør.
 */
const DEV_SITE_SHARE = 0.5;

/**
 * Gulv for en dev-side, uansett plan.
 *
 * Halvparten av gratisplanens 256 MB er 128 MB, og der starter ingen Node-app i
 * det hele tatt. Et forhold uten gulv er et forhold som produserer et ubrukelig
 * tall for den billigste planen – og selv om Free ikke har dev-sider i dag, skal
 * ikke funksjonen kunne svare noe meningsløst hvis taket endres i morgen.
 */
const DEV_SITE_MIN_MEMORY_MB = 256;
const DEV_SITE_MIN_CPUS = 0.5;

/**
 * Heap-taket bygget skal kjøre under, i MB.
 *
 * Planen ber om et tall; `SNOAT_BUILD_NODE_MEMORY_MB` er vertens tak og vinner
 * hvis det er lavere. En liten VPS skal kunne kjøre Snoat uten å love et bygg
 * den ikke har minne til — et tak vi ikke kan innfri er verre enn et lavt.
 *
 * ⚠️ **En dev-side får fullt byggeminne, med vilje.** Kjøretiden kuttes; bygget
 * gjør det ikke, og de tre grunnene er verdt å ha nedskrevet:
 *
 *   1. **Det er samme repo.** Dev-siden bygger samme modulgraf, samme
 *      typeinformasjon og samme chunks som forelderen – bare fra en annen gren.
 *      Toppen er den samme. Å kutte her ville gjort dev-sider umulige å bygge
 *      nettopp for de prosjektene som trenger et testmiljø mest.
 *   2. **Bygg er serialisert og kortvarige.** `SNOAT_MAX_CONCURRENT_BUILDS` er 1
 *      og et bygg varer i minutter, så verten holder aldri to byggetopper
 *      samtidig. Et bygg legger ikke noe til det som står bundet døgnet rundt,
 *      og det er bare det siste beslutningen handler om.
 *   3. **Feilen er dyr for kunden.** Et bygg med for lite minne dør på
 *      `JavaScript heap out of memory` – en melding som peker mot kundens kode,
 *      ikke mot planen vår. Litt ekstra minne i noen minutter er billigere enn
 *      den supportrunden.
 */
export function buildMemoryFor(entitlement: Entitlement, project?: Project): number | null {
  const { buildMemoryMb } = limitsFor(entitlement, project);

  // ⚠️ Eierkontoen må ut FØR `Math.min()`. `Math.min(Infinity, 8192)` er 8192 –
  // altså vertens tak, ikke uendelig – og et fritak som stille blir til
  // konfigurasjonsverdien er nøyaktig den typen bug som aldri melder fra.
  //
  // `null` betyr «vi setter ikke noe tak». `nixpacks.ts` lar da være å sende
  // `--max-old-space-size` i det hele tatt, og V8 dimensjonerer heapen etter
  // maskinen den kjører på. Det er den eneste ærlige oversettelsen av
  // «ubegrenset byggeminne»: det finnes ingen gyldig tallverdi for uendelig
  // heap, og det høyeste taket vi kan la være å sette, er ingen.
  if (!Number.isFinite(buildMemoryMb)) return null;

  return Math.min(buildMemoryMb, config.SNOAT_BUILD_NODE_MEMORY_MB);
}

/**
 * Ressurstaket containeren skal kjøres under.
 *
 * En dev-side får `DEV_SITE_SHARE` av planens kjøretid – se begrunnelsen der.
 * Planen hentes fortsatt fra prosjektets egen rad når den har en, slik at en
 * dev-side under et byråprosjekt regner ut fra byråets plan og ikke kontoens.
 */
export function resourcesFor(entitlement: Entitlement, project?: Project): containers.ContainerResources {
  const limits = limitsFor(entitlement, project);

  // ⚠️ `null` = ingen grense, og det er ikke det samme som 0 MB. Docker og V8
  // tar ikke imot `Infinity`, så uendelig oversettes her, én gang, i stedet for
  // å reise videre og bli `Memory: Infinity` eller
  // `--max-old-space-size=Infinity` nede i `containers.ts`.
  const memoryMb = Number.isFinite(limits.memoryMb) ? limits.memoryMb : null;
  const cpus = Number.isFinite(limits.cpus) ? limits.cpus : null;

  if (!isDevSite(project)) {
    return { memoryMb, cpus };
  }

  // En eierkonto sin dev-side er også ubegrenset: halvparten av ingen grense er
  // fortsatt ingen grense, og `Math.floor(Infinity * 0.5)` er `Infinity` – som
  // er nettopp verdien vi nettopp ble kvitt.
  if (memoryMb === null || cpus === null) {
    return { memoryMb, cpus };
  }

  return {
    // Hele megabyte: Docker tar bytes, og et halvt megabyte er ingen presisjon
    // noen har bruk for.
    memoryMb: Math.max(Math.floor(memoryMb * DEV_SITE_SHARE), DEV_SITE_MIN_MEMORY_MB),
    // CPU er en *andel*, ikke en reservasjon: står produksjonsappen stille, får
    // dev-siden alt den ber om uansett. Kuttet biter bare når de to kjemper om
    // verten samtidig – og da skal produksjonen vinne.
    cpus: Math.max(cpus * DEV_SITE_SHARE, DEV_SITE_MIN_CPUS),
  };
}

/** Første millisekund av inneværende kalendermåned, i UTC. */
function monthStart(): string {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
}

export interface Usage {
  /** Dynamiske apper som kjører nå. Dev-sider er ikke med – de har sin egen. */
  runningProjects: number;
  /** Dev-sider som kjører nå, målt mot `maxRunningDevSites`. */
  runningDevSites: number;
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
    // `parent_project_id` er med fordi tellingen skiller apper fra dev-sider.
    // Uten kolonnen ville begge tallene blitt regnet av samme rader.
    .select("id, static_output_dir, parent_project_id")
    .eq("user_id", userId);

  if (error) throw new Error(`Kunne ikke lese prosjektene: ${error.message}`);

  const projects = (data ?? []) as ProjectRow[];
  const staticProjects = projects.filter((project) => Boolean(project.static_output_dir)).length;

  const running = await containers.runningProjectIds().catch((err: unknown) => {
    logger.warn({ userId, err }, "Kunne ikke telle kjørende containere");
    return new Set<string>();
  });

  return {
    runningProjects: countActiveApps(projects, running),
    runningDevSites: countActiveDevSites(projects, running),
    totalProjects: projects.length,
    staticProjects,
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
 * Det minste en rad må ha med seg for at tellingen skal kunne plassere den.
 *
 * Eksportert fordi `suspension.ts` sender inn hele `Project`-rader og skal slippe
 * å gjenta oppramsingen. Alle tre feltene er nødvendige: `static_output_dir`
 * skiller fil fra container, `parent_project_id` skiller dev-side fra app, og
 * `id` er nøkkelen mot settet fra Docker.
 */
export type ProjectRow = Pick<Project, "id" | "static_output_dir" | "parent_project_id">;

/** Kjører raden en container akkurat nå? Statiske sider har ingen å kjøre. */
function erIDrift(row: ProjectRow, running: ReadonlySet<string>): boolean {
  return !row.static_output_dir && running.has(row.id);
}

/**
 * Hvor mange app-plasser kontoen bruker akkurat nå.
 *
 * Tre ting teller *ikke*: statiske sider (de kjører ingen container), rader uten
 * kjørende container (stoppet, krasjet eller aldri deployet) – og fra
 * 6. september 2026 dev-sider.
 *
 * ⚠️ **Dev-sidene er den bevisste endringen.** En dev-side er en ordinær
 * prosjektrad med `parent_project_id` satt (`services/dev-sites.ts`), og den
 * telte tidligere som en hel app. For verten var det riktig – containeren er like
 * ekte – men for kunden kostet ett produkt med testmiljø to plasser, og en Pro
 * med ti apper var reelt «2–3 produkter med dev-miljø». Beslutningen er at en
 * dev-gren ikke skal allokeres eller belastes som en fullverdig
 * applikasjonsinstans; den er en avledning av noe som alt er betalt for.
 *
 * At verten fortsatt ser containeren er ikke glemt, det er håndtert to andre
 * steder: `maxRunningDevSites` gir dev-sidene et eget tak, og `resourcesFor()`
 * kjører dem på halvt minne og halv CPU.
 *
 * Skilt ut av `assertCanDeploy` fordi regelen er verdt å teste uten å måtte
 * stille opp både Docker og Supabase for å komme til den.
 */
export function countActiveApps(
  projects: ReadonlyArray<ProjectRow>,
  running: ReadonlySet<string>,
): number {
  return projects.filter((row) => !row.parent_project_id && erIDrift(row, running)).length;
}

/** Motstykket: dev-sidene som kjører, målt mot `maxRunningDevSites`. */
export function countActiveDevSites(
  projects: ReadonlyArray<ProjectRow>,
  running: ReadonlySet<string>,
): number {
  return projects.filter((row) => Boolean(row.parent_project_id) && erIDrift(row, running)).length;
}

/**
 * Radene som ligger *over* grensene, med de eldste beholdt.
 *
 * Finnes for suspensjonssveipet (`services/suspension.ts`), som er den ene
 * mekanismen i plattformen som tar ned kjørende kundeapper uten at et menneske
 * trykker på noe. Den leste tidligere den samme filtreringen som `countActiveApps`
 * gjorde – uten å skille app fra dev-side – og ville derfor begynt å oppføre seg
 * feil i det øyeblikket tellingen her sluttet å gjøre det samme.
 *
 * Hver kategori kappes mot sitt eget tak. Rekkefølgen inn må være eldste først;
 * det er kalleren som bestemmer den (`order("created_at")`), fordi den eldste
 * appen oftest er den viktigste og skal være den som blir stående.
 */
export function runningOverLimit<T extends ProjectRow>(
  projects: ReadonlyArray<T>,
  running: ReadonlySet<string>,
  limits: PlanLimits,
): T[] {
  const apper: T[] = [];
  const devSider: T[] = [];

  for (const row of projects) {
    if (!erIDrift(row, running)) continue;
    (row.parent_project_id ? devSider : apper).push(row);
  }

  return [
    ...apper.slice(limits.maxRunningProjects),
    ...devSider.slice(limits.maxRunningDevSites),
  ];
}

/**
 * Feilen kunden får når apptaket er fullt – eller `null` når det er plass igjen.
 *
 * `>=` og ikke `>`: `active` er plassene som er brukt *før* denne appen, så en
 * konto med like mange kjørende apper som planen tillater er full.
 *
 * Setningen bøyer seg selv, og det er den ene grunnen til at dette er en egen
 * funksjon med en egen test: «tillater 1 app» mot «tillater 10 apper» er
 * forskjellen mellom norsk og nesten-norsk, og den forskjellen har ingen
 * typesjekk.
 */
export function appLimitError(entitlement: Entitlement, active: number): DeployError | null {
  const limit = entitlement.limits.maxRunningProjects;
  if (active < limit) return null;

  const suffix = entitlement.downgraded
    ? ` Betalingen for ${planName(entitlement.billedPlan)} har feilet, så kontoen kjører på gratisgrensene inntil den er i orden.`
    : ` Oppgrader planen, eller stopp en app du ikke bruker.`;

  return new DeployError(
    "plan",
    `Planen ${planName(entitlement.plan)} tillater ${limit} ` +
      `${limit === 1 ? "app" : "apper"} samtidig, og du har ${active} som kjører.${suffix}`,
    {
      // To koder og ikke én med et flagg: de to tilfellene ber kunden om helt
      // ulike ting – «oppgrader» mot «fiks kortet ditt» – og en oversetter
      // som ser dem hver for seg skriver bedre tekst enn en som må sy sammen
      // en setning av en betingelse.
      code: entitlement.downgraded ? "plan.apps_limit_reached_downgraded" : "plan.apps_limit_reached",
      params: {
        plan: entitlement.plan,
        billedPlan: entitlement.billedPlan,
        limit,
        running: active,
      },
    },
  );
}

/**
 * Feilen kunden får når dev-taket er fullt – eller `null` når det er plass igjen.
 *
 * Speiler `appLimitError()` med vilje, helt ned til `>=` og de to kodene. Den ene
 * grunnen til at dette er en egen funksjon og ikke et flagg på den andre, er at
 * meldingen må si **hvilken** grense som slo inn: «Planen tillater 10 apper» er
 * feil svar på et forsøk på å rulle ut en dev-side nummer seks, og en kunde som
 * får det svaret begynner å stoppe produksjonsapper for å få plass.
 *
 * Tre koder og ikke to, fordi det er tre ulike ting å be kunden om:
 *
 *   * `plan.dev_sites_not_included` – planen har ingen dev-sider i det hele tatt.
 *     Å be noen «stoppe en dev-side du ikke bruker» når de ikke kan ha noen er
 *     ikke en feilmelding, det er en gåte.
 *   * `plan.dev_sites_limit_reached` – taket er nådd. Stopp en, eller oppgrader.
 *   * `plan.dev_sites_limit_reached_downgraded` – betalingen har feilet. Da er
 *     taket alltid gratisplanens null, og det kunden skal gjøre er å fikse kortet.
 */
export function devSiteLimitError(entitlement: Entitlement, active: number): DeployError | null {
  const limit = entitlement.limits.maxRunningDevSites;
  if (active < limit) return null;

  // Setningen bøyer seg selv i tre former, som `appLimitError()` gjør i to.
  // «tillater 0 dev-sider» er grammatisk riktig og likevel feil å si til noen –
  // det leser som et tak man kan fylle opp, ikke som en funksjon man ikke har.
  const antall = limit === 0 ? "ingen dev-sider" : `${limit} dev-${limit === 1 ? "side" : "sider"}`;
  const teller = limit === 0 ? "" : `, og du har ${active} som kjører`;

  const suffix = entitlement.downgraded
    ? ` Betalingen for ${planName(entitlement.billedPlan)} har feilet, så kontoen kjører på gratisgrensene inntil den er i orden.`
    : limit === 0
      ? ` Oppgrader planen for å kjøre et passordbeskyttet testmiljø ved siden av appen.`
      : ` Oppgrader planen, eller stopp en dev-side du ikke bruker.`;

  const code = entitlement.downgraded
    ? "plan.dev_sites_limit_reached_downgraded"
    : limit === 0
      ? "plan.dev_sites_not_included"
      : "plan.dev_sites_limit_reached";

  return new DeployError(
    "plan",
    `Planen ${planName(entitlement.plan)} tillater ${antall} samtidig${teller}.${suffix}`,
    {
      code,
      params: {
        plan: entitlement.plan,
        billedPlan: entitlement.billedPlan,
        limit,
        running: active,
      },
    },
  );
}

/**
 * Sperren som faktisk håndhever planen.
 *
 * Håndhever **tre** ting, i denne rekkefølgen: byggeminutter, og deretter enten
 * apptaket eller dev-taket – aldri begge. Hvilket av de to som gjelder avgjøres
 * av `parent_project_id` på raden som skal rulles ut, slik at feilmeldingen
 * navngir den grensen som faktisk sperret.
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
  // Eierkontoen har ingen grenser å håndheve. Sammenligningene under ville
  // sluppet den gjennom uansett – `Infinity` er større enn alt – men vi stopper
  // her likevel, av to grunner: fritaket blir da lesbart i stedet for å være en
  // egenskap ved et tall, og vi sparer tellingen av byggeminutter og
  // prosjektrader, som er to spørringer i deploy-stien.
  if (entitlement.eier) return;

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
    .select("id, static_output_dir, parent_project_id")
    .eq("user_id", project.user_id);

  if (error) {
    // Kan vi ikke telle, sperrer vi ikke. En databasefeil skal ikke se ut som en
    // plangrense for kunden – da leter hen etter feil på feil sted.
    logger.error({ project: project.name, err: error }, "Kunne ikke telle prosjekter mot plangrensen");
    return;
  }

  const rows = (data ?? []) as ProjectRow[];

  // To tak, og raden avgjør hvilket den måles mot. En dev-side som ble målt mot
  // apptaket ville fått en melding om apper den ikke kan gjøre noe med.
  const overLimit = isDevSite(project)
    ? devSiteLimitError(entitlement, countActiveDevSites(rows, running))
    : appLimitError(entitlement, countActiveApps(rows, running));

  if (overLimit) throw overLimit;
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
