import type { Deployment, SubscriptionStatus, SubscriptionTier } from "./database.types";
import type { MarketId } from "./market";
import { getSupabase } from "./supabase";

const baseUrl = (import.meta.env.VITE_SNOAT_API_URL as string | undefined) ?? "";

/**
 * Kall mot Snoat-backend (bygge-motoren).
 *
 * Vi sender brukerens Supabase access-token videre. Backend bruker
 * service-role-nøkkelen og omgår RLS, så den må verifisere tokenet og
 * eierskapet selv – derfor er dette den eneste måten å nå API-et på.
 */
/**
 * En feil fra backend, med den maskinlesbare koden intakt.
 *
 * `message` fra backend er **norsk** – den skrives i loggen der, ikke i
 * dashboardet her. Feil som er ment for kunden bærer i tillegg en `code` som
 * slås opp i `errors`-seksjonen av oversettelsene. Uten dette skillet ville en
 * engelsk bruker fått «Du har brukt 100 av 100 byggeminutter denne måneden»
 * midt i et ellers engelsk grensesnitt.
 *
 * Bruk `useApiErrorMessage()` i `lib/errors.ts` for å få ut riktig tekst.
 */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string | null = null,
    readonly params: Record<string, string | number> = {},
  ) {
    super(message);
    this.name = "ApiError";
  }
}

interface ErrorBody {
  error?: string;
  code?: string;
  params?: Record<string, string | number>;
}

async function parse<T>(response: Response, path: string): Promise<T> {
  const body = (await response.json().catch(() => null)) as (ErrorBody & T) | null;

  if (!response.ok) {
    throw new ApiError(
      body?.error ?? `Forespørselen feilet (${response.status})`,
      response.status,
      body?.code ?? null,
      body?.params ?? {},
    );
  }

  if (body === null) throw new ApiError(`Tomt svar fra ${path}`, response.status);

  return body as T;
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const { data } = await getSupabase().auth.getSession();
  const token = data.session?.access_token;

  if (!token) throw new ApiError("Du er ikke logget inn.", 401, "auth.signed_out");

  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      ...init.headers,
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
  });

  return parse<T>(response, path);
}

/** Kall mot endepunkter som ikke krever innlogging, som plankatalogen. */
async function publicRequest<T>(path: string): Promise<T> {
  return parse<T>(await fetch(`${baseUrl}${path}`), path);
}

/** Starter en deployment. Svarer så snart raden finnes – bygget kjører videre. */
export function deployProject(projectId: string): Promise<{ deployment: Deployment }> {
  return request(`/api/projects/${projectId}/deploy`, { method: "POST" });
}

/** Stopper containeren og fjerner ruten, uten å slette prosjektet. */
export function stopProject(projectId: string): Promise<{ stopped: boolean }> {
  return request(`/api/projects/${projectId}/stop`, { method: "POST" });
}

/** Oppdaterer eget domene for et prosjekt. */
export function updateCustomDomain(projectId: string, customDomain: string | null): Promise<{ success: boolean; custom_domain: string | null }> {
  return request(`/api/projects/${projectId}/domain`, { 
    method: "PATCH",
    body: JSON.stringify({ custom_domain: customDomain }) 
  });
}

/** Én av de tre tingene som må stemme før et eget domene svarer. */
export interface DomainCheck {
  state: "ok" | "pending" | "failed";
  detail: string;
}

export interface DomainStatus {
  domain: string;
  ready: boolean;
  dns: DomainCheck & { expected: string; found: string[] };
  route: DomainCheck;
  certificate: DomainCheck;
}

/** Måler om det egne domenet faktisk virker. Endrer ingenting. */
export function getDomainStatus(projectId: string): Promise<DomainStatus> {
  return request(`/api/projects/${projectId}/domain/status`);
}

/** Et repository brukeren har gitt Snoat tilgang til via GitHub App-en. */
export interface GithubRepo {
  id: number;
  name: string;
  fullName: string;
  private: boolean;
  cloneUrl: string;
  defaultBranch: string;
  updatedAt: string | null;
  installationId: number;
}

export interface GithubStatus {
  /** Er GitHub App-en satt opp på denne Snoat-installasjonen i det hele tatt? */
  configured: boolean;
  /** Har brukeren installert den på minst én konto? */
  connected: boolean;
  installations: Array<{ installationId: number; accountLogin: string; accountType: string }>;
  installUrl: string | null;
}

export function getGithubStatus(): Promise<GithubStatus> {
  return request("/api/github/status");
}

export function listGithubRepos(): Promise<{ repos: GithubRepo[] }> {
  return request("/api/github/repos");
}

/** Grensene som følger en plan. Speiler `PlanLimits` i backend. */
export interface PlanLimits {
  maxRunningProjects: number;
  memoryMb: number;
  cpus: number;
  buildMinutesPerMonth: number;
  queuePriority: number;
}

/** Speiler `Market` i `backend/src/services/markets.ts`. */
export interface Market {
  id: MarketId;
  /** ISO-4217 lowercase, som hos Stripe. */
  currency: string;
  locale: string;
  /**
   * Mva-satsen prisen **vises** med, eller null når den avhenger av kundeland.
   *
   * Null betyr «vi kan ikke oppgi en pris inkl. mva» og ikke «ingen mva». For
   * euro-markedet varierer satsen fra land til land, og forsvinner helt ved
   * omvendt avgiftsplikt til en EU-bedrift, så Stripe regner den i kassen. Å
   * vise 25 % til en tysk kunde ville vært å oppgi feil pris.
   */
  displayVatRate: number | null;
  invoiceChannel: "ehf" | "email";
}

