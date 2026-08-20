import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { supabase } from "../lib/supabase.js";
import { generateApiKey } from "../lib/api-keys.js";
import { listConnections, revokeClientTokens } from "../lib/oauth.js";
import { loadOwnedProject, requireAuth, type AuthVariables } from "../middleware/auth.js";
import * as analytics from "../services/analytics.js";
import { invalidateHostMap } from "../services/analytics-ingest.js";
import * as deploy from "../services/deploy.js";
import { ensureProjectRoute, type RouteStatus } from "../services/deploy.js";
import { checkDomain } from "../services/domain-status.js";
import { assertSafeRepoUrl } from "../services/git.js";
import { entitlementFor } from "../services/plans.js";
import { logger } from "../lib/logger.js";
import { DeployError, type Deployment, type ErrorDetail } from "../types.js";
import { billing } from "./billing.js";
import { githubApi } from "./github.js";

export const api = new Hono<{ Variables: AuthVariables }>();

api.use("*", requireAuth);

/** Repo-velgeren i «Nytt prosjekt». Arver requireAuth fra linjen over. */
api.route("/github", githubApi);

/**
 * Abonnement, kjøp og kundeportal. Arver også requireAuth.
 *
 * Stripe-webhooken er **ikke** her – den må ligge utenfor auth og monteres før
 * `/api` i `index.ts`, akkurat som GitHub-webhooken.
 */
api.route("/billing", billing);

/**
 * Bekrefter at en GitHub-installasjon faktisk tilhører kalleren.
 *
 * ID-en kommer utenfra, og fram til nå ble den skrevet rett i raden. Det er
 * verdt å merke seg hva som da skjer når den er feil: prosjektet opprettes
 * uten innvending, og bommen dukker først opp som «Repository not found» i en
 * byggelogg minutter senere – på et tidspunkt der ingenting peker tilbake mot
 * feltet som var galt. En installasjon som tilhører en *annen* konto er verre
 * enn ubrukelig: den gir kloningen et token for repoer eieren aldri har delt
 * med oss.
 *
 * Sjekken er et oppslag i `github_installations`, som er tabellen
 * installasjonsflyten skriver til. Er ID-en ikke der, har brukeren ikke koblet
 * til den kontoen ennå, og feilmeldingen sier hvor det gjøres.
 *
 * `undefined` betyr «feltet var ikke med» og skal ikke røre noe. `null` betyr
 * «fjern koblingen», som er lovlig – offentlige repoer klones uten token.
 */
async function verifiedInstallationId(
  userId: string,
  value: unknown,
): Promise<number | null> {
  if (value === null) return null;

  const installationId = Number(value);

  if (!Number.isSafeInteger(installationId) || installationId <= 0) {
    throw new HTTPException(400, {
      message:
        "«githubInstallationId» må være et positivt heltall, eller null for å fjerne koblingen.",
    });
  }

  const { data, error } = await supabase
    .from("github_installations")
    .select("installation_id")
    .eq("user_id", userId)
    .eq("installation_id", installationId)
    .maybeSingle();

  if (error) throw new HTTPException(500, { message: `Databasefeil: ${error.message}` });

  if (!data) {
    throw new HTTPException(400, {
      message:
        `Installasjon ${installationId} er ikke koblet til denne kontoen. ` +
        "Hent gyldige ID-er fra GET /api/github/status, eller kjør " +
        "installasjonsflyten på «installUrl» derfra for å gi Snoat tilgang til repoet.",
    });
  }

  return installationId;
}

/**
 * Oppretter et prosjekt.
 *
 * Dashboardet trenger ikke dette – det skriver raden rett i Supabase med sin
 * egen sesjon og RLS. Endepunktet finnes for **integrasjoner**: LeadLab har
 * ingen nettleser og ingen brukersesjon å skrive med, men skal likevel kunne
 * opprette en kundeside hos oss. Se `middleware/auth.ts` for API-nøkkelen.
 *
 * ⚠️ Merk at plangrensene *ikke* håndheves her, like lite som for dashboardet.
 * Et prosjekt uten deployment koster ingenting; det er `startDeployment()` som
 * sperrer, og den sperrer likt uansett hvem som ba om bygget.
 */
