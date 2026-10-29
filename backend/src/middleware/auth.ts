import type { Context, MiddlewareHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import { isApiKey, touchApiKey, verifyApiKey } from "../lib/api-keys.js";
import { isOauthAccessToken, touchToken, verifyAccessToken } from "../lib/oauth.js";
import { supabase } from "../lib/supabase.js";
import type { ApiKeyScope, ErrorDetail, Project } from "../types.js";

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
   * LeadLab, og `oauth` er en MCP-klient kunden har koblet til – i praksis
   * Claude. Skillet finnes fordi de tre ikke skal ha nøyaktig samme rettigheter
   * i framtiden – en API-nøkkel har f.eks. ingenting med Stripe-kassen å gjøre.
   * Endepunkter som bryr seg leser denne; resten trenger bare `userId`.
   */
  authKind: "session" | "api_key" | "oauth";
  /** Nøkkelen kallet kom med. `null` for sesjoner og OAuth-tokens. */
  apiKeyId: string | null;
  /**
   * Klienten OAuth-tokenet er utstedt til. `null` for alt annet.
   *
   * Ligger her fordi loggen skal kunne svare på *hvilken* MCP-klient som startet
   * en deployment, ikke bare at «en connector» gjorde det.
   */
  oauthClientId: string | null;
}

/**
 * Stiene et område dekker. `/api/redirects` og alt under, ingenting annet – heller
 * ikke `/api/api-keys`, så en avgrenset nøkkel kan ikke lage seg en full en.
 *
 * `/api` er valgfritt fordi MCP-verktøyene kaller API-appen direkte
 * (`api.fetch()` i `routes/mcp.ts`), og da er stien `/redirects`. Utenfra når
 * man bare API-appen gjennom `/api`, så det åpner ingen ny vei inn.
 */
const SCOPE_PATHS: Record<ApiKeyScope, RegExp> = {
  redirects: /^(?:\/api)?\/redirects(?:\/|$)/,
};

export function scopeAllowsPath(scope: ApiKeyScope, path: string): boolean {
  return SCOPE_PATHS[scope]?.test(path) ?? false;
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

    // En avgrenset nøkkel slipper bare inn på stiene til områdene sine. Sjekken
    // står her og ikke i hver rute, slik at en ny rute aldri kan glemme den:
    // alt som ikke eksplisitt hører til et område, er stengt.
    if (key.scopes && !key.scopes.some((scope) => scopeAllowsPath(scope, c.req.path))) {
      throw new HTTPException(403, {
        message: `Denne API-nøkkelen gjelder bare for: ${key.scopes.join(", ")}.`,
      });
    }

    touchApiKey(key.id);
    c.set("userId", key.user_id);
    c.set("userEmail", undefined);
    c.set("authKind", "api_key");
    c.set("apiKeyId", key.id);
    c.set("oauthClientId", null);
    await next();
    return;
  }

  /**
   * MCP-connectoren.
   *
   * Tokenet er utstedt til en klient kunden har godkjent (`lib/oauth.ts`), men
   * *er* brukeren sin på samme måte som en API-nøkkel: `userId` settes til
   * eieren, og eierskapssjekker og plangrenser nedenfor oppfører seg nøyaktig
   * som om vedkommende var innlogget.
   *
   * At denne grenen ligger i den delte middlewaren – og ikke bare i
   * MCP-endepunktet – er det som gjør at *hele* API-et fungerer for en
   * connector. MCP-verktøyene kaller de vanlige REST-rutene internt
   * (`services/mcp-tools.ts`), og uten dette ville hvert av dem trengt sin egen
   * autentiseringssti.
   */
  if (isOauthAccessToken(token)) {
    const accessToken = await verifyAccessToken(token);

    if (!accessToken) {
      throw new HTTPException(401, { message: "Ugyldig eller utløpt tilgang for MCP-klienten" });
    }

    touchToken(accessToken.id);
    c.set("userId", accessToken.user_id);
    c.set("userEmail", undefined);
    c.set("authKind", "oauth");
    c.set("apiKeyId", null);
    c.set("oauthClientId", accessToken.client_id);
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
  c.set("oauthClientId", null);
  await next();
};

