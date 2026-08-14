import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { config } from "../config.js";
import { logger } from "../lib/logger.js";
import { isStripeConfigured, priceIdForPlan, stripe, type PaidTier } from "../lib/stripe.js";
import type { AuthVariables } from "../middleware/auth.js";
import { ensureCustomer } from "../services/billing.js";
import { planCatalogue, resolveMarket } from "../services/markets.js";
import { entitlementFor, usageFor } from "../services/plans.js";

/**
 * Abonnement sett fra dashboardet.
 *
 * Arver `requireAuth` fra `api`, som alt annet under `/api`. Stripe-webhooken er
 * det eneste unntaket, og den ligger i `routes/stripe.ts` – montert utenfor
 * `api` med vilje.
 */
export const billing = new Hono<{ Variables: AuthVariables }>();

/** Første origin i lista er den kanoniske – resten er alternative CORS-opphav. */
function frontendOrigin(): string {
  return config.SNOAT_FRONTEND_ORIGIN.split(",")[0]!.trim();
}

function requireStripe(): void {
  if (!isStripeConfigured()) {
    throw new HTTPException(503, {
      message: "Betaling er ikke satt opp på denne installasjonen ennå.",
    });
  }
}

/**
 * Oversetter en Stripe-feil til noe kunden kan lese.
 *
 * De vanligste her er ikke kundens feil i det hele tatt, men mangler i
 * Stripe-oppsettet vårt – portalen som ikke er konfigurert, eller Stripe Tax som
 * ikke er aktivert. Kunden skal ikke se `StripeInvalidRequestError`, og vi skal
 * kunne finne den igjen i loggen.
 */
function stripeFailed(error: unknown, context: string): never {
  logger.error({ err: error, context }, "Stripe-kallet feilet");
  throw new HTTPException(502, {
    message: "Betalingsleverandøren svarte ikke som forventet. Prøv igjen om litt.",
  });
}

/**
 * Alt dashboardet trenger for å tegne betalingssiden: gjeldende plan, forbruk og
 * hva planene koster i kundens marked.
 *
 * Frontend sender `?market=no|eu`, utledet av visningsspråket. Den parameteren
 * er et **ønske**, ikke en beslutning: har kunden allerede et abonnement, er
 * valutaen låst hos Stripe, og `resolveMarket()` overstyrer ønsket. Uten den
 * overstyringen ville en kunde som byttet til engelsk sett euro-priser på et
 * abonnement som faktureres i kroner.
 */
billing.get("/", async (c) => {
  const userId = c.get("userId");
  const entitlement = await entitlementFor(userId);
  const usage = await usageFor(userId);

  const { market, locked } = resolveMarket({
    requested: c.req.query("market"),
    subscription: entitlement.subscription,
    acceptLanguage: c.req.header("accept-language"),
  });

  const subscription = entitlement.subscription;

  return c.json({
    plan: entitlement.plan,
    billedPlan: entitlement.billedPlan,
    status: entitlement.status,
    downgraded: entitlement.downgraded,
    graceEndsAt: entitlement.graceEndsAt,
    currentPeriodEnd: subscription?.current_period_end ?? null,
    cancelAtPeriodEnd: subscription?.cancel_at_period_end ?? false,
    source: subscription?.source ?? "stripe",
    limits: entitlement.limits,
    usage,
    plans: planCatalogue(market.id),
    market,
    /** Sant når valutaen er låst av et eksisterende abonnement. */
    marketLocked: locked,
    billingCountry: subscription?.billing_country ?? null,
    /** Uten Stripe skjuler dashboardet kjøpsknappene i stedet for å vise dem døde. */
    stripeConfigured: isStripeConfigured(),
    /** Kundeportalen krever at kunden finnes i Stripe fra før. */
    portalAvailable: isStripeConfigured() && Boolean(subscription?.stripe_customer_id),
  });
});

/**
 * Starter et kjøp. Svarer med URL-en kunden skal sendes til.
 *
 * Vi oppretter aldri abonnementet selv – Checkout håndterer kort, 3-D Secure og
 * kvittering. Planen i databasen settes først når webhooken bekrefter at
 * betalingen gikk gjennom. Ville vi satt den her, ville en kunde som lukket
 * fanen i kassen fått Pro gratis.
 */
