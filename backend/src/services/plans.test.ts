import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { Entitlement, PlanLimits } from "./plans.js";
import type { SubscriptionTier } from "../types.js";

/**
 * Tester for apptaket – grensen `maxRunningProjects` og setningen kunden får
 * når den er full.
 *
 * ## Hvorfor akkurat denne grensen har tester
 *
 * Den er den eneste plangrensen noen faktisk treffer i dag. Da Pro-taket sto på
 * 5, stoppet det eieren av plattformen på hans egen konto: fem apper i drift, og
 * den sjette – en dev-side for en app som alt lå der – kunne ikke deployes. En
 * grense som er nådd er en grense som må stemme, og feilmeldingen bøyer seg selv
 * i entall og flertall uten at noen typesjekk ser etter.
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

const { PLAN_LIMITS, appLimitError, countActiveApps } = await import("./plans.js");

/** En konto i god stand på den oppgitte planen. */
function entitlement(plan: SubscriptionTier, overrides: Partial<Entitlement> = {}): Entitlement {
  return {
    plan,
    billedPlan: plan,
    status: "active",
    limits: PLAN_LIMITS[plan] as PlanLimits,
    downgraded: false,
    graceEndsAt: null,
    subscription: null,
    ...overrides,
  };
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

describe("countActiveApps", () => {
  const running = new Set(["app-1", "app-2", "statisk", "dev-side"]);

  it("teller bare dynamiske prosjekter med en kjørende container", () => {
    const active = countActiveApps(
      [
        { id: "app-1", static_output_dir: null },
        { id: "app-2", static_output_dir: null },
        // Statisk: har ingen container å telle, selv om ID-en skulle dukke opp.
        { id: "statisk", static_output_dir: "dist" },
        // Stoppet eller krasjet: ligger ikke i settet fra Docker.
        { id: "stoppet", static_output_dir: null },
      ],
      running,
    );

    assert.equal(active, 2);
  });

  it("teller en dev-side som en hel app", () => {
    // Dokumenterer dagens oppførsel, ikke et ønske: en dev-side er en ordinær
    // prosjektrad med `parent_project_id` satt, og tellingen ser ikke på det
    // feltet. Endres dette, skal denne testen endres bevisst – ikke overraskes.
    const active = countActiveApps(
      [
        { id: "app-1", static_output_dir: null },
        { id: "dev-side", static_output_dir: null },
      ],
      running,
    );

    assert.equal(active, 2);
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
});