/**
 * Hvem som slipper gjennom til et prosjekt.
 *
 * `owner` er kontoen i `projects.user_id`. `member` er eieren **eller** noen i
 * teamet (`project_members`, migrasjon 0020) – på hovedprosjektet, og dermed
 * også på dev-sidene, som arver teamet.
 */
export type ProjectAccess = "owner" | "member";

/**
 * Er brukeren med i teamet på prosjektet? Eieren regnes ikke med her.
 *
 * Medlemskap ligger på hovedprosjektet, så for en dev-side er det forelderens
 * team som teller.
 */
export async function isProjectMember(project: Project, userId: string): Promise<boolean> {
  const { data, error } = await supabase
    .from("project_members")
    .select("user_id")
    .eq("project_id", project.parent_project_id ?? project.id)
    .eq("user_id", userId)
    .maybeSingle();

  if (error) {
    throw new HTTPException(500, { message: `Databasefeil: ${error.message}` });
  }

  return Boolean(data);
}

/**
 * Henter et prosjekt og bekrefter at kalleren har tilgangen ruten krever.
 *
 * Backend bruker service-role-nøkkelen og omgår dermed RLS, så denne sjekken er
 * det eneste som står mellom en bruker og andres prosjekter. Vi svarer 404 – og
 * ikke 403 – for at et ID-gjett ikke skal avsløre at prosjektet finnes.
 *
 * Et medlem som ber om noe bare eieren kan, får derimot 403: hen *vet* at
 * prosjektet finnes, og «finnes ikke» ville bare vært forvirrende.
 */
export async function loadProject(
  c: Context<{ Variables: AuthVariables }>,
  projectId: string,
  access: ProjectAccess,
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
  const userId = c.get("userId");

  if (project && project.user_id === userId) return project;

  if (!project || !(await isProjectMember(project, userId))) {
    throw new HTTPException(404, { message: "Prosjektet finnes ikke" });
  }

  if (access === "owner") {
    throw new HTTPException(403, {
      message: "Bare eieren av prosjektet kan gjøre dette.",
      cause: { code: "team.owner_only" } satisfies ErrorDetail,
    });
  }

  return project;
}

/**
 * Henter et prosjekt kalleren **eier**.
 *
 * Standarden, med vilje: en rute som ikke eksplisitt har valgt
 * `loadProject(c, id, "member")`, er stengt for teamet. En ny rute kan dermed
 * aldri glemme å stenge – bare glemme å åpne.
 */
export function loadOwnedProject(
  c: Context<{ Variables: AuthVariables }>,
  projectId: string,
): Promise<Project> {
  return loadProject(c, projectId, "owner");
}

/**
 * Alle prosjekt-ID-er brukeren har tilgang til: egne, de hen er medlem av, og
 * dev-sidene til begge.
 *
 * For ruter som spør på tvers av prosjekter (`GET /api/projects`, feillisten),
 * der `loadProject` per rad ville vært ett oppslag per prosjekt.
 */
export async function accessibleProjectIds(userId: string): Promise<string[]> {
  const [owned, memberships] = await Promise.all([
    supabase.from("projects").select("id").eq("user_id", userId),
    supabase.from("project_members").select("project_id").eq("user_id", userId),
  ]);

  if (owned.error) throw new HTTPException(500, { message: `Databasefeil: ${owned.error.message}` });
  if (memberships.error) {
    throw new HTTPException(500, { message: `Databasefeil: ${memberships.error.message}` });
  }

  const ids = new Set((owned.data ?? []).map((row) => row.id as string));
  const roots = (memberships.data ?? []).map((row) => row.project_id as string);

  if (roots.length > 0) {
    const shared = await supabase
      .from("projects")
      .select("id")
      .or(`id.in.(${roots.join(",")}),parent_project_id.in.(${roots.join(",")})`);

    if (shared.error) {
      throw new HTTPException(500, { message: `Databasefeil: ${shared.error.message}` });
    }

    for (const row of shared.data ?? []) ids.add(row.id as string);
  }

  return [...ids];
}
