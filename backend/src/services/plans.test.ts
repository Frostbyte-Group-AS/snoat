import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { Entitlement, PlanLimits, ProjectRow } from "./plans.js";
import type { Project, Subscription, SubscriptionTier } from "../types.js";

/**
 * Tester for de to takene en konto kan treffe – `maxRunningProjects` og
 * `maxRunningDevSites` – og for setningene kunden får når ett av dem er fullt.
 *
 * ## Hvorfor akkurat disse grensene har tester
 *
 * De er de eneste plangrensene noen faktisk treffer i dag. Da Pro-taket sto på
 * 5, stoppet det eieren av plattformen på hans egen konto: fem apper i drift, og
 * den sjette – en dev-side for en app som alt lå der – kunne ikke deployes. En
 * grense som er nådd er en grense som må stemme, og feilmeldingene bøyer seg selv
 * i entall og flertall uten at noen typesjekk ser etter.
 *
 * Fra 6. september 2026 teller en dev-side ikke lenger som en app. Det gjør at
 * *hvilket* tak som ble truffet er noe koden må velge riktig, og et feil valg er
 * en feilmelding som ber kunden stoppe produksjonsapper hen ikke trenger å røre.
 * Derfor tester vi begge tellingene, begge feilene og delingen mellom dem.
 *
 * ## Hvorfor `await import`
 *
 * `plans.ts` drar med seg `config.ts`, som avviser et tomt miljø ved import.
 * Verken Supabase-klienten eller Docker kobler til noe før de kalles, så det
 * holder å fylle inn det minste som validerer – men det må skje *før* modulen
 * evalueres, og statiske importer heises. Derav den dynamiske.
 */
process.env.NODE_ENV ??= "test";
process.env.SUPABASE_URL ??= "http://localhost:54321";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "test-service-role";
process.env.SUPABASE_ANON_KEY ??= "test-anon";
process.env.SNOAT_WORKSPACE_DIR ??= "/tmp/snoat-test";

// Denne settes med `=` og ikke `??=`, med vilje: `buildMemoryFor()` tar det
// laveste av planen og vertens tak, så en utvikler som har et lavt tak i sitt
// eget skall ville sett testen feile på noe som ikke er en feil i koden.
process.env.SNOAT_BUILD_NODE_MEMORY_MB = "8192";

const {
  EIER_LIMITS,
  PLAN_LIMITS,
  appLimitError,
  buildMemoryFor,
  countActiveApps,
  countActiveDevSites,
  devSiteLimitError,
  entitlementFrom,
  erEierEpost,
  erEierId,
  erEierkonto,
  limitsFor,
  parseEierliste,
  resourcesFor,
  runningOverLimit,
} = await import("./plans.js");

// Grensesnittet mot Docker. Importeres her fordi den siste oversettelsen fra
// «ingen grense» til noe Docker godtar skjer der, ikke i `plans.ts`, og fordi
// `plans.ts` uansett drar `containers.ts` med seg – dockerode kobler ikke til
// noe før den kalles.
const { dockerMemoryBytes, dockerNanoCpus, nodeHeapOption } = await import("./containers.js");

/** En konto i god stand på den oppgitte planen. */
function entitlement(plan: SubscriptionTier, overrides: Partial<Entitlement> = {}): Entitlement {
  return {
    plan,
    billedPlan: plan,
    status: "active",
    limits: PLAN_LIMITS[plan] as PlanLimits,
    downgraded: false,
    graceEndsAt: null,
    eier: false,
    subscription: null,
    ...overrides,
  };
}

/** Eierkontoen: ingen grenser, uansett hvilken abonnementsrad som ligger under. */
function eier(subscription: Subscription | null = null): Entitlement {
  return entitlementFrom(subscription, true);
}

/**
 * En prosjektrad med bare de feltene funksjonen under test faktisk leser.
 *
 * Nedcasten er trygg fordi `Project` er tilordnbar til objektet vi bygger – vi
 * later ikke som at raden er komplett, vi sier at ingenting annet leses.
 */
