import type { Context, MiddlewareHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import { isApiKey, touchApiKey, verifyApiKey } from "../lib/api-keys.js";
import { supabase } from "../lib/supabase.js";
import type { Project } from "../types.js";

export interface AuthVariables {
  userId: string;
  /**
   * E-posten på Supabase-brukeren, brukt når Stripe-kunden opprettes.
   *
   * Kan være `undefined`: GoTrue tillater brukere uten e-post. Stripe godtar en
   * kunde uten e-post, så det er ikke noe å feile på – kvitteringen havner bare
   * ingen steder før kunden fyller den inn selv i portalen.
   */
  userEmail: string | undefined;
  /**
   * Hvordan kalleren beviste hvem den er.
   *
   * `session` er et menneske i dashboardet, `api_key` er en integrasjon som
   * LeadLab. Skillet finnes fordi de to ikke skal ha nøyaktig samme rettigheter
   * i framtiden – en API-nøkkel har f.eks. ingenting med Stripe-kassen å gjøre.
   * Endepunkter som bryr seg leser denne; resten trenger bare `userId`.
   */
  authKind: "session" | "api_key";
  /** Nøkkelen kallet kom med. `null` for sesjoner. */
  apiKeyId: string | null;
}

/**
 * Verifiserer kalleren – enten en Supabase-sesjon eller en API-nøkkel.
 *
 * Dashboardet sender access-tokenet sitt som `Authorization: Bearer <jwt>`. Vi
 * lar GoTrue validere det i stedet for å verifisere signaturen selv – da fanger
 * vi også opp tokens som er trukket tilbake, ikke bare utløpte.
 *
 * Integrasjoner sender `Authorization: Bearer snoat_ak_…` i samme header.
 * Prefikset avgjør hvilken vei kallet tar, slik at vi slipper å prøve begge mot
 * hver forespørsel – et ugyldig JWT ville ellers kostet et rundturs-kall til
 * GoTrue før vi i det hele tatt vurderte at det kunne være en nøkkel.
 *
 * En API-nøkkel *er* brukeren sin: `userId` settes til eieren av nøkkelen, og
 * alt nedenfor – eierskapssjekker, plangrenser, `loadOwnedProject` – oppfører
 * seg nøyaktig som om vedkommende var innlogget. Det er hele poenget med
 * byrå-modellen: LeadLab er én konto hos oss, ikke et unntak i tilgangskoden.
 */
export const requireAuth: MiddlewareHandler<{ Variables: AuthVariables }> = async (c, next) => {
  const header = c.req.header("Authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : null;

  if (!token) {
    throw new HTTPException(401, { message: "Mangler Authorization-header" });
  }

  if (isApiKey(token)) {
    const key = await verifyApiKey(token);

    if (!key) {
      throw new HTTPException(401, { message: "Ugyldig eller tilbaketrukket API-nøkkel" });
    }

    touchApiKey(key.id);
    c.set("userId", key.user_id);
    c.set("userEmail", undefined);
    c.set("authKind", "api_key");
    c.set("apiKeyId", key.id);
    await next();
    return;
  }

  const { data, error } = await supabase.auth.getUser(token);

  if (error || !data.user) {
    throw new HTTPException(401, { message: "Ugyldig eller utløpt sesjon" });
  }

  c.set("userId", data.user.id);
  c.set("userEmail", data.user.email);
  c.set("authKind", "session");
  c.set("apiKeyId", null);
  await next();
};

/**
 * Henter et prosjekt og bekrefter at det tilhører den innloggede brukeren.
 *
 * Backend bruker service-role-nøkkelen og omgår dermed RLS, så denne sjekken er
 * det eneste som står mellom en bruker og andres prosjekter. Vi svarer 404 – og
 * ikke 403 – for at et ID-gjett ikke skal avsløre at prosjektet finnes.
 */
export async function loadOwnedProject(
  c: Context<{ Variables: AuthVariables }>,
  projectId: string,
): Promise<Project> {
  const { data, error } = await supabase
    .from("projects")
    .select("*")
    .eq("id", projectId)
    .maybeSingle();

  if (error) {
    throw new HTTPException(500, { message: `Databasefeil: ${error.message}` });
  }

  const project = data as Project | null;

  if (!project || project.user_id !== c.get("userId")) {
    throw new HTTPException(404, { message: "Prosjektet finnes ikke" });
  }

  return project;
}