api.post("/projects", async (c) => {
  const body = await c.req.json<{
    name?: unknown;
    repoUrl?: unknown;
    externalRef?: unknown;
    githubInstallationId?: unknown;
    buildCommand?: unknown;
    envVars?: unknown;
    staticOutputDir?: unknown;
    staticSpaFallback?: unknown;
  }>().catch(() => null);

  if (!body) throw new HTTPException(400, { message: "Kroppen må være gyldig JSON" });

  const name = typeof body.name === "string" ? body.name.trim().toLowerCase() : "";
  const repoUrl = typeof body.repoUrl === "string" ? body.repoUrl.trim() : "";

  // Samme regex som check-constrainten i databasen. Vi gjentar den her for å
  // kunne svare 400 med en forklaring, i stedet for å la Postgres svare 500 med
  // navnet på en constraint kalleren aldri har hørt om. `name` er subdomenet.
  if (!/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(name)) {
    throw new HTTPException(400, {
      message:
        "«name» må være en gyldig subdomene-slug: små bokstaver, tall og bindestrek, " +
        "1–63 tegn, og kan ikke begynne eller slutte med bindestrek.",
    });
  }

  try {
    assertSafeRepoUrl(repoUrl);
  } catch {
    throw new HTTPException(400, { message: `Ugyldig repository-URL: «${repoUrl}»` });
  }

  const userId = c.get("userId");
  const externalRef =
    typeof body.externalRef === "string" && body.externalRef.trim()
      ? body.externalRef.trim()
      : null;

  // Idempotens. Et nettverksbrudd etter at raden ble skrevet, men før svaret
  // kom fram, gjør at kalleren prøver igjen – og uten dette ville kunden fått
  // to prosjekter. Vi svarer 200 (ikke 201) med den eksisterende raden, slik at
  // kalleren kan se forskjell på «jeg lagde den nå» og «den fantes».
  if (externalRef) {
    const { data: existing, error } = await supabase
      .from("projects")
      .select("*")
      .eq("user_id", userId)
      .eq("external_ref", externalRef)
      .maybeSingle();

    if (error) throw new HTTPException(500, { message: `Databasefeil: ${error.message}` });
    if (existing) return c.json({ project: existing, created: false }, 200);
  }

  // Verifiseres før raden skrives. Se `verifiedInstallationId()` for hvorfor det
  // er bedre å svare 400 nå enn å la kloningen feile om et kvarter.
  const installationId =
    body.githubInstallationId === undefined
      ? null
      : await verifiedInstallationId(userId, body.githubInstallationId);

  const insert = {
    user_id: userId,
    name,
    repo_url: repoUrl,
    external_ref: externalRef,
    build_command: typeof body.buildCommand === "string" ? body.buildCommand : null,
    env_vars:
      body.envVars && typeof body.envVars === "object" && !Array.isArray(body.envVars)
        ? (body.envVars as Record<string, string>)
        : {},
    static_output_dir:
      typeof body.staticOutputDir === "string" && body.staticOutputDir.trim()
        ? body.staticOutputDir.trim()
        : null,
    static_spa_fallback: body.staticSpaFallback === true,
    // Uten denne kan repoet ikke være privat: kloningen har da ingen
    // installasjon å be om et token fra. Se `authenticatedCloneUrl()`.
    github_installation_id: installationId,
    // Prosjektet arver kontoens plan. `resourcesFor()` foretrekker prosjektets
    // egen plan framfor kontoens, så uten dette ville en byråkonto fått
    // gratisplanens 256 MB på hver container den startet.
    plan: (await entitlementFor(userId)).plan,
  };

  const { data, error } = await supabase.from("projects").insert(insert).select("*").single();

  if (error) {
    // 23505 = unique_violation. To indekser kan treffe: (user_id, name) og
    // (user_id, external_ref). Begge betyr «dette finnes allerede», som er en
    // konflikt kalleren kan handle på – ikke en serverfeil.
    if (error.code === "23505") {
      throw new HTTPException(409, {
        message: `Du har allerede et prosjekt som heter «${name}».`,
      });
    }
    throw new HTTPException(500, { message: `Kunne ikke opprette prosjektet: ${error.message}` });
  }

  logger.info({ userId, project: name, externalRef, via: c.get("authKind") }, "Prosjekt opprettet");

  return c.json({ project: data, created: true }, 201);
});

