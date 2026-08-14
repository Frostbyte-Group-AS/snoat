import { config } from "../config.js";
import { isStripeConfigured, priceIdForPlan, type PaidTier } from "../lib/stripe.js";
import type { Subscription, SubscriptionTier } from "../types.js";
import { PLAN_LIMITS, type PlanLimits } from "./plans.js";

/**
 * Markeder: valuta, prispunkt og avgiftsregime.
 *
 * Dette er den andre halvdelen av `plans.ts`. Der står *hva* en plan gir, her
 * står *hva den koster og i hvilken valuta*. Skillet er med vilje: grensene er
 * like i alle markeder, prisene er det ikke.
 *
 * ⚠️ **Marked er ikke språk.** Språket er en preferanse brukeren kan bytte når
 * som helst; markedet er en faktureringsfakta som låses ved første kjøp. De
 * henger sammen ved at *visningen* velger marked (norsk visning → NOK, alt
 * annet → EUR), men når kunden først har betalt, er valutaen låst hos Stripe og
 * `subscriptions.currency` overstyrer visningsspråket.
 */

/**
 * `no` = Norge. `eu` = alt annet, priset i euro.
 *
 * To markeder og ikke tjue: Stripe Tax regner ut riktig avgift per kundeland
 * uansett, så et eget marked per land ville bare vært en liste å vedlikeholde.
 * Det vi faktisk må bestemme selv, er valutaen og prispunktet – og der er det
 * to svar.
 */
export type MarketId = "no" | "eu";

export interface Market {
  id: MarketId;
  /** ISO-4217 i lowercase – samme form som Stripe bruker. */
  currency: string;
  /** Lokale for tall-, dato- og valutaformatering i frontend. */
  locale: string;
  /**
   * Mva-satsen prisen **vises** med, eller null når den ikke kan vises.
   *
   * ⚠️ Dette er ikke satsen kunden faktureres. Det er Stripe Tax som regner ut
   * det faktiske beløpet i kassen, ut fra kundens adresse og eventuelle
   * mva-nummer. For Norge er satsen den samme for alle, så den kan vises på
   * forhånd. For `eu` avhenger den av kundeland (og forsvinner helt ved omvendt
   * avgiftsplikt til EU-bedrifter), så vi viser eks. mva og sier at avgiften
   * beregnes i kassen. Å gjette 25 % for en tysk kunde ville vært å oppgi feil
   * pris.
   */
  displayVatRate: number | null;
  /** Hvordan bedrifter i markedet kan få faktura utenom kort. */
  invoiceChannel: "ehf" | "email";
}

export const MARKETS: Record<MarketId, Market> = {
  no: {
    id: "no",
    currency: "nok",
    locale: "nb-NO",
    displayVatRate: 0.25,
    invoiceChannel: "ehf",
  },
  eu: {
    id: "eu",
    currency: "eur",
    // en-IE: engelsk med euro og europeisk datoformat. `en-US` ville skrevet
    // «€1,234.56» og «8/7/2026» til en kunde i Berlin.
    locale: "en-IE",
    displayVatRate: null,
    invoiceChannel: "email",
  },
};

export const DEFAULT_MARKET: MarketId = "no";

/**
 * Månedspris eks. mva i **minste enhet** – øre for NOK, cent for EUR.
 *
 * ⚠️ Disse tallene må stemme med `currency_options` på price-ene i Stripe.
 * Tabellen her er det kunden ser før hen klikker; Stripe er det som faktisk
 * trekkes. Spriker de to, oppdager vi det først når noen klager på beløpet.
 * Kommandoen for å legge inn valutaene står i
 * `CONTEXT_FOR_AI/12_billing_and_plans.md`.
 *
 * Merk at EUR-prisene er **egne prispunkter**, ikke en valutakurskonvertering
 * av kronebeløpet. 199 kr er ikke 17,32 €; det er 19 €. Et produkt med
 * publiserte priser skal ha runde tall i hver valuta, og kursen skal ikke
 * flytte prislappen fra uke til uke.
 */
export const PLAN_PRICES: Record<MarketId, Record<SubscriptionTier, number>> = {
  // `agency` har ingen listepris. Den avtales og faktureres utenfor Stripe, og
  // vises aldri i katalogen – se `planCatalogue()`. Nullen står her fordi typen
  // krever en verdi per tier, ikke fordi planen er gratis.
  no: { free: 0, pro: 19900, business: 79900, agency: 0 },
  eu: { free: 0, pro: 1900, business: 7900, agency: 0 },
};

/**
 * Planer som ikke skal vises fram.
 *
 * `planCatalogue()` serverer både det innloggede `/api/billing` og den åpne
 * `/api/pricing`. Uten dette filteret ville byråplanen dukket opp på
 * landingssiden med prisen 0 kr – altså som en gratis Business-plan.
 */
const UNLISTED_PLANS: ReadonlySet<SubscriptionTier> = new Set(["agency"]);

/** Antall desimaler i valutaens minste enhet. Begge våre valutaer har to. */
export const CURRENCY_MINOR_UNITS = 100;

export function market(id: MarketId): Market {
  return MARKETS[id];
}

export function isMarketId(value: unknown): value is MarketId {
  return value === "no" || value === "eu";
}

/** Markedet en valuta hører til. Ukjent valuta gir null, ikke en gjetning. */
export function marketForCurrency(currency: string | null | undefined): MarketId | null {
  if (!currency) return null;
  const wanted = currency.toLowerCase();
  const found = (Object.keys(MARKETS) as MarketId[]).find((id) => MARKETS[id].currency === wanted);
  return found ?? null;
}