function prosjekt(fields: Partial<Project>): Project {
  return { parent_project_id: null, ...fields } as Project;
}

/** En app-rad: dynamisk, ikke et miljø for noe annet. */
function app(id: string): ProjectRow {
  return { id, static_output_dir: null, parent_project_id: null };
}

/** En dev-side: samme repo som `parentId`, egen container. */
function devSide(id: string, parentId = "app-1"): ProjectRow {
  return { id, static_output_dir: null, parent_project_id: parentId };
}

describe("PLAN_LIMITS.maxRunningProjects", () => {
  it("gir Pro ti samtidige apper", () => {
    assert.equal(PLAN_LIMITS.pro.maxRunningProjects, 10);
  });

  it("gir mer jo dyrere planen er", () => {
    // Free < Pro < Business < Agency. En plan som gir mindre enn den under seg
    // er ikke en skrivefeil man oppdager ved å lese tabellen – tallene står
    // langt fra hverandre i filen.
    assert.ok(PLAN_LIMITS.free.maxRunningProjects < PLAN_LIMITS.pro.maxRunningProjects);
    assert.ok(PLAN_LIMITS.pro.maxRunningProjects < PLAN_LIMITS.business.maxRunningProjects);
    assert.ok(PLAN_LIMITS.business.maxRunningProjects < PLAN_LIMITS.agency.maxRunningProjects);
  });
});

describe("PLAN_LIMITS.maxRunningDevSites", () => {
  it("gir gratisplanen ingen", () => {
    // Én kjørende container er hele gratisplanen. En dev-side er container
    // nummer to for samme produkt, og det er terskelen en betalt plan ligger over.
    assert.equal(PLAN_LIMITS.free.maxRunningDevSites, 0);
  });

  it("gir de to utviklerplanene halvparten av apptaket", () => {
    // Regelen, ikke tallet: et testmiljø på det man jobber med nå, ikke på alt
    // man noen gang har rullet ut. Endres apptaket, skal dette flytte seg med.
    assert.equal(PLAN_LIMITS.pro.maxRunningDevSites, PLAN_LIMITS.pro.maxRunningProjects / 2);
    assert.equal(
      PLAN_LIMITS.business.maxRunningDevSites,
      PLAN_LIMITS.business.maxRunningProjects / 2,
    );
  });

  it("lar ikke byråplanen skalere dev-sider med kundesidene", () => {
    // `maxRunningProjects: 50` finnes for at en partner skal kunne drifte mange
    // kundesider. Dev-sider er en utviklerarbeidsflyt, og et team er lite
    // uansett hvor mange kunder det har. Halvparten hadde vært 25 containere
    // ingen har bedt om.
    assert.equal(PLAN_LIMITS.agency.maxRunningDevSites, PLAN_LIMITS.pro.maxRunningDevSites);
    assert.ok(PLAN_LIMITS.agency.maxRunningDevSites < PLAN_LIMITS.agency.maxRunningProjects / 2);
  });

  it("er aldri større enn apptaket", () => {
    // Et dev-tak over apptaket ville betydd at man kan ha flere testmiljøer enn
    // apper å teste – tallene ville da ikke lenger beskrevet det samme produktet.
    for (const [plan, limits] of Object.entries(PLAN_LIMITS)) {
      assert.ok(
        limits.maxRunningDevSites <= limits.maxRunningProjects,
        `${plan} har flere dev-sider enn apper`,
      );
    }
  });
});

describe("countActiveApps", () => {
  const running = new Set(["app-1", "app-2", "statisk", "dev-side"]);

  it("teller bare dynamiske prosjekter med en kjørende container", () => {
    const active = countActiveApps(
      [
        app("app-1"),
        app("app-2"),
        // Statisk: har ingen container å telle, selv om ID-en skulle dukke opp.
        { id: "statisk", static_output_dir: "dist", parent_project_id: null },
        // Stoppet eller krasjet: ligger ikke i settet fra Docker.
        app("stoppet"),
      ],
      running,
    );

    assert.equal(active, 2);
  });

  it("teller ikke en dev-side som en app", () => {
    // Kjernen i endringen 6. september 2026. En dev-side er en avledning av en
    // app som alt er betalt for, og skal ikke fylle en produksjonsplass. Den har
    // sitt eget tak i stedet – se `countActiveDevSites` under.
    const active = countActiveApps([app("app-1"), devSide("dev-side")], running);

    assert.equal(active, 1);
  });
});