/**
 * Sletter et prosjekt, og rydder opp etter det.
 *
 * Dashboardet har historisk slettet raden direkte via Supabase, og det er en
 * felle: containerne og Caddy-ruten blir stående igjen, og uten raden finnes
 * ikke lenger prosjekt-ID-en `no.snoat.project-id`-labelen peker på. Da må de
 * ryddes for hånd, av noen som først må finne ut at de er der.
 *
 * Rekkefølgen er derfor: riv ned først, slett raden etterpå. Feiler nedrivingen,
 * beholder vi raden – et prosjekt vi fortsatt kan finne igjen er langt bedre enn
 * en foreldreløs container.
 */
api.delete("/projects/:projectId", async (c) => {
  const project = await loadOwnedProject(c, c.req.param("projectId"));

  if (deploy.isDeploying(project.id)) {
    throw new HTTPException(409, {
      message: "Prosjektet bygges akkurat nå. Vent til bygget er ferdig før du sletter det.",
      cause: { code: "deploy.building_now" } satisfies ErrorDetail,
    });
  }

  // `markStopped: false` – vi skal ikke skrive `stopped_at` på en rad som er i
  // ferd med å forsvinne. Det ville bare vært en ekstra skriving som kan feile.
  await deploy.teardownProject(project, false);

  const { error } = await supabase.from("projects").delete().eq("id", project.id);

  if (error) {
    throw new HTTPException(500, {
      message:
        `Applikasjonen er tatt ned, men prosjektraden kunne ikke slettes: ${error.message}. ` +
        `Prøv igjen – nedrivingen er idempotent.`,
    });
  }

  // Statistikken slår opp prosjekt på vertsnavn i en cachet tabell. Uten dette
  // ville treff mot det slettede subdomenet fortsatt blitt tilskrevet raden som
  // ikke lenger finnes.
  invalidateHostMap();

  logger.info({ project: project.name, via: c.get("authKind") }, "Prosjekt slettet");

  return c.json({ deleted: true });
});

/**
 * Starter en deployment.
 *
 * Svarer 202 så snart deployment-raden finnes. Selve byggingen kjører videre i
 * bakgrunnen, og dashboardet følger den via Supabase Realtime på `deployments`
 * – ikke ved å polle dette endepunktet.
 */
api.post("/projects/:projectId/deploy", async (c) => {
  const project = await loadOwnedProject(c, c.req.param("projectId"));

  try {
    const deployment = await deploy.startDeployment(project);
    return c.json({ deployment }, 202);
  } catch (error) {
    if (error instanceof DeployError) {
      // En plangrense er ikke en konflikt – ingenting endrer seg om kunden
      // prøver igjen om et minutt. 402 sier det den skal si: dette koster penger.
      // Dashboardet skiller på koden for å vise «Oppgrader»-knappen.
      //
      // `cause` bærer feilkoden videre til `app.onError`, som legger den i
      // JSON-svaret. `message` er norsk og går i loggen; det er koden dashboardet
      // oversetter. Uten dette ville en engelsk bruker fått norsk feiltekst.
      throw new HTTPException(error.step === "plan" ? 402 : 409, {
        message: error.message,
        cause: error.detail ?? undefined,
      });
    }
    throw error;
  }
});

/** Stopper applikasjonen og fjerner ruten, uten å slette prosjektet. */
api.post("/projects/:projectId/stop", async (c) => {
  const project = await loadOwnedProject(c, c.req.param("projectId"));

  if (deploy.isDeploying(project.id)) {
    throw new HTTPException(409, {
      message: "Prosjektet bygges akkurat nå",
      cause: { code: "deploy.building_now" } satisfies ErrorDetail,
    });
  }

  await deploy.teardownProject(project);
  return c.json({ stopped: true });
});

/**
 * Oppdaterer eller fjerner eget domene for et prosjekt.
 * 
 * Verifiserer at domenet er unikt. Er applikasjonen i live, byttes Caddy-ruten
 * umiddelbart slik at domenet fungerer uten en ny deployment.
 */