/**
 * Markedet et visningsspråk hører til.
 *
 * Norsk visning betyr kroner; alt annet betyr euro. Det er en produktbeslutning
 * og ikke en teknisk nødvendighet – en engelsktalende i Oslo får euro-prisen,
 * og faktureres like fullt norsk mva, fordi Stripe Tax går på adressen og ikke
 * på valutaen.
 */
export function marketForLanguage(language: string | null | undefined): MarketId | null {
  if (!language) return null;
  return /^(no|nb|nn)\b/i.test(language.trim()) ? "no" : "eu";
}

/** Førstevalget i en `Accept-Language`-header, uten kvalitetsvekt. */
function primaryLanguage(header: string | null | undefined): string | null {
  const first = header?.split(",")[0]?.split(";")[0]?.trim();
  return first || null;
}

export interface MarketRequest {
  /** Eksplisitt `?market=` fra frontend, utledet av visningsspråket. */
  requested?: string | null;
  /** Abonnementet, hvis brukeren er innlogget og har et. */
  subscription?: Pick<Subscription, "currency"> | null;
  acceptLanguage?: string | null;
}

export interface ResolvedMarket {
  market: Market;
  /**
   * Sant når valutaen er låst av et eksisterende abonnement.
   *
   * ⚠️ Stripe låser valutaen på en kunde ved første faktura. Et abonnement som
   * er opprettet i NOK kan ikke bytte til EUR – det ville krevd en ny kunde.
   * Derfor overstyrer en lagret valuta både visningsspråk og geografi: viser vi
   * euro-prisen til en kunde som faktureres i kroner, står det ett beløp på
   * skjermen og et annet på fakturaen.
   */
  locked: boolean;
}

/**
 * Markedet som gjelder for en forespørsel.
 *
 * Rekkefølgen er streng, og hvert steg er svakere enn det over:
 *
 *   1. **Lagret valuta** – låst hos Stripe, kan ikke overstyres.
 *   2. **Eksplisitt valg** fra frontend (utledet av visningsspråket).
 *   3. **`Accept-Language`** – for kall uten parameter, f.eks. serverrendret
 *      landingsside før i18n har rukket å kjøre i nettleseren.
 *   4. **`SNOAT_DEFAULT_MARKET`**.
 *
 * ⚠️ **Ingen GeoIP her, med vilje.** `lib/geoip.ts` finnes og brukes av
 * trafikkanalysen, så fristelsen er nærliggende – men geografi ville motsagt
 * regelen over: en nordmann som velger engelsk visning skal ha euro-prisen, og
 * et IP-oppslag ville dratt hen tilbake til kroner. Det ville dessuten krevd at
 * vi stolte på `X-Forwarded-For` fra klienten, som er nøyaktig den
 * angrepsflaten `index.ts` beskriver at vi fjernet.
 */
export function resolveMarket(input: MarketRequest): ResolvedMarket {
  const fromSubscription = marketForCurrency(input.subscription?.currency);
  if (fromSubscription) return { market: MARKETS[fromSubscription], locked: true };

  if (isMarketId(input.requested)) return { market: MARKETS[input.requested], locked: false };

  const fromHeader = marketForLanguage(primaryLanguage(input.acceptLanguage));
  if (fromHeader) return { market: MARKETS[fromHeader], locked: false };

  return { market: MARKETS[config.SNOAT_DEFAULT_MARKET], locked: false };
}

/** Prisen for en plan i et marked, i minste enhet. */
export function priceFor(marketId: MarketId, plan: SubscriptionTier): number {
  return PLAN_PRICES[marketId][plan];
}

/**
 * Prisen inkl. mva, eller null når satsen avhenger av kundeland.
 *
 * Null er et meningsbærende svar og ikke en mangel: frontend viser da «eks.
 * mva» med en note om at avgiften beregnes i kassen, i stedet for et tall som
 * er feil for alle utenfor ett land.
 */
export function priceIncludingVat(marketId: MarketId, plan: SubscriptionTier): number | null {
  const rate = MARKETS[marketId].displayVatRate;
  if (rate === null) return null;
  return Math.round(priceFor(marketId, plan) * (1 + rate));
}

export interface PlanOffer {
  id: SubscriptionTier;
  limits: PlanLimits;
  /** Månedspris eks. mva i minste enhet av `currency`. */
  price: number;
  /** Prisen inkl. mva, eller null når satsen avhenger av kundeland. */
  priceIncludingVat: number | null;
  currency: string;
  /** Kan planen kjøpes nå? Krever at Stripe og price-ID-en er konfigurert. */
  purchasable: boolean;
}

/**
 * Plankatalogen slik den ser ut i ett marked.
 *
 * Ligger i backend og ikke i frontend fordi grensene håndheves i backend. Sto
 * de to stedene, ville prissiden og virkeligheten før eller siden sagt ulike
 * ting – og det er prissiden kunden husker. Samme funksjon serverer både det
 * innloggede `/api/billing` og det åpne `/api/pricing`, slik at landingssiden
 * ikke kan komme i utakt med dashboardet.
 */
export function planCatalogue(marketId: MarketId): PlanOffer[] {
  return (Object.keys(PLAN_LIMITS) as SubscriptionTier[])
    .filter((plan) => !UNLISTED_PLANS.has(plan))
    .map((plan) => ({
      id: plan,
      limits: PLAN_LIMITS[plan],
      price: priceFor(marketId, plan),
      priceIncludingVat: priceIncludingVat(marketId, plan),
      currency: MARKETS[marketId].currency,
      purchasable:
        plan !== "free" && isStripeConfigured() && priceIdForPlan(plan as PaidTier) !== null,
    }));
}