describe("countActiveDevSites", () => {
  const running = new Set(["app-1", "dev-a", "dev-b", "dev-statisk"]);

  it("teller kjørende dev-sider, og bare dem", () => {
    const active = countActiveDevSites(
      [app("app-1"), devSide("dev-a"), devSide("dev-b"), devSide("dev-stoppet")],
      running,
    );

    assert.equal(active, 2);
  });

  it("teller ikke en statisk dev-side", () => {
    // En dev-side arver `static_output_dir` fra forelderen. Er forelderen en
    // statisk side, kjører heller ikke dev-siden en container – og da er det
    // ingenting å ta betalt for.
    const active = countActiveDevSites(
      [{ id: "dev-statisk", static_output_dir: "dist", parent_project_id: "app-1" }],
      running,
    );

    assert.equal(active, 0);
  });

  it("deler radene slik at summen aldri overstiger antall kjørende containere", () => {
    const rows = [app("app-1"), devSide("dev-a"), devSide("dev-b")];
    const sum = countActiveApps(rows, running) + countActiveDevSites(rows, running);

    assert.equal(sum, 3);
  });
});

describe("runningOverLimit", () => {
  // Suspensjonssveipet er den ene mekanismen som tar ned kjørende kundeapper
  // uten at et menneske trykker på noe. Rekkefølgen inn er eldste først.
  const running = new Set(["app-1", "app-2", "app-3", "dev-a", "dev-b"]);
  const rows = [app("app-1"), devSide("dev-a"), app("app-2"), devSide("dev-b"), app("app-3")];

  it("beholder det gratisplanen gir og stopper resten", () => {
    const over = runningOverLimit(rows, running, PLAN_LIMITS.free).map((row) => row.id);

    // Én app beholdes – den eldste. Gratisplanen har null dev-sider, så begge
    // testmiljøene faller, også det eldste.
    assert.deepEqual(over, ["app-2", "app-3", "dev-a", "dev-b"]);
  });

  it("kapper hver kategori mot sitt eget tak", () => {
    // Uten delingen ville en dev-side telt som en app, og en konto kunne mistet
    // en produksjonsapp for å gi plass til et testmiljø planen ikke tillater.
    const limits = { ...PLAN_LIMITS.free, maxRunningProjects: 2, maxRunningDevSites: 1 };
    const over = runningOverLimit(rows, running, limits).map((row) => row.id);

    assert.deepEqual(over, ["app-3", "dev-b"]);
  });

  it("stopper ingenting når kontoen er innenfor", () => {
    assert.deepEqual(runningOverLimit(rows, running, PLAN_LIMITS.pro), []);
  });

  it("ser bort fra det som ikke kjører", () => {
    const over = runningOverLimit(rows, new Set(["app-1"]), PLAN_LIMITS.free);
    assert.deepEqual(over, []);
  });
});