api.patch("/projects/:projectId/domain", async (c) => {
  const project = await loadOwnedProject(c, c.req.param("projectId"));
  const { custom_domain } = await c.req.json<{ custom_domain: string | null }>();

  // Normaliser domenet
  const normalized = custom_domain ? custom_domain.trim().toLowerCase() : null;

  if (normalized) {
    const { count, error: countError } = await supabase
      .from("projects")
      .select("id", { count: "exact", head: true })
      .eq("custom_domain", normalized)
      .neq("id", project.id);
      
    if (countError) {
      throw new HTTPException(500, { message: "Kunne ikke verifisere domene: " + countError.message });
    }
    
    if (count && count > 0) {
      throw new HTTPException(409, { message: "Domenet er allerede i bruk av et annet prosjekt" });
    }
  }

  const { error } = await supabase
    .from("projects")
    .update({ custom_domain: normalized })
    .eq("id", project.id);
  
  if (error) throw new HTTPException(500, { message: error.message });

  // Statistikken kobler treff til prosjekt via vertsnavnet, så et nytt eget
  // domene må være kjent for ingesten før den første besøkende kommer.
  invalidateHostMap();

  // Skriv ruten på nytt med det nye vertsnavnet. `ensureProjectRoute` oppretter
  // ruten hvis den mangler – tidligere ble den bare *endret* når den allerede
  // fantes, og et prosjekt uten rute i Caddy fikk dermed lagret domenet i
  // databasen uten at noe pekte dit. TLS-sjekken leser databasen og sa ja, så
  // kunden fikk et gyldig sertifikat for et domene som svarte «ingen applikasjon
  // er rutet til dette domenet».
  //
  // Feiler den, skal svaret si det. Databasen er oppdatert, så neste deployment
  // eller backend-oppstart retter det opp – men kunden skal ikke få vite at
  // domenet virker når det ikke gjør det.
  let route: RouteStatus;
  try {
    route = await ensureProjectRoute({ ...project, custom_domain: normalized });
  } catch (err) {
    logger.error({ project: project.name, err }, "Kunne ikke oppdatere Caddy-rute med nytt domene");
    throw new HTTPException(502, {
      message: "Domenet ble lagret, men ruten kunne ikke settes opp. Prøv å deploye prosjektet på nytt.",
    });
  }

  return c.json({ success: true, custom_domain: normalized, route });
});

/**
 * Måler om det egne domenet faktisk virker: DNS, rute og sertifikat.
 *
 * Ligger på GET slik at DNS-fanen kan spørre på nytt så ofte kunden vil mens hen
 * venter på propagering. Sjekken utfører ingen endringer.
 */
api.get("/projects/:projectId/domain/status", async (c) => {
  const project = await loadOwnedProject(c, c.req.param("projectId"));

  if (!project.custom_domain) {
    throw new HTTPException(404, { message: "Prosjektet har ikke noe eget domene." });
  }

  return c.json(await checkDomain(project, project.custom_domain));
});

/** Status og logger for én deployment. Dashboardet bruker Realtime i stedet. */
api.get("/deployments/:deploymentId", async (c) => {
  const { data, error } = await supabase
    .from("deployments")
    .select("*, projects(user_id)")
    .eq("id", c.req.param("deploymentId"))
    .maybeSingle();

  if (error) throw new HTTPException(500, { message: error.message });

  const row = data as (Deployment & { projects: { user_id: string } | null }) | null;

  if (!row || row.projects?.user_id !== c.get("userId")) {
    throw new HTTPException(404, { message: "Deploymenten finnes ikke" });
  }

  const { projects, ...deployment } = row;
  return c.json({ deployment });
});

/**
 * All trafikkstatistikk for ett prosjekt, i ett kall.
 *
 * Tidligere var dette tre endepunkter mot Umami. Dashboardet poller hvert
 * halvminutt, så tre ruter ble til tre spørringer per fane per intervall – nå
 * er det én, og den leser ferdig aggregerte rader.
 *
 * Tallene samles inn fra Caddys access-logg (`services/analytics-ingest.ts`).
 * Det er derfor ingenting å konfigurere per prosjekt, og ingen sporingskode i
 * kundens applikasjon.
 */
