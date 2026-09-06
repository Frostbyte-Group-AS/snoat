/**
 * Håndskrevne typer for Snoat-skjemaet.
 * Speiler supabase/migrations/0001_snoat_schema.sql og CONTEXT_FOR_AI/04_database_schema.md.
 */

export type DeploymentStatus = "queued" | "building" | "success" | "failed";

export interface Profile {
  id: string;
  full_name: string | null;
  avatar_url: string | null;
  created_at: string;
}

export interface Project {
  id: string;
  user_id: string;
  /** URL-vennlig slug – blir subdomenet `<name>.<snoat-domenet>`. */
  name: string;
  /** Eget domene knyttet til prosjektet (valgfritt) */
  custom_domain: string | null;
  repo_url: string;
  /**
   * Grenen som klones og deployes (migrasjon 0012).
   *
   * NULL = bruk repoets default branch, altså den GitHub har pekt ut. Feltet
   * styrer både hva som bygges og hvilke push-events auto-deploy reagerer på, så
   * et tomt felt i innstillingene er et bevisst valg – ikke en manglende verdi.
   */
  branch: string | null;
  build_command: string | null;
  env_vars: Record<string, string>;
  /**
   * GitHub App-installasjonen repoet ble valgt gjennom, satt av repo-velgeren.
   * NULL for offentlige repoer limt inn som URL.
   */
  github_installation_id: number | null;
  /**
   * Katalogen i byggeresultatet som serveres statisk av Caddy, uten container
   * (f.eks. `dist`). NULL = prosjektet kjøres som container.
   */
  static_output_dir: string | null;
  /** Serverer `index.html` for URL-er uten treff. Kreves av SPA-er med klientruting. */
  static_spa_fallback: boolean;
  /**
   * Når brukeren stoppet prosjektet. NULL = kjører, eller skal kjøre.
   *
   * Statusprikken utledes ellers utelukkende av `deployments.status`, og et
   * stopp rører ingen deployment – uten dette feltet så en stoppet app fortsatt
   * ut som «Live».
   */
  stopped_at: string | null;
  /** Planen prosjektet kjører på ('free', 'pro', 'business', 'agency'). */
  plan?: SubscriptionTier;
  /**
   * Prosjektet denne raden er et miljø for (migrasjon 0013).
   *
   * NULL = et ordinært prosjekt. Satt = en dev-side: samme repo, en annen gren,
   * eget vertsnavn og passord foran. Dashboardet grupperer på dette feltet, slik
   * at dev-sidene står under prosjektet sitt og ikke som egne kort.
   */
  parent_project_id?: string | null;
  /**
   * Sant når appen krever passord for å åpnes.
   *
   * Selve hashen ligger i `project_access`, som ingen klient kan lese – dette
   * feltet finnes nettopp for at UI-et skal kunne vise en hengelås uten å ha
   * sett den.
   */
  access_protected?: boolean;
  /**
   * Integrasjonens egen ID for prosjektet, satt av `POST /api/projects`.
   * NULL for prosjekter opprettet herfra – dashboardet skriver aldri feltet.
   */
  external_ref?: string | null;
  /**
   * Satt av det periodiske helsesveipet på backend (migrasjon 0015,
   * `services/helse.ts`) når containeren prosjektet skal ha kjørende er borte
   * fra Docker, selv om siste deployment er `success` og prosjektet ikke er
   * stoppet.
   *
   * NULL = ingen kjent avvik. Dette er tilstanden som gjør at et prosjekt
   * stemplet `success` likevel ikke vises som «Live» – se
   * `DeploymentStatusBadge`.
   */
  container_died_at?: string | null;
  created_at: string;
}

export interface Deployment {
  id: string;
  project_id: string;
  status: DeploymentStatus;
  commit_hash: string | null;
  logs: string;
  url: string | null;
  /** Byggets varighet i millisekunder. NULL mens det pågår, og for rader fra før 0004. */
  duration_ms: number | null;
  /**
   * Grenen bygget kom fra (migrasjon 0014).
   *
   * Egen kolonne og ikke `project.branch`: den kan endres i morgen, og da ville
   * byggehistorikken påstått at gårsdagens bygg kom fra den nye grenen. NULL
   * for rader fra før 0014 – da vet vi rett og slett ikke, og UI-et skal si
   * ingenting framfor å gjette.
   */
  branch: string | null;
  created_at: string;
}

export type SubscriptionTier = "free" | "pro" | "business";

export type SubscriptionStatus =
  "active" | "trialing" | "past_due" | "unpaid" | "canceled" | "incomplete";

/**
 * Abonnementet til den innloggede brukeren (`public.subscriptions`).
 *
 * **Kun lesbar.** Tabellen har ingen update-policy: planen settes utelukkende av
 * backend etter en verifisert Stripe-webhook. Et forsøk på å skrive herfra
 * feiler, og det er hele poenget – lå `plan` på `profiles`, som har en
 * update-policy for eieren, kunne enhver bruker gitt seg selv Business.
 *
 * Dashboardet henter dette gjennom `/api/billing` i stedet for direkte fra
 * Supabase, siden forbrukstallene uansett må telles i backend.
 */
export interface Subscription {
  user_id: string;
  plan: SubscriptionTier;
  status: SubscriptionStatus;
  source: "stripe" | "invoice";
  current_period_end: string | null;
  cancel_at_period_end: boolean;
  /** Faktureringsland (ISO-3166-1 alpha-2) fra adressen i Stripe. */
  billing_country: string | null;
  /**
   * Valutaen abonnementet faktureres i (ISO-4217 lowercase).
   *
   * ⚠️ Låst etter første faktura – Stripe knytter valutaen til kunden. Er den
   * satt, overstyrer den visningsspråket når backend velger prisliste, og
   * `BillingState.marketLocked` er sann.
   */
  currency: string | null;
  customer_kind: "individual" | "business" | null;
}

/** Et prosjekt slik dashboardet henter det: med sin nyeste deployment. */
export interface ProjectWithLatestDeployment extends Project {
  latestDeployment: Deployment | null;
  /**
   * Dev-grenene under prosjektet (migrasjon 0013).
   *
   * Bare satt på hovedprosjekter, og bare av `fetchProjects()` i dashboardet –
   * andre spørringer etter samme type lar den stå udefinert framfor å påstå at
   * prosjektet ikke har dev-grener.
   */
  devSites?: ProjectWithLatestDeployment[];
}