describe("resourcesFor", () => {
  it("gir en produksjonsapp hele planens kjøretid", () => {
    assert.deepEqual(resourcesFor(entitlement("pro"), prosjekt({ plan: "pro" })), {
      memoryMb: 2048,
      cpus: 2,
    });
  });

  it("gir en dev-side halvparten", () => {
    // Dev-siden betjener en håndfull innloggede teammedlemmer bak et passord,
    // ikke publikum. Minnet til samtidige forespørsler er nær null; grunn-heapen
    // er det som blir igjen, og 1 GB dekker den med god margin.
    assert.deepEqual(
      resourcesFor(entitlement("pro"), prosjekt({ plan: "pro", parent_project_id: "app-1" })),
      { memoryMb: 1024, cpus: 1 },
    );
  });

  it("faller aldri under gulvet på 256 MB", () => {
    // Halvparten av gratisplanens 256 MB er 128 MB, og der starter ingen
    // Node-app. Gulvet gjør at forholdet ikke kan produsere et ubrukelig tall.
    assert.deepEqual(
      resourcesFor(entitlement("free"), prosjekt({ plan: "free", parent_project_id: "app-1" })),
      { memoryMb: 256, cpus: 0.5 },
    );
  });

  it("beholder fullt byggeminne for en dev-side", () => {
    // Samme repo, samme modulgraf, samme topp. Et kutt her ville gjort dev-sider
    // umulige å bygge nettopp for prosjektene som trenger et testmiljø mest, og
    // feilen kunden ser er `JavaScript heap out of memory` – som peker mot hens
    // egen kode, ikke mot planen vår.
    const pro = entitlement("pro");
    assert.equal(
      buildMemoryFor(pro, prosjekt({ plan: "pro", parent_project_id: "app-1" })),
      buildMemoryFor(pro, prosjekt({ plan: "pro" })),
    );
  });
});

describe("appLimitError", () => {
  it("slipper gjennom så lenge det er en plass igjen", () => {
    assert.equal(appLimitError(entitlement("pro"), 9), null);
  });

  it("sperrer når alle plassene er brukt", () => {
    const error = appLimitError(entitlement("pro"), 10);

    assert.ok(error, "ti av ti kjørende apper skal gi en feil");
    assert.equal(error.step, "plan");
    assert.equal(error.detail?.code, "plan.apps_limit_reached");
    assert.deepEqual(error.detail?.params, {
      plan: "pro",
      billedPlan: "pro",
      limit: 10,
      running: 10,
    });
  });

  it("sperrer også når kontoen har kommet over taket", () => {
    // Kan skje uten at noen har jukset: en plan nedgraderes mens appene kjører.
    assert.ok(appLimitError(entitlement("pro"), 12));
  });

  it("skriver flertall når taket er mer enn én", () => {
    const error = appLimitError(entitlement("pro"), 10);
    assert.match(error!.message, /tillater 10 apper samtidig/);
  });

  it("skriver entall når taket er én", () => {
    const error = appLimitError(entitlement("free"), 1);
    assert.match(error!.message, /tillater 1 app samtidig/);
  });

  it("forklarer en feilet betaling i stedet for å be om oppgradering", () => {
    // Grensene har falt til Free, men det er Pro kunden faktisk betaler for –
    // og da er «oppgrader planen» feil beskjed.
    const error = appLimitError(
      entitlement("free", { billedPlan: "pro", status: "past_due", downgraded: true }),
      1,
    );

    assert.equal(error?.detail?.code, "plan.apps_limit_reached_downgraded");
    assert.match(error!.message, /Betalingen for Pro har feilet/);
  });

  it("nevner ikke dev-sider", () => {
    // Poenget med to feilmeldinger: en kunde som får «10 apper» når det var
    // dev-taket som slo inn, begynner å stoppe produksjonsapper til ingen nytte.
    assert.doesNotMatch(appLimitError(entitlement("pro"), 10)!.message, /dev-side/);
  });
});

