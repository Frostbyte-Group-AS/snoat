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
   * Integrasjonens egen ID for prosjektet, satt av `POST /api/projects`.
   * NULL for prosjekter opprettet herfra – dashboardet skriver aldri feltet.
   */
  external_ref?: string | null;
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
}