api.get("/projects/:projectId/analytics", async (c) => {
  const project = await loadOwnedProject(c, c.req.param("projectId"));

  // Tolkes og klamres i servicelaget: vinduet kommer fra nettleseren, og et
  // tiårsvindu i timesoppløsning er en tung aggregering i en delt database.
  const range = analytics.parseRange(c.req.query("from"), c.req.query("to"), c.req.query("unit"));

  return c.json(await analytics.getProjectSummary(project, range));
});

/**
 * Henter alle prosjekter for den innloggede brukeren.
 * Brukes av integrasjoner som MCP-serveren.
 */
api.get("/projects", async (c) => {
  const userId = c.get("userId");

  const { data, error } = await supabase
    .from("projects")
    .select("*, deployments(id, status, created_at, url)")
    .eq("user_id", userId)
    .order("created_at", { ascending: false });

  if (error) {
    throw new HTTPException(500, { message: `Kunne ikke hente prosjekter: ${error.message}` });
  }

  // Normaliser siste deployment per prosjekt
  const projects = (data || []).map((p: any) => {
    const sortedDeployments = Array.isArray(p.deployments)
      ? p.deployments.sort((a: any, b: any) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
      : [];
    const latestDeployment = sortedDeployments[0] || null;
    return {
      ...p,
      deployments: undefined,
      latest_deployment: latestDeployment,
    };
  });

  return c.json({ projects });
});

/**
 * Henter enkeltdetaljer for et prosjekt eiet av brukeren.
 */
api.get("/projects/:projectId", async (c) => {
  const project = await loadOwnedProject(c, c.req.param("projectId"));

  const { data: latestDeployment } = await supabase
    .from("deployments")
    .select("id, status, created_at, commit_hash, url")
    .eq("project_id", project.id)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  return c.json({
    project,
    latest_deployment: latestDeployment || null,
  });
});

/**
 * Henter nylige deployments for et prosjekt.
 */
api.get("/projects/:projectId/deployments", async (c) => {
  const project = await loadOwnedProject(c, c.req.param("projectId"));

  const { data, error } = await supabase
    .from("deployments")
    .select("*")
    .eq("project_id", project.id)
    .order("created_at", { ascending: false })
    .limit(20);

  if (error) {
    throw new HTTPException(500, { message: `Kunne ikke hente deployments: ${error.message}` });
  }

  return c.json({ deployments: data || [] });
});

/**
 * Oppdaterer konfigurasjon på et eksisterende prosjekt (byggekommando, env_vars, etc.).
 */
api.patch("/projects/:projectId", async (c) => {
  const project = await loadOwnedProject(c, c.req.param("projectId"));

  const body = await c.req.json<{
    buildCommand?: unknown;
    envVars?: unknown;
    staticOutputDir?: unknown;
    staticSpaFallback?: unknown;
    githubInstallationId?: unknown;
  }>().catch(() => null);

  if (!body) throw new HTTPException(400, { message: "Kroppen må være gyldig JSON" });

  const updates: Record<string, any> = {};

  // Uten dette feltet var en feil installasjon bare reparerbar ved å slette
  // prosjektet og opprette det på nytt – med nytt subdomene, ny historikk og
  // tapte miljøvariabler. Koblingen er konfigurasjon, og skal kunne rettes som
  // konfigurasjon.
  if (body.githubInstallationId !== undefined) {
    updates.github_installation_id = await verifiedInstallationId(
      c.get("userId"),
      body.githubInstallationId,
    );
  }

  if (body.buildCommand !== undefined) {
    updates.build_command = typeof body.buildCommand === "string" ? body.buildCommand : null;
  }
  if (body.envVars !== undefined && typeof body.envVars === "object" && !Array.isArray(body.envVars)) {
    updates.env_vars = body.envVars;
  }
  if (body.staticOutputDir !== undefined) {
    updates.static_output_dir = typeof body.staticOutputDir === "string" && body.staticOutputDir.trim()
      ? body.staticOutputDir.trim()
      : null;
  }
  if (body.staticSpaFallback !== undefined) {
    updates.static_spa_fallback = body.staticSpaFallback === true;
  }

  if (Object.keys(updates).length === 0) {
    return c.json({ project });
  }

  const { data, error } = await supabase
    .from("projects")
    .update(updates)
    .eq("id", project.id)
    .select("*")
    .single();

  return c.json({ project: data });
});

/**
 * Henter liste over aktive API-nøkler for innlogget bruker.
 */
api.get("/api-keys", async (c) => {
  const userId = c.get("userId");

  const { data, error } = await supabase
    .from("api_keys")
    .select("id, name, token_prefix, created_at, last_used_at, revoked_at")
    .eq("user_id", userId)
    .is("revoked_at", null)
    .order("created_at", { ascending: false });

  if (error) {
    throw new HTTPException(500, { message: `Kunne ikke hente API-nøkler: ${error.message}` });
  }

  return c.json({ keys: data || [] });
});

/**
 * Utsteder en ny API-nøkkel for innlogget bruker (f.eks. for Snoat MCP Server).
 */
api.post("/api-keys", async (c) => {
  const userId = c.get("userId");
  const body = await c.req.json<{ name?: string }>().catch(() => ({ name: "Snoat MCP Server" }));

  const name = typeof body.name === "string" && body.name.trim() ? body.name.trim() : "Snoat MCP Server";
  const key = generateApiKey();

  const { data, error } = await supabase
    .from("api_keys")
    .insert({
      user_id: userId,
      name,
      token_prefix: key.tokenPrefix,
      token_hash: key.tokenHash,
    })
    .select("id, name, token_prefix, created_at")
    .single();

  if (error) {
    throw new HTTPException(500, { message: `Kunne ikke opprette API-nøkkel: ${error.message}` });
  }

  logger.info({ userId, keyName: name }, "Ny API-nøkkel utstedt fra dashboardet");

  // Nøkkelen (token) returneres i klartekst kun i dette ene svaret
  return c.json({
    key: data,
    token: key.token,
  }, 201);
});

/**
 * MCP-klientene som har tilgang til kontoen akkurat nå.
 *
 * Ligger på `/mcp-connections` og ikke under `/mcp/…`: sistnevnte er montert som
 * en egen app i `index.ts`, foran denne, og hadde svart på stien i stedet.
 *
 * Bare sesjoner får se dette. En connector skal ikke kunne kartlegge de andre
 * connectorene på kontoen – eller koble dem fra – og `authKind` er det som
 * skiller et menneske i dashboardet fra en integrasjon.
 */
api.get("/mcp-connections", async (c) => {
  if (c.get("authKind") !== "session") {
    throw new HTTPException(403, {
      message: "Bare en innlogget bruker kan se tilkoblingene på kontoen.",
    });
  }

  return c.json({ connections: await listConnections(c.get("userId")) });
});

/**
 * Kobler fra en MCP-klient.
 *
 * Trekker tilbake alle tokens klienten har på denne kontoen, både access og
 * refresh. Klienten mister tilgangen ved neste kall, og må gjennom samtykke på
 * nytt for å få den tilbake.
 */
api.delete("/mcp-connections/:clientId", async (c) => {
  if (c.get("authKind") !== "session") {
    throw new HTTPException(403, {
      message: "Bare en innlogget bruker kan koble fra en MCP-klient.",
    });
  }

  const userId = c.get("userId");
  const clientId = c.req.param("clientId");

  // `revokeClientTokens` filtrerer på user_id, så en fremmed client_id treffer
  // ingenting i stedet for å røre en annen konto.
  await revokeClientTokens(userId, clientId);

  logger.info({ userId, clientId }, "MCP-tilkobling koblet fra");

  return c.json({ success: true });
});

/**
 * Trekker tilbake en API-nøkkel.
 */
api.delete("/api-keys/:keyId", async (c) => {
  const userId = c.get("userId");
  const keyId = c.req.param("keyId");

  const { error } = await supabase
    .from("api_keys")
    .update({ revoked_at: new Date().toISOString() })
    .eq("id", keyId)
    .eq("user_id", userId);

  if (error) {
    throw new HTTPException(500, { message: `Kunne ikke trekke tilbake API-nøkkel: ${error.message}` });
  }

  return c.json({ success: true });
});