describe("devSiteLimitError", () => {
  it("slipper gjennom på siste ledige plass", () => {
    // Grensetilfellet: fire av fem brukt, den femte skal gå gjennom.
    assert.equal(devSiteLimitError(entitlement("pro"), 4), null);
  });

  it("sperrer når taket er nådd", () => {
    const error = devSiteLimitError(entitlement("pro"), 5);

    assert.ok(error, "fem av fem kjørende dev-sider skal gi en feil");
    assert.equal(error.step, "plan");
    assert.equal(error.detail?.code, "plan.dev_sites_limit_reached");
    assert.deepEqual(error.detail?.params, {
      plan: "pro",
      billedPlan: "pro",
      limit: 5,
      running: 5,
    });
  });

  it("sier at det var dev-taket som slo inn, ikke apptaket", () => {
    // Hele grunnen til at feilen er sin egen funksjon. «Planen tillater 10
    // apper» er feil svar på et forsøk på å rulle ut dev-side nummer seks.
    const error = devSiteLimitError(entitlement("pro"), 5);

    assert.match(error!.message, /tillater 5 dev-sider samtidig, og du har 5 som kjører/);
    assert.doesNotMatch(error!.message, / apper /);
  });

  it("skriver entall når taket er én", () => {
    const limits = { ...PLAN_LIMITS.pro, maxRunningDevSites: 1 } as PlanLimits;
    const error = devSiteLimitError(entitlement("pro", { limits }), 1);

    assert.match(error!.message, /tillater 1 dev-side samtidig/);
  });

  it("sier «ingen dev-sider» i stedet for «0» på gratisplanen", () => {
    // «tillater 0 dev-sider» leser som et tak man kan fylle opp. Det er ikke et
    // tak her – det er en funksjon planen ikke har.
    const error = devSiteLimitError(entitlement("free"), 0);

    assert.ok(error, "gratisplanen har ingen dev-sider og skal sperre med én gang");
    assert.equal(error.detail?.code, "plan.dev_sites_not_included");
    assert.match(error.message, /tillater ingen dev-sider samtidig\./);
    assert.doesNotMatch(error.message, /0 dev-sider/);
    // «stopp en dev-side du ikke bruker» er en gåte når man ikke kan ha noen.
    assert.match(error.message, /Oppgrader planen/);
    assert.doesNotMatch(error.message, /stopp en dev-side/);
  });

  it("forklarer en feilet betaling i stedet for å be om oppgradering", () => {
    const error = devSiteLimitError(
      entitlement("free", { billedPlan: "pro", status: "past_due", downgraded: true }),
      1,
    );

    assert.equal(error?.detail?.code, "plan.dev_sites_limit_reached_downgraded");
    assert.match(error!.message, /Betalingen for Pro har feilet/);
  });

  it("sperrer også når kontoen har kommet over taket", () => {
    // En nedgradering fra Business til Pro mens ti dev-sider kjører.
    assert.ok(devSiteLimitError(entitlement("pro"), 10));
  });
});

/* ══════════════════════════════════════════════════════════════════════════
 * EIERKONTOEN
 *
 * Fritaket er den eneste veien forbi betalingsmuren i hele plattformen, og det
 * er derfor testene her er skrevet med to helt ulike bekymringer:
 *
 *   1. **Virker fritaket overalt?** Et fritak som gjelder ni av ti sperrepunkt
 *      er verre enn ingen, fordi det ser ut til å virke helt til den tiende
 *      stopper eieren midt i noe. Hvert håndhevingssted har derfor sin egen
 *      påstand her.
 *   2. **Kan fritaket treffe noen andre?** Den tomme lista er den farligste
 *      verdien som finnes: leses «ingenting oppgitt» som «alle», er hele
 *      betalingsmuren av i det øyeblikket variabelen faller ut av miljøet.
 *
 * `SNOAT_OWNER_ACCOUNTS` er med vilje **ikke** satt i denne filen. Modulen ser
 * altså en tom liste, og alt som handler om oppslag beviser dermed at ingen
 * blir fritatt uten et treff.
 * ══════════════════════════════════════════════════════════════════════════ */

describe("parseEierliste", () => {
  it("gir tomme sett for en tom liste", () => {
    for (const raw of ["", "   ", ",,", undefined, null]) {
      const liste = parseEierliste(raw);
      assert.equal(liste.ider.size, 0, `«${String(raw)}» ga ID-er`);
      assert.equal(liste.eposter.size, 0, `«${String(raw)}» ga e-poster`);
    }
  });

  it("skiller e-poster fra bruker-ID-er på @", () => {
    const liste = parseEierliste("c7495323-2718-4d30-82ed-dcd080a5898f, daniel@frostbytes.no");

    assert.deepEqual([...liste.ider], ["c7495323-2718-4d30-82ed-dcd080a5898f"]);
    assert.deepEqual([...liste.eposter], ["daniel@frostbytes.no"]);
  });

  it("tåler mellomrom, store bokstaver og tomme ledd", () => {
    // Verdien kommer fra en .env-fil skrevet for hånd. Et etterfølgende komma
    // eller en stor bokstav i en e-post skal ikke gjøre eieren til en vanlig
    // konto – og et tomt ledd skal ikke bli en tom streng i settet.
    const liste = parseEierliste("  ABC-123 , ,Daniel@Frostbytes.NO,");

    assert.deepEqual([...liste.ider], ["abc-123"]);
    assert.deepEqual([...liste.eposter], ["daniel@frostbytes.no"]);
  });
});

