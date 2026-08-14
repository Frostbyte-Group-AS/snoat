/**
 * Typer for Snoat-skjemaet i Supabase.
 * Speiler supabase/migrations/0001_snoat_schema.sql.
 */

export type DeploymentStatus = "queued" | "building" | "success" | "failed";

export interface Project {
  id: string;
  user_id: string;
  /** URL-vennlig slug – blir subdomenet `<name>.snoat.localhost`. */
  name: string;
  custom_domain: string | null;
  repo_url: string;
  build_command: string | null;
  env_vars: Record<string, string> | null;
  /**
   * Katalogen i byggeresultatet som serveres statisk (relativt til `/app`).
   * NULL = prosjektet kjøres som container. Se `services/static-site.ts`.
   */
  static_output_dir: string | null;
  /** Serverer `index.html` for URL-er uten treff. Kreves av SPA-er med klientruting. */
  static_spa_fallback: boolean;
  /**
   * Installasjonen repoet ble valgt gjennom. NULL for offentlige repoer limt
   * inn som URL – de klones uten autentisering.
   */
  github_installation_id: number | null;
  /**
   * Når brukeren stoppet prosjektet. NULL = kjører, eller skal kjøre.
   *
   * Uten denne kolonnen var et stopp usynlig i dashboardet: statusen der utledes
   * av `deployments.status`, og en stopp rører ingen deployment.
   */
  stopped_at: string | null;
  /** Planen prosjektet kjører på ('free', 'pro', 'business', 'agency'). */
  plan?: SubscriptionTier;
  /**
   * Kallerens egen ID for prosjektet, satt ved opprettelse over maskin-APIet.
   * Unik per bruker, og det som gjør `POST /api/projects` idempotent.
   * NULL for prosjekter opprettet fra dashboardet.
   */
  external_ref: string | null;
  created_at: string;
}

/**
 * Svaret fra `public.analytics_summary()`.
 *
 * Speiler `jsonb_build_object`-kallene i migrasjon 0008. Endres formen der,
 * må den endres her – TypeScript kan ikke se inn i SQL-funksjonen.
 */
export interface AnalyticsSummary {
  totals: {
    /** Svar med Content-Type text/html. Assets og API-kall teller ikke. */
    pageviews: number;
    /** Besøk som startet i perioden – nye besøkende-hasher for døgnet. */
    visits: number;
    requests: number;
    bytes_out: number;
    errors_4xx: number;
    errors_5xx: number;
    /** Holdes utenfor alle tallene over; med her for å kunne kalibrere filteret. */
    bot_requests: number;
    avg_duration_ms: number;
  };
  /** Summen av daglige unike – ikke unike personer over flere døgn. Se 0008. */
  visitors: number;
  series: Array<{
    /** Bøttens start som ISO-tidspunkt, beregnet i norsk tid. */
    t: string;
    pageviews: number;
    visits: number;
    requests: number;
    errors: number;
  }>;
  dims: Partial<Record<AnalyticsDimension, Array<{ value: string; hits: number }>>>;
  unit: string;
}

export type AnalyticsDimension = "path" | "referrer" | "browser" | "os" | "device" | "country";

/**
 * Langlevd nøkkel for maskin-til-maskin-tilgang. Speiler `public.api_keys`
 * (migrasjon 0010). Klartekstnøkkelen finnes ikke her – kun sha256-hashen.
 */
export interface ApiKey {
  id: string;
  user_id: string;
  name: string;
  token_prefix: string;
  token_hash: string;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}

/** Kobling mellom en Snoat-bruker og en GitHub App-installasjon. */
export interface GithubInstallation {
  id: string;
  user_id: string;
  installation_id: number;
  account_login: string;
  account_type: string;
  created_at: string;
}

export interface Deployment {
  id: string;
  project_id: string;
  status: DeploymentStatus;
  commit_hash: string | null;
  logs: string;
  url: string | null;
  /** Hvor lenge bygget kjørte. NULL mens det pågår, og for rader fra før 0004. */
  duration_ms: number | null;
  created_at: string;
}

/**
 * `agency` er ikke en plan noen kan kjøpe.
 *
 * Den finnes for integrasjonspartnere som drifter mange kundesider under én
 * konto hos oss (LeadLab/«Snekkeren»), og settes for hånd med
 * `source = 'invoice'`. Å modellere det som en ordinær tier – i stedet for et
 * «hvis dette er LeadLab»-unntak spredt utover sperrepunktene – gjør at
 * `entitlementFor()` og `assertCanDeploy()` går sin vante vei.
 *
 * Den holdes utenfor plankatalogen i `services/markets.ts`, slik at den ikke
 * dukker opp på prissiden.
 */
export type SubscriptionTier = "free" | "pro" | "business" | "agency";

export type SubscriptionStatus =
  | "active"
  | "trialing"
  | "past_due"
  | "unpaid"
  | "canceled"
  | "incomplete";

/**
 * Abonnementet til én bruker. Speiler `public.subscriptions` (migrasjon 0004).
 *
 * Ligger bevisst i sin egen tabell og ikke på `profiles`: `profiles` har en
 * update-policy for eieren, og RLS er rad-nivå, så en `plan`-kolonne der kunne
 * brukeren satt selv fra nettleseren.
 */
export interface Subscription {
  user_id: string;
  plan: SubscriptionTier;
  status: SubscriptionStatus;
  /** 'stripe' = kort og webhooks. 'invoice' = EHF-faktura, satt for hånd. */
  source: "stripe" | "invoice";
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  current_period_end: string | null;
  delinquent_since: string | null;
  cancel_at_period_end: boolean;
  /**
   * Faktureringsland (ISO-3166-1 alpha-2), hentet fra adressen i Stripe.
   *
   * Ikke det samme som visningsspråk. Dette er landet Stripe Tax regner avgift
   * etter, og det eneste vi har som sier hvor kunden faktisk holder til.
   */
  billing_country: string | null;
  /**
   * Valutaen abonnementet faktureres i (ISO-4217 lowercase, som hos Stripe).
   *
   * ⚠️ Låst etter første faktura. Stripe knytter valutaen til kunden, ikke til
   * abonnementet, så den kan ikke byttes uten en ny kunde. `resolveMarket()` i
   * `services/markets.ts` lar derfor denne overstyre både språk og geografi.
   */
  currency: string | null;
  /** Om kunden oppga et mva-/organisasjonsnummer i kassen. */
  customer_kind: "individual" | "business" | null;
  created_at: string;
  updated_at: string;
}

/**
 * Maskinlesbar identifikasjon av en feil, til bruk i frontend.
 *
 * `message` på `DeployError` er norsk og går i loggen. Den er ubrukelig for et
 * engelsk dashboard, så feil kunden skal *se* bærer i tillegg en `code` som
 * slås opp i `errors`-seksjonen av oversettelsene, med `params` interpolert inn.
 */
export interface ErrorDetail {
  code: string;
  params?: Record<string, string | number>;
}

/** Feil vi selv kaster i pipelinen, med et menneskelig lesbart steg. */
export class DeployError extends Error {
  /**
   * Satt kun på feil som er ment for kunden. Interne feil («containeren startet
   * ikke») har ingen kode: de skal leses av oss i loggen, ikke oversettes.
   */
  readonly detail: ErrorDetail | null;

  constructor(
    readonly step: string,
    message: string,
    detail?: ErrorDetail,
  ) {
    super(message);
    this.name = "DeployError";
    this.detail = detail ?? null;
  }
}
