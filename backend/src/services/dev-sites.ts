import { randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";
import { accessVersion } from "../lib/access-cookie.js";
import { logger } from "../lib/logger.js";
import { supabase } from "../lib/supabase.js";
import * as caddy from "../lib/caddy.js";
import { DeployError, type Project } from "../types.js";
import { assertSafeBranch } from "./git.js";

/**
 * Dev-sider og passordbeskyttelse.
 *
 * En dev-side er ikke et nytt slags objekt: det er en ordinær prosjektrad på
 * samme repo, med en annen `branch`, sitt eget vertsnavn og `parent_project_id`
 * satt. Begrunnelsen står i migrasjon 0013 – kort fortalt slår `tls-ask`,
 * Caddy-rutene, analytics-hostmapet og plangrensene alle opp på `projects.name`,
 * og de virker uendret for en rad som ser ut som alle andre.
 *
 * Konsekvensen er verdt å merke seg: push-webhooken trengte **ingen** endring.
 * Den henter alle prosjekter på repoet og spør per rad om grenen stemmer, så en
 * push til `dev` bygger bare dev-siden og en push til `main` bare hovedsiden.
 */

/** Kostnaden på bcrypt-hashen. */
const BCRYPT_COST = 12;

/**
 * Hvor lang tid en cost-12-hash tar er hele hensikten: ~250 ms gjør et
 * ordbokangrep på en lekket hash upraktisk. Caddy verifiserer med `hash_cache`
 * slått på, så prisen betales én gang per passord og ikke per forespørsel.
 */
const MIN_PASSWORD_LENGTH = 8;

/** Navnet dev-siden får, avledet fra prosjektet den hører til. */
export function devSiteName(parentName: string, branch: string): string {
  // Grennavn kan inneholde `/` («feature/ny-meny») og punktum, som ikke kan stå
  // i et vertsnavn. Slugen bygges derfor av grenen, ikke kopieres fra den.
  const branchSlug = branch
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  // Taket er 63 tegn (én DNS-etikett), og prosjektnavnet skal aldri kuttes bort
  // til fordel for grennavnet: det er prosjektet man leter etter i en URL.
  return `${parentName}-${branchSlug}`.slice(0, 63).replace(/-+$/, "");
}

/**
 * Oppretter en dev-side for et prosjekt.
 *
 * Kaster `DeployError` med steg `dev_site` på alt kunden kan rette selv, slik at
 * `routes/api.ts` kan oversette det til en 409 med en kode dashboardet forstår.
 *
 * ## Hva som *ikke* arves
 *
 * `custom_domain` settes aldri. Et eget domene peker på produksjonen, og en
 * dev-side som svarte på det ville vært verre enn ingen dev-side. Av samme grunn
 * arves ikke `external_ref` – den er unik per bruker.
 *
 * ## Hva som arves
 *
 * Repo, GitHub-installasjon, byggekommando, statiske innstillinger, plan og
 * miljøvariabler. Miljøvariablene er det viktigste: en dev-side uten dem bygger
 * ikke, og å kreve at kunden limer dem inn på nytt ville gjort funksjonen til
 * noe man setter opp én gang og aldri vedlikeholder. De er en **kopi**, ikke en
 * referanse: dev-siden skal kunne peke på en testdatabase uten at produksjonen
 * gjør det.
 */
export async function createDevSite(
  parent: Project,
  branch: string,
  password: string,
): Promise<Project> {
  if (parent.parent_project_id) {
    throw new DeployError("dev_site", "En dev-side kan ikke ha egne dev-sider", {
      code: "dev_site.parent_is_dev_site",
    });
  }

  // Samme validering som `cloneRepository` gjør senere, men her rekker den å
  // stoppe raden før den skrives. Et ugyldig grennavn ville ellers blitt en
  // byggefeil flere minutter senere.
  const safeBranch = assertSafeBranch(branch);
  const hash = await hashPassword(password);
  const name = devSiteName(parent.name, safeBranch);

  const { data, error } = await supabase
    .from("projects")
    .insert({
      user_id: parent.user_id,
      parent_project_id: parent.id,
      name,
      branch: safeBranch,
      repo_url: parent.repo_url,
      github_installation_id: parent.github_installation_id,
      build_command: parent.build_command,
      env_vars: parent.env_vars ?? {},
      static_output_dir: parent.static_output_dir,
      static_spa_fallback: parent.static_spa_fallback,
      plan: parent.plan,
      access_protected: true,
    })
    .select("*")
    .single();

  if (error || !data) {
    // 23505 = unique_violation. Den ene feilen kunden kan gjøre noe med: en
    // dev-side for denne grenen finnes allerede.
    if (error?.code === "23505") {
      throw new DeployError("dev_site", `Det finnes allerede en dev-side kalt «${name}»`, {
        code: "dev_site.already_exists",
        params: { name },
      });
    }
    throw new DeployError("dev_site", `Kunne ikke opprette dev-siden: ${error?.message}`);
  }

  const devSite = data as Project;

  // Hashen skrives *etter* prosjektraden, fordi fremmednøkkelen krever at raden
  // finnes. Feiler dette, står vi med en dev-side som sier at den er beskyttet
  // uten å ha et passord – og da er det riktige å rulle tilbake hele
  // opprettelsen framfor å publisere en åpen dev-side.
  const { error: hashError } = await supabase
    .from("project_access")
    .upsert({ project_id: devSite.id, password_hash: hash, updated_at: new Date().toISOString() });

  if (hashError) {
    await supabase.from("projects").delete().eq("id", devSite.id);
    throw new DeployError("dev_site", `Kunne ikke lagre passordet: ${hashError.message}`);
  }

  logger.info(
    { project: parent.name, devSite: devSite.name, branch: safeBranch },
    "Dev-side opprettet",
  );

  return devSite;
}

/**
 * Setter eller fjerner passordet foran en app.
 *
 * `null` fjerner beskyttelsen. Caddy-ruten skrives om med én gang, ikke ved
 * neste deployment: en kunde som fjerner passordet forventer at siden er åpen nå,
 * og en som setter det forventer at den er stengt nå.
 *
 * Rekkefølgen er bevisst: databasen først, så Caddy. Feiler Caddy-skrivingen,
 * står vi med en rute som er mer åpen enn databasen sier – men neste deployment
 * eller `reconcileRoutes()` retter det opp, fordi de leser hashen fra databasen.
 * Motsatt rekkefølge ville gitt en rute ingen kjenner passordet til.
 */
export async function setAccessPassword(
  project: Project,
  password: string | null,
): Promise<void> {
  if (project.access_protected && password === null) {
    const { error } = await supabase.from("project_access").delete().eq("project_id", project.id);
    if (error) {
      throw new DeployError("dev_site", `Kunne ikke fjerne passordet: ${error.message}`);
    }
  } else if (password !== null) {
    const hash = await hashPassword(password);
    const { error } = await supabase
      .from("project_access")
      .upsert({ project_id: project.id, password_hash: hash, updated_at: new Date().toISOString() });
    if (error) {
      throw new DeployError("dev_site", `Kunne ikke lagre passordet: ${error.message}`);
    }
  }

  const { error: flagError } = await supabase
    .from("projects")
    .update({ access_protected: password !== null })
    .eq("id", project.id);

  if (flagError) {
    throw new DeployError("dev_site", `Kunne ikke oppdatere prosjektet: ${flagError.message}`);
  }

  await refreshRoute({ ...project, access_protected: password !== null });
}

/**
 * Skriver Caddy-ruten på nytt med gjeldende beskyttelse.
 *
 * Gjøres bare når det *finnes* en rute å endre. Et prosjekt som aldri er
 * deployet har ingen, og å opprette en her ville pekt på en upstream som ikke
 * finnes.
 */
export async function refreshRoute(project: Project): Promise<void> {
  try {
    const existing = await caddy.getAppRoute(project.name);
    if (!existing) return;

    const guard = project.access_protected ? await accessGuardFor(project.id) : null;
    const aliases = await aliasHostnamesFor(project);

    // ⚠️ `routeUpstream()`/`routeRoot()` så tidligere bare på `handle[0]`, som
    // er passordvakten på en beskyttet app. Begge svarte da null, ingen av
    // grenene ble tatt, og «fjern passord» skrev aldri noe til Caddy: appen ble
    // stående låst mens dashboardet sa at den var åpen.
    const upstream = caddy.routeUpstream(existing);
    const root = caddy.routeRoot(existing);

    if (upstream) {
      await caddy.upsertAppRoute(project.name, project.custom_domain, upstream, guard, aliases);
    } else if (root) {
      await caddy.upsertStaticRoute(
        project.name,
        project.custom_domain,
        root,
        project.static_spa_fallback,
        guard,
        aliases,
      );
    }
  } catch (error) {
    // Ruten er ikke source of truth – databasen er. En feil her retter seg selv
    // ved neste deployment eller reconcile, og skal ikke gjøre at kunden tror
    // passordet ikke ble lagret.
    logger.warn(
      { project: project.name, err: error },
      "Kunne ikke oppdatere Caddy-ruten med ny passordbeskyttelse",
    );
  }
}

/**
 * bcrypt-hashen for et prosjekt, eller null om den mangler eller ikke kunne
 * leses.
 *
 * Ligger her fordi dette er det eneste stedet i koden som leser
 * `project_access`. Brukes av innloggingen på passordsiden
 * (`routes/access-gate.ts`) og av `accessGuardFor()`, som gjør en null om til
 * en vakt ingen kommer forbi – ikke til en åpen app.
 */
export async function passwordHashFor(projectId: string): Promise<string | null> {
  const { data, error } = await supabase
    .from("project_access")
    .select("password_hash")
    .eq("project_id", projectId)
    .maybeSingle();

  if (error) {
    logger.error({ projectId, err: error }, "Kunne ikke lese passord-hashen");
    return null;
  }

  return (data as { password_hash: string } | null)?.password_hash ?? null;
}

/**
 * Vertsnavnene et prosjekt svarer på i tillegg til `<navn>.snoat.com`.
 *
 * For et hovedprosjekt: ingen. For en dev-side: `<gren>.<hovedprosjekt>`, slik
 * at adressen sier hva den er uten at man må kunne navnekonvensjonen. Se
 * `caddy.devAliasHostname()` for hvorfor den kommer i tillegg og ikke i stedet.
 *
 * Feiler oppslaget av forelderen, svarer vi tomt framfor å velte deploymenten:
 * `<navn>.snoat.com` virker uansett, og en dev-side uten pen adresse er bedre
 * enn ingen dev-side.
 */
export async function aliasHostnamesFor(project: Project): Promise<string[]> {
  // `extra_domains` (migrasjon 0023) kommer etter dev-aliaset, slik at
  // `publicUrlFor()` fortsatt viser den pene dev-adressen først.
  const extra = (project.extra_domains ?? []).map((domain) => domain.toLowerCase());
  const devAlias = await devAliasFor(project);
  return [...new Set([...(devAlias ? [devAlias] : []), ...extra])];
}

async function devAliasFor(project: Project): Promise<string | null> {
  if (!project.parent_project_id || !project.branch) return null;

  const { data, error } = await supabase
    .from("projects")
    .select("name")
    .eq("id", project.parent_project_id)
    .maybeSingle();

  if (error || !data) {
    logger.warn({ project: project.name, err: error }, "Fant ikke hovedprosjektet til dev-siden");
    return null;
  }

  return caddy.devAliasHostname((data as { name: string }).name, project.branch);
}

/**
 * Adressen vi viser og lagrer på deploymenten.
 *
 * Dev-siden har to som virker; den pene er den kunden skal få se, og den som
 * skal stå i `deployments.url` slik at dashboardet ikke trenger å kjenne
 * navnekonvensjonen for å lenke riktig.
 */
export function publicUrlFor(project: Project, aliasHosts: string[]): string {
  // Bare dev-aliaset: `extra_domains` er kundens domener, og deployment-URL-en
  // skal ikke bytte til et av dem bare fordi de ble lagt til.
  const extra = new Set((project.extra_domains ?? []).map((domain) => domain.toLowerCase()));
  const alias = project.parent_project_id ? aliasHosts.find((host) => !extra.has(host)) : undefined;
  return alias ? caddy.hostnameUrl(alias) : caddy.appUrl(project.name);
}

/** Dev-sidene som hører til et prosjekt. */
export async function listDevSites(parentId: string): Promise<Project[]> {
  const { data, error } = await supabase
    .from("projects")
    .select("*")
    .eq("parent_project_id", parentId)
    .order("created_at", { ascending: true });

  if (error) {
    logger.warn({ parentId, err: error }, "Kunne ikke hente dev-sidene");
    return [];
  }

  return (data ?? []) as Project[];
}

async function hashPassword(password: string): Promise<string> {
  const value = password.trim();

  if (value.length < MIN_PASSWORD_LENGTH) {
    throw new DeployError(
      "dev_site",
      `Passordet må være minst ${MIN_PASSWORD_LENGTH} tegn`,
      { code: "dev_site.password_too_short", params: { min: MIN_PASSWORD_LENGTH } },
    );
  }

  return await bcrypt.hash(value, BCRYPT_COST);
}

// ── Delelenker (migrasjon 0023) ─────────────────────────────────────────────
//
// En beskyttet app kan deles med en lenke som slipper forbi passordet til den
// utløper. Tokenet står i Caddy-ruten (se `caddy.guardedHandlers()`), så hver
// endring skriver ruten på nytt med `refreshRoute()`.

/** Korteste og lengste levetid en delelenke kan få. */
export const SHARE_MIN_MINUTES = 5;
export const SHARE_MAX_MINUTES = 30 * 24 * 60;

export interface ShareLink {
  id: string;
  url: string;
  expiresAt: string;
  createdAt: string;
}

/**
 * Passordvakten for et prosjekt: prosjekt-ID, passordversjonen og de aktive
 * delelenkene. Kalles overalt en rute skrives for et prosjekt med
 * `access_protected`, slik at en ny deployment aldri mister vakten eller
 * delelenkene.
 *
 * Feiler alltid **lukket**: finnes ingen hash (raden mangler, eller oppslaget
 * feilet), får ruten likevel vakten, med en versjon ingen innlogging kan matche
 * (`accessVersion(null)`). Appen er da stengt til passordet settes på nytt eller
 * ruten skrives igjen – aldri åpen. Det går an nå som vakten ikke trenger hashen
 * i Caddy: en manglende hash velter ikke lenger deploymenten.
 *
 * Feiler oppslaget av delelenkene, svarer vi uten dem: da virker passordet som
 * før, og lenkene kommer tilbake ved neste skriving av ruten.
 */
export async function accessGuardFor(projectId: string): Promise<caddy.AccessGuard> {
  const hash = await passwordHashFor(projectId);
  const version = accessVersion(hash);
  if (!hash) {
    logger.warn({ projectId }, "Beskyttet prosjekt uten lesbar passord-hash – vakten står, men ingen kommer inn");
    return { projectId, version, shareTokens: [] };
  }

  const { data, error } = await supabase
    .from("project_share_links")
    .select("token, expires_at")
    .eq("project_id", projectId)
    .gt("expires_at", new Date().toISOString());

  if (error) {
    logger.warn({ projectId, err: error }, "Kunne ikke lese delelenkene");
    return { projectId, version, shareTokens: [] };
  }

  return {
    projectId,
    version,
    shareTokens: ((data ?? []) as Array<{ token: string; expires_at: string }>).map((row) => ({
      token: row.token,
      expiresAt: new Date(row.expires_at),
    })),
  };
}

/** Adressen en delelenke peker på: eget domene først, så dev-aliaset, så `<navn>.snoat.com`. */
async function shareBaseUrl(project: Project): Promise<string> {
  if (project.custom_domain) return caddy.hostnameUrl(project.custom_domain);
  const devAlias = await devAliasFor(project);
  return devAlias ? caddy.hostnameUrl(devAlias) : caddy.appUrl(project.name);
}

function shareUrl(base: string, token: string): string {
  return `${base}/?${caddy.SHARE_PARAM}=${token}`;
}

/**
 * Lager en delelenke som utløper om `ttlMinutes` minutter.
 *
 * Krever at appen er passordbeskyttet: på en åpen app ville lenken ikke betydd
 * noe, og kunden kunne trodd at den begrenset tilgangen.
 */
export async function createShareLink(project: Project, ttlMinutes: number): Promise<ShareLink> {
  if (!project.access_protected) {
    throw new DeployError("dev_site", "Appen er ikke passordbeskyttet, så en delelenke ville ikke begrenset noe.", {
      code: "share_link.not_protected",
    });
  }

  if (!Number.isFinite(ttlMinutes) || ttlMinutes < SHARE_MIN_MINUTES || ttlMinutes > SHARE_MAX_MINUTES) {
    throw new DeployError(
      "dev_site",
      `Levetiden må være mellom ${SHARE_MIN_MINUTES} minutter og ${SHARE_MAX_MINUTES / (24 * 60)} dager.`,
      { code: "share_link.invalid_ttl", params: { min: SHARE_MIN_MINUTES, max: SHARE_MAX_MINUTES } },
    );
  }

  const token = randomBytes(24).toString("base64url");
  const expiresAt = new Date(Date.now() + Math.round(ttlMinutes) * 60_000);

  const { data, error } = await supabase
    .from("project_share_links")
    .insert({ project_id: project.id, token, expires_at: expiresAt.toISOString() })
    .select("id, created_at, expires_at")
    .single();

  if (error || !data) {
    throw new DeployError("dev_site", `Kunne ikke lagre delelenken: ${error?.message}`);
  }

  await refreshRoute(project);

  const row = data as { id: string; created_at: string; expires_at: string };
  logger.info({ project: project.name, expiresAt: row.expires_at }, "Delelenke opprettet");

  return {
    id: row.id,
    url: shareUrl(await shareBaseUrl(project), token),
    expiresAt: row.expires_at,
    createdAt: row.created_at,
  };
}

/** De aktive delelenkene til et prosjekt, nyeste først. */
export async function listShareLinks(project: Project): Promise<ShareLink[]> {
  const { data, error } = await supabase
    .from("project_share_links")
    .select("id, token, expires_at, created_at")
    .eq("project_id", project.id)
    .gt("expires_at", new Date().toISOString())
    .order("created_at", { ascending: false });

  if (error) throw new DeployError("dev_site", `Kunne ikke hente delelenkene: ${error.message}`);

  const base = await shareBaseUrl(project);
  return ((data ?? []) as Array<{ id: string; token: string; expires_at: string; created_at: string }>).map((row) => ({
    id: row.id,
    url: shareUrl(base, row.token),
    expiresAt: row.expires_at,
    createdAt: row.created_at,
  }));
}

/** Trekker tilbake en delelenke med en gang. En som alt er borte er ikke en feil. */
export async function deleteShareLink(project: Project, linkId: string): Promise<void> {
  const { error } = await supabase
    .from("project_share_links")
    .delete()
    .eq("id", linkId)
    .eq("project_id", project.id);

  if (error) throw new DeployError("dev_site", `Kunne ikke slette delelenken: ${error.message}`);

  await refreshRoute(project);
}

/**
 * Fjerner utløpte delelenker og skriver rutene deres på nytt.
 *
 * Informasjonskapselen utløper av seg selv i nettleseren, men tokenet står i
 * Caddy-ruten til noen skriver den om. Uten sveipet ville en lenke som er
 * kopiert videre virket til neste deployment.
 */
export async function sweepExpiredShareLinks(): Promise<number> {
  const { data, error } = await supabase
    .from("project_share_links")
    .delete()
    .lte("expires_at", new Date().toISOString())
    .select("project_id");

  if (error) {
    logger.warn({ err: error }, "Kunne ikke rydde utløpte delelenker");
    return 0;
  }

  const projectIds = [...new Set(((data ?? []) as Array<{ project_id: string }>).map((row) => row.project_id))];
  if (projectIds.length === 0) return 0;

  const { data: projects } = await supabase.from("projects").select("*").in("id", projectIds);
  for (const project of (projects ?? []) as Project[]) {
    await refreshRoute(project);
  }

  logger.info({ projects: projectIds.length }, "Utløpte delelenker fjernet fra rutene");
  return projectIds.length;
}

const SHARE_SWEEP_MS = 60_000;

/** Starter sveipet. Kjøres fra `index.ts` etter at rutene er gjenopprettet. */
export function startShareLinkSweep(): void {
  const run = () => {
    void sweepExpiredShareLinks().catch((error: unknown) => {
      logger.warn({ err: error }, "Sveipet for delelenker feilet");
    });
  };
  run();
  setInterval(run, SHARE_SWEEP_MS).unref();
}
