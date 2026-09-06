import bcrypt from "bcryptjs";
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
async function refreshRoute(project: Project): Promise<void> {
  try {
    const existing = await caddy.getAppRoute(project.name);
    if (!existing) return;

    const hash = project.access_protected ? await passwordHashFor(project.id) : null;
    const aliases = await aliasHostnamesFor(project);

    // ⚠️ `routeUpstream()`/`routeRoot()` så tidligere bare på `handle[0]`, som
    // er basic-auth-vakten på en beskyttet app. Begge svarte da null, ingen av
    // grenene ble tatt, og «fjern passord» skrev aldri noe til Caddy: appen ble
    // stående låst mens dashboardet sa at den var åpen.
    const upstream = caddy.routeUpstream(existing);
    const root = caddy.routeRoot(existing);

    if (upstream) {
      await caddy.upsertAppRoute(project.name, project.custom_domain, upstream, hash, aliases);
    } else if (root) {
      await caddy.upsertStaticRoute(
        project.name,
        project.custom_domain,
        root,
        project.static_spa_fallback,
        hash,
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
 * Hashen for et prosjekt, eller null om appen er åpen.
 *
 * Ligger her og ikke i `deploy.ts` fordi den er det eneste stedet i koden som
 * leser `project_access`. Feiler oppslaget, svarer vi null – og det er et
 * bevisst valg om hvilken feil som er minst ille: en dev-side som er åpen i noen
 * minutter er dårlig, men en dev-side som ikke kan deployes er verre, og
 * alternativet ville vært å velte bygget på en databasefeil.
 *
 * ⚠️ Skal dette snus (fail closed), må `runPipeline` også kunne feile på det.
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
  if (!project.parent_project_id || !project.branch) return [];

  const { data, error } = await supabase
    .from("projects")
    .select("name")
    .eq("id", project.parent_project_id)
    .maybeSingle();

  if (error || !data) {
    logger.warn({ project: project.name, err: error }, "Fant ikke hovedprosjektet til dev-siden");
    return [];
  }

  const alias = caddy.devAliasHostname((data as { name: string }).name, project.branch);
  return alias ? [alias] : [];
}

/**
 * Adressen vi viser og lagrer på deploymenten.
 *
 * Dev-siden har to som virker; den pene er den kunden skal få se, og den som
 * skal stå i `deployments.url` slik at dashboardet ikke trenger å kjenne
 * navnekonvensjonen for å lenke riktig.
 */
export function publicUrlFor(project: Project, aliasHosts: string[]): string {
  const alias = aliasHosts[0];
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