describe("den tomme lista fritar ingen", () => {
  const tom = parseEierliste("");

  it("gir usant for enhver bruker-ID", () => {
    // Kjernen. En fritaksliste som svarer «ja» på ingenting er ikke en
    // fritaksliste, det er en åpen dør.
    assert.equal(erEierId("c7495323-2718-4d30-82ed-dcd080a5898f", tom), false);
    assert.equal(erEierId("hvem-som-helst", tom), false);
  });

  it("gir usant for enhver e-post", () => {
    assert.equal(erEierEpost("daniel@frostbytes.no", tom), false);
    assert.equal(erEierEpost("angriper@example.com", tom), false);
  });

  it("slipper ikke gjennom en tom ID eller en manglende e-post", () => {
    // En bruker uten e-post i Supabase Auth (SMS-innlogging, en tjenestekonto)
    // må ikke kunne treffe en tom streng som ble stående igjen i settet.
    const liste = parseEierliste("daniel@frostbytes.no,c7495323");

    assert.equal(erEierEpost(null, liste), false);
    assert.equal(erEierEpost(undefined, liste), false);
    assert.equal(erEierEpost("", liste), false);
    assert.equal(erEierId("", liste), false);
    assert.equal(erEierId(null, liste), false);
  });

  it("gjør erEierkonto() usann uten å slå opp noe", async () => {
    // Denne filen setter ikke `SNOAT_OWNER_ACCOUNTS`, så modulen kjører med tom
    // liste. Kallet må svare usant med én gang – går det til Supabase Auth her,
    // henger testen eller feiler på en manglende server, og det er nettopp
    // beviset på at kortslutningen ligger først.
    assert.equal(await erEierkonto("c7495323-2718-4d30-82ed-dcd080a5898f"), false);
  });
});

describe("EIER_LIMITS", () => {
  it("er ubegrenset på ekte, ikke et stort tall", () => {
    // Et stort tall er et tak, og et tak treffes en dag. Sammenligningene i
    // håndhevingen (`>=`, `<`, `slice`) oppfører seg riktig på `Infinity`.
    assert.equal(EIER_LIMITS.maxRunningProjects, Infinity);
    assert.equal(EIER_LIMITS.maxRunningDevSites, Infinity);
    assert.equal(EIER_LIMITS.memoryMb, Infinity);
    assert.equal(EIER_LIMITS.buildMemoryMb, Infinity);
    assert.equal(EIER_LIMITS.cpus, Infinity);
    assert.equal(EIER_LIMITS.buildMinutesPerMonth, Infinity);
    assert.equal(EIER_LIMITS.analytics, true);
  });

  it("står ikke i plantabellen", () => {
    // `PLAN_LIMITS` beskriver hva en kunde får kjøpt. En eierkonto er ikke et
    // produkt, og en rad der ingen kan betale for ville gjort tabellen usann –
    // og dukket opp i `planCatalogue()`, som itererer nøklene her.
    for (const limits of Object.values(PLAN_LIMITS)) {
      assert.notEqual(limits, EIER_LIMITS);
      assert.ok(
        Number.isFinite(limits.maxRunningProjects),
        "en kjøpbar plan skal ha et endelig tak",
      );
    }
  });

  it("går foran alle planer i byggekøen", () => {
    // `enqueue()` setter bygget inn foran den første med lavere prioritet.
    for (const limits of Object.values(PLAN_LIMITS)) {
      assert.ok(limits.queuePriority < EIER_LIMITS.queuePriority);
    }
  });

  it("lar to eierbygg beholde ankomstrekkefølgen", () => {
    // Sammenligningen i `enqueue()` er streng ulikhet, og `Infinity < Infinity`
    // er usant. Uten det ville køen blitt LIFO mellom eierens egne bygg.
    assert.equal(EIER_LIMITS.queuePriority < EIER_LIMITS.queuePriority, false);
  });
});

