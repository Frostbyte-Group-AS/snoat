import Stripe from "stripe";
import { config } from "../config.js";
import type { SubscriptionTier } from "../types.js";

/**
 * Stripe-klienten, opprettet lat.
 *
 * Lat av samme grunn som `getSupabase()` i frontend: `new Stripe(...)` uten
 * nøkkel kaster, og Stripe er valgfritt. Et lokalt oppsett uten
 * `STRIPE_SECRET_KEY` skal starte og deploye som før – bare uten betaling.
 */
let client: Stripe | null = null;

export function isStripeConfigured(): boolean {
  return Boolean(config.STRIPE_SECRET_KEY);
}

export function stripe(): Stripe {
  if (!config.STRIPE_SECRET_KEY) {
    throw new Error("STRIPE_SECRET_KEY er ikke satt – betaling er ikke konfigurert.");
  }

  // Ingen `apiVersion` her med vilje: da bruker SDK-en versjonen den er bygget
  // for, og oppgraderes den, følger typene med i samme commit. Pinner vi en
  // versjon manuelt, må strengen vedlikeholdes i takt med pakken – og en
  // feilstavet versjon oppdages først i produksjon.
  client ??= new Stripe(config.STRIPE_SECRET_KEY);
  return client;
}

/**
 * Planene som faktisk kan kjøpes. `free` krever ingen betaling, og `agency`
 * avtales og faktureres utenfor Stripe – den har ingen price-ID å peke på.
 */
export type PaidTier = Exclude<SubscriptionTier, "free" | "agency">;

export function priceIdForPlan(plan: PaidTier): string | null {
  return (plan === "pro" ? config.STRIPE_PRICE_PRO : config.STRIPE_PRICE_BUSINESS) ?? null;
}

/**
 * Hvilken plan et abonnement gjelder, lest ut av Stripe-objektet.
 *
 * Vi ser først på **metadata** på price-en eller product-en (`snoat_plan`), og
 * faller tilbake på å sammenligne price-ID mot konfigurasjonen. Rekkefølgen er
 * bevisst: `STRIPE_PRICE_PRO` peker på den prisen vi selger *nå*. Justerer vi
 * prisen, lager Stripe en ny price-ID, mens eksisterende abonnenter blir
 * liggende på den gamle. Uten metadata ville alle de kundene sett ut som om de
 * hadde en ukjent plan ved neste webhook, og blitt nedgradert til `free`.
 *
 * Sett derfor `snoat_plan=pro` / `snoat_plan=business` som metadata på
 * **produktet** i Stripe – da arver alle framtidige priser den.
 */
export function planForSubscription(subscription: Stripe.Subscription): SubscriptionTier | null {
  const item = subscription.items.data[0];
  if (!item) return null;

  const price = item.price;
  const fromMetadata =
    price.metadata?.snoat_plan ??
    (typeof price.product === "object" && price.product && !price.product.deleted
      ? price.product.metadata?.snoat_plan
      : undefined);

  if (fromMetadata === "pro" || fromMetadata === "business" || fromMetadata === "free") {
    return fromMetadata;
  }

  if (price.id === config.STRIPE_PRICE_PRO) return "pro";
  if (price.id === config.STRIPE_PRICE_BUSINESS) return "business";

  return null;
}

/**
 * Verifiserer signaturen og tolker råkroppen som et Stripe-event.
 *
 * `constructEventAsync` og ikke `constructEvent`: den synkrone varianten bruker
 * Node sin `crypto` direkte, mens den asynkrone går via WebCrypto og virker i
 * alle kjøretidene Hono støtter. De verifiserer det samme.
 *
 * `body` må være **råkroppen**. Har den vært innom `JSON.parse` og blitt
 * serialisert på nytt, stemmer ikke signaturen lenger – nøkkelrekkefølge og
 * mellomrom er en del av det som er signert.
 */
export async function constructEvent(body: string, signature: string): Promise<Stripe.Event> {
  if (!config.STRIPE_WEBHOOK_SECRET) {
    throw new Error("STRIPE_WEBHOOK_SECRET er ikke satt.");
  }

  return await stripe().webhooks.constructEventAsync(body, signature, config.STRIPE_WEBHOOK_SECRET);
}