billing.post("/checkout", async (c) => {
  requireStripe();

  const userId = c.get("userId");
  const body = await c.req
    .json<{ plan?: string; projectId?: string; market?: string }>()
    .catch(() => ({ plan: undefined, projectId: undefined, market: undefined }));

  if (body.plan !== "pro" && body.plan !== "business") {
    throw new HTTPException(400, { message: "Ukjent plan. Velg «pro» eller «business»." });
  }

  const plan: PaidTier = body.plan;
  const projectId = body.projectId;
  const price = priceIdForPlan(plan);

  if (!price) {
    throw new HTTPException(503, {
      message: `Planen ${plan} er ikke satt opp med en pris i Stripe ennå.`,
    });
  }

  // Valutaen avgjøres her, én gang, og aldri på nytt. Er den låst fra før, går
  // kjøpet i den valutaen uansett hva klienten ba om – Stripe ville avvist
  // sesjonen ellers, siden en kunde bare kan ha én valuta.
  const entitlement = await entitlementFor(userId);
  const { market } = resolveMarket({
    requested: body.market,
    subscription: entitlement.subscription,
    acceptLanguage: c.req.header("accept-language"),
  });

  const origin = frontendOrigin();
  const successUrl = projectId
    ? `${origin}/projects/${projectId}?tab=settings&checkout=ok`
    : `${origin}/settings/billing?checkout=ok`;
  const cancelUrl = projectId
    ? `${origin}/projects/${projectId}?tab=settings&checkout=avbrutt`
    : `${origin}/settings/billing?checkout=avbrutt`;

  try {
    const customer = await ensureCustomer(userId, c.get("userEmail"));

    const session = await stripe().checkout.sessions.create(
      {
        mode: "subscription",
        customer,
        // ⚠️ `currency` på sesjonen, ikke en egen price-ID per valuta. Price-en
        // er multi-valuta (`currency_options`), og dette velger hvilket av
        // beløpene som gjelder. Ber vi om en valuta price-en ikke har, feiler
        // Stripe med «price does not support currency» – det er derfor
        // `PLAN_PRICES` i `services/markets.ts` må holdes i takt med Stripe.
        currency: market.currency,
        line_items: [{ price, quantity: 1 }],
        success_url: successUrl,
        cancel_url: cancelUrl,
        subscription_data: {
          metadata: {
            snoat_user_id: userId,
            snoat_plan: plan,
            snoat_market: market.id,
            ...(projectId ? { snoat_project_id: projectId } : {}),
          },
        },
        // Adressen er ikke bare et kvitteringsfelt: den er grunnlaget Stripe Tax
        // regner avgift etter, og den vi lagrer som `billing_country`.
        billing_address_collection: "required",
        automatic_tax: { enabled: config.STRIPE_AUTOMATIC_TAX },
        customer_update: { address: "auto", name: "auto" },
        // Gir EU-bedrifter mulighet til å oppgi mva-nummer, som utløser omvendt
        // avgiftsplikt automatisk. Det er den enkleste veien inn i EU-markedet:
        // B2B krever ingen VAT OSS-registrering fra vår side.
        tax_id_collection: { enabled: true },
        // Gir kunden et «Har du en kampanjekode?»-felt i kassen. Kan ikke stå
        // sammen med `discounts` – da avviser Stripe sesjonen – så en rabatt vi
        // vil påføre selv må erstatte denne, ikke legges ved siden av.
        allow_promotion_codes: true,
      },
      {
        idempotencyKey: `checkout:${userId}:${projectId ?? "account"}:${plan}:${market.currency}:${Math.floor(Date.now() / 300_000)}`,
      },
    );

    if (!session.url) {
      throw new Error("Checkout-sesjonen kom uten URL");
    }

    logger.info(
      { userId, projectId, plan, market: market.id, currency: market.currency, session: session.id },
      "Checkout-sesjon opprettet",
    );
    return c.json({ url: session.url });
  } catch (error) {
    stripeFailed(error, "checkout.sessions.create");
  }
});

/**
 * Lenke til Stripe sin kundeportal.
 *
 * Der bytter kunden kort, laster ned kvitteringer og sier opp selv. Vi bygger
 * bevisst ikke disse skjermene: da måtte vi håndtert kortdata og
 * oppsigelsesflyt selv, og det er nøyaktig det Stripe gjør bedre enn oss.
 */
billing.post("/portal", async (c) => {
  requireStripe();

  const userId = c.get("userId");
  const entitlement = await entitlementFor(userId);
  const customer = entitlement.subscription?.stripe_customer_id;

  if (!customer) {
    throw new HTTPException(404, {
      message: "Du har ingen betalingsavtale å administrere ennå.",
    });
  }

  try {
    const session = await stripe().billingPortal.sessions.create({
      customer,
      return_url: `${frontendOrigin()}/settings/billing`,
    });

    return c.json({ url: session.url });
  } catch (error) {
    stripeFailed(error, "billingPortal.sessions.create");
  }
});