describe("entitlementFrom for en eierkonto", () => {
  it("gir EIER_LIMITS i stedet for planens", () => {
    const e = eier();

    assert.equal(e.eier, true);
    assert.equal(e.limits, EIER_LIMITS);
  });

  it("er aldri nedgradert, uansett hva som står i abonnementet", () => {
    // `downgraded` er flagget suspensjonssveipet plukker kandidater på, og det
    // som velger «fiks kortet»-varianten av feilmeldingene. En eierkonto med et
    // forfalt kort fra fjoråret skal ikke bli noen av delene.
    const forfalt = {
      user_id: "c7495323",
      plan: "pro",
      status: "unpaid",
      delinquent_since: "2020-01-01T00:00:00.000Z",
    } as unknown as Subscription;

    const e = eier(forfalt);

    assert.equal(e.downgraded, false);
    assert.equal(e.graceEndsAt, null);
    assert.equal(e.limits, EIER_LIMITS);
  });

  it("lar prosjektets egen plan overstyre ingenting", () => {
    // Den avgjørende forskjellen mellom et flagg på kontoen og en femte tier:
    // eierens prosjektrader sier `free` eller `pro`, og `limitsFor()` leser
    // normalt raden framfor kontoen. Gjorde den det her, ville fritaket
    // forsvunnet nettopp i `resourcesFor()` og `buildMemoryFor()`.
    assert.equal(limitsFor(eier(), prosjekt({ plan: "free" })), EIER_LIMITS);
    assert.equal(limitsFor(eier(), prosjekt({ plan: "pro" })), EIER_LIMITS);
  });
});

describe("eierkontoen treffer ingen av grensene", () => {
  it("slipper gjennom apptaket uansett hvor mange som kjører", () => {
    assert.equal(appLimitError(eier(), 0), null);
    assert.equal(appLimitError(eier(), 10_000), null);
  });

  it("slipper gjennom dev-taket uansett hvor mange som kjører", () => {
    assert.equal(devSiteLimitError(eier(), 10_000), null);
  });

  it("slipper gjennom byggeminuttene", () => {
    // Samme sammenligning som `assertCanDeploy()` gjør: `used >= limit`.
    assert.equal(1_000_000 >= eier().limits.buildMinutesPerMonth, false);
  });

  it("kan ikke bli plukket av suspensjonssveipet", () => {
    // Andre gjerde. Sveipet hopper over eierkontoer i `candidates()`, men selv
    // om den sjekken skulle forsvinne, skal `runningOverLimit()` med
    // eiergrensene ikke finne noe å stoppe. `slice(Infinity)` er tom.
    const running = new Set(["app-1", "app-2", "dev-a"]);
    const rows = [app("app-1"), app("app-2"), devSide("dev-a")];

    assert.deepEqual(runningOverLimit(rows, running, EIER_LIMITS), []);
  });

  it("har trafikkstatistikk", () => {
    assert.equal(limitsFor(eier(), prosjekt({ plan: "free" })).analytics, true);
  });
});