export interface PlanOption {
  id: SubscriptionTier;
  limits: PlanLimits;
  /** Månedspris eks. mva i **minste enhet** av `currency` – øre eller cent. */
  price: number;
  /** Prisen inkl. mva, eller null når satsen avhenger av kundeland. */
  priceIncludingVat: number | null;
  currency: string;
  /** Kan planen kjøpes nå? Krever at Stripe og price-ID-en er konfigurert. */
  purchasable: boolean;
}

/** Plankatalogen uten innlogging – det landingssiden viser. */
export interface PricingState {
  market: Market;
  plans: PlanOption[];
}

export function getPricing(market: MarketId): Promise<PricingState> {
  return publicRequest(`/api/pricing?market=${market}`);
}

export interface BillingUsage {
  runningProjects: number;
  totalProjects: number;
  staticProjects: number;
  buildMinutesUsed: number;
}

export interface BillingState {
  /** Planen grensene regnes ut fra nå. */
  plan: SubscriptionTier;
  /** Planen kunden betaler for. Ulik `plan` bare når betalingen har feilet. */
  billedPlan: SubscriptionTier;
  status: SubscriptionStatus;
  /** Sant når nådefristen er ute og kontoen kjører på gratisgrensene. */
  downgraded: boolean;
  graceEndsAt: string | null;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  source: "stripe" | "invoice";
  limits: PlanLimits;
  usage: BillingUsage;
  plans: PlanOption[];
  /** Markedet katalogen over er priset i. Kan avvike fra det vi ba om. */
  market: Market;
  /**
   * Sant når valutaen er låst av et eksisterende abonnement.
   *
   * ⚠️ Stripe låser valutaen til kunden ved første faktura, så et abonnement
   * tegnet i kroner kan ikke bytte til euro. Er denne sann, ignorerte backend
   * markedet vi ba om – og siden skal si fra om det i stedet for å late som om
   * kunden kan velge.
   */
  marketLocked: boolean;
  billingCountry: string | null;
  stripeConfigured: boolean;
  portalAvailable: boolean;
}

export function getBilling(market: MarketId): Promise<BillingState> {
  return request(`/api/billing?market=${market}`);
}

/** Oppretter en Stripe Checkout-sesjon. Svarer med URL-en kunden skal til. */
export function createCheckout(
  plan: "pro" | "business",
  market: MarketId,
  projectId?: string,
): Promise<{ url: string }> {
  return request("/api/billing/checkout", {
    method: "POST",
    body: JSON.stringify({ plan, market, projectId }),
  });
}

/** Lenke til Stripe sin kundeportal: kort, kvitteringer og oppsigelse. */
export function createBillingPortal(): Promise<{ url: string }> {
  return request("/api/billing/portal", { method: "POST" });
}

// -----------------------------------------------------------------------------
// Analytics & Trafikkanalyse
// -----------------------------------------------------------------------------
/**
 * Statistikken samles inn fra Caddys access-logg, ikke fra et sporingsskript i
 * kundens app. Derfor finnes det ingen «website id» å hente eller sette opp –
 * hvert prosjekt har tall fra første besøkende, uten at noe er installert.
 */

export type AnalyticsDimension = "path" | "referrer" | "browser" | "os" | "device" | "country";

export interface AnalyticsDimensionItem {
  value: string;
  hits: number;
}

export interface AnalyticsPoint {
  /** Bøttens start, beregnet i norsk tid av databasen. */
  t: string;
  pageviews: number;
  visits: number;
  requests: number;
  errors: number;
}

export interface AnalyticsSummary {
  totals: {
    /** HTML-svar. Bilder og API-kall er forespørsler, men ikke sidevisninger. */
    pageviews: number;
    visits: number;
    requests: number;
    bytes_out: number;
    errors_4xx: number;
    errors_5xx: number;
    /** Holdt utenfor tallene over; vist for åpenhet om hvor mye som er roboter. */
    bot_requests: number;
    avg_duration_ms: number;
  };
  /** Summen av daglige unike – ikke unike personer over flere døgn. */
  visitors: number;
  series: AnalyticsPoint[];
  dims: Partial<Record<AnalyticsDimension, AnalyticsDimensionItem[]>>;
  unit: string;
}

/** Hele statistikkfanen i ett kall: nøkkeltall, graf og alle dimensjonene. */
export function getProjectAnalytics(
  projectId: string,
  from: number,
  to: number,
  unit: string,
): Promise<AnalyticsSummary> {
  const query = new URLSearchParams({ from: String(from), to: String(to), unit });
  return request(`/api/projects/${projectId}/analytics?${query}`);
}

export interface ApiKeyItem {
  id: string;
  name: string;
  token_prefix: string;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}

/** Henter alle aktive API-nøkler for brukeren. */
export function fetchApiKeys(): Promise<{ keys: ApiKeyItem[] }> {
  return request("/api/api-keys");
}

/** Oppretter en ny API-nøkkel (f.eks. for MCP server). Tokenet vises kun i svaret! */
export function createApiKey(name: string = "Snoat MCP Server"): Promise<{ key: ApiKeyItem; token: string }> {
  return request("/api/api-keys", {
    method: "POST",
    body: JSON.stringify({ name }),
  });
}

/** Trekker tilbake en API-nøkkel. */
export function revokeApiKey(keyId: string): Promise<{ success: boolean }> {
  return request(`/api/api-keys/${keyId}`, {
    method: "DELETE",
  });
}