describe("uendelig må ikke nå Docker", () => {
  it("gir byggeminne uten tak i stedet for vertens tak", () => {
    // ⚠️ Fella. `Math.min(Infinity, SNOAT_BUILD_NODE_MEMORY_MB)` er
    // konfigurasjonsverdien, altså et tak – ikke uendelig. `null` betyr at
    // `--max-old-space-size` ikke settes i det hele tatt.
    assert.equal(buildMemoryFor(eier()), null);
    assert.notEqual(buildMemoryFor(eier()), 8192);
    assert.equal(buildMemoryFor(eier(), prosjekt({ plan: "pro", parent_project_id: "app-1" })), null);
  });

  it("gir kjøreressurser uten tak, også for en dev-side", () => {
    // Halvparten av ingen grense er fortsatt ingen grense – og `Math.floor(
    // Infinity * 0.5)` er `Infinity`, altså akkurat verdien vi ble kvitt.
    assert.deepEqual(resourcesFor(eier(), prosjekt({ plan: "pro" })), {
      memoryMb: null,
      cpus: null,
    });
    assert.deepEqual(
      resourcesFor(eier(), prosjekt({ plan: "pro", parent_project_id: "app-1" })),
      { memoryMb: null, cpus: null },
    );
  });

  it("oversetter «ingen grense» til Dockers egen 0", () => {
    // 0 er ikke «null megabyte» for Docker, det er «ingen grense». Se
    // `dockerMemoryBytes()`.
    assert.equal(dockerMemoryBytes(null), 0);
    assert.equal(dockerNanoCpus(null), 0);
    assert.equal(nodeHeapOption(null), null);
  });

  it("sender aldri NaN eller Infinity videre til Docker", () => {
    // Den siste linjen før verdien forlater oss. Alle planene, eierkontoen, og
    // for sikkerhets skyld verdiene som aldri skulle kommet hit i det hele tatt.
    const ressurser = [
      ...Object.keys(PLAN_LIMITS).flatMap((plan) => [
        resourcesFor(entitlement(plan as SubscriptionTier), prosjekt({ plan: plan as SubscriptionTier })),
        resourcesFor(
          entitlement(plan as SubscriptionTier),
          prosjekt({ plan: plan as SubscriptionTier, parent_project_id: "app-1" }),
        ),
      ]),
      resourcesFor(eier(), prosjekt({ plan: "pro" })),
      resourcesFor(eier(), prosjekt({ plan: "pro", parent_project_id: "app-1" })),
      // Skulle uendelig noen gang slippe forbi `resourcesFor()`, skal
      // oversettelsen fange det her i stedet for å bli «json: unsupported value».
      { memoryMb: Infinity, cpus: Infinity },
      { memoryMb: Number.NaN, cpus: Number.NaN },
    ];

    for (const r of ressurser) {
      const memory = dockerMemoryBytes(r.memoryMb);
      const nanoCpus = dockerNanoCpus(r.cpus);

      assert.ok(Number.isInteger(memory), `Memory=${memory} er ikke et heltall`);
      assert.ok(Number.isInteger(nanoCpus), `NanoCpus=${nanoCpus} er ikke et heltall`);
      assert.ok(memory >= 0 && nanoCpus >= 0);

      const heap = nodeHeapOption(r.memoryMb);
      if (heap !== null) {
        assert.doesNotMatch(heap, /Infinity|NaN/, `NODE_OPTIONS ble «${heap}»`);
      }
    }
  });
});

describe("en vanlig konto er upåvirket av at eierlista finnes", () => {
  it("beholder planens grenser", () => {
    const pro = entitlement("pro");

    assert.equal(pro.eier, false);
    assert.equal(pro.limits, PLAN_LIMITS.pro);
    assert.equal(limitsFor(pro, prosjekt({ plan: "pro" })), PLAN_LIMITS.pro);
  });

  it("beholder taket, byggeminnet og ressursene", () => {
    const pro = entitlement("pro");

    assert.ok(appLimitError(pro, 10), "Pro skal fortsatt sperre på ti apper");
    assert.equal(buildMemoryFor(pro, prosjekt({ plan: "pro" })), 4096);
    assert.deepEqual(resourcesFor(pro, prosjekt({ plan: "pro" })), { memoryMb: 2048, cpus: 2 });
  });

  it("kan fortsatt bli nedgradert og suspendert", () => {
    // Uten dette ville vi ikke visst om `eier`-grenen slo ut den vanlige.
    const nedgradert = entitlement("free", {
      billedPlan: "pro",
      status: "past_due",
      downgraded: true,
    });

    assert.equal(nedgradert.eier, false);
    assert.ok(appLimitError(nedgradert, 1));

    const running = new Set(["app-1", "app-2"]);
    assert.deepEqual(
      runningOverLimit([app("app-1"), app("app-2")], running, PLAN_LIMITS.free).map((r) => r.id),
      ["app-2"],
    );
  });
});
