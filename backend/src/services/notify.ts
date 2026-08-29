import { config } from "../config.js";
import { logger } from "../lib/logger.js";
import { supabase } from "../lib/supabase.js";
import type { Deployment, Project } from "../types.js";

/**
 * Utgående varsler over Resend.
 *
 * ## Hvorfor ren `fetch` og ikke `resend`-pakken
 *
 * Resend sitt API er ett POST-kall med en JSON-kropp. SDK-en tilfører en
 * avhengighet og en versjon å holde oppdatert for å spare oss for ti linjer.
 * Backend har allerede `fetch` (Node 22), og feilhåndteringen vi trenger –
 * «logg og gå videre» – er ikke den SDK-en tilbyr.
 *
 * ## Hvorfor ingenting her får kaste
 *
 * Varslene henger på deployment-pipelinen. Et varsel som feiler skal aldri
 * kunne velte et bygg som faktisk lyktes: da hadde vi byttet en tapt e-post mot
 * en tapt deploy. Alle funksjonene under svarer derfor `void` og logger selv.
 */

/** Mottakerne av interne varsler, tomt om varsling ikke er satt opp. */
function recipients(): string[] {
  return (config.SNOAT_NOTIFY_TO ?? "")
    .split(",")
    .map((address) => address.trim())
    .filter(Boolean);
}

/** Sant når både nøkkel og mottaker finnes. Begge må til for at noe sendes. */
export function notificationsEnabled(): boolean {
  return Boolean(config.RESEND_API_KEY) && recipients().length > 0;
}

async function send(subject: string, lines: string[]): Promise<void> {
  const to = recipients();

  if (!notificationsEnabled()) {
    // Ikke en advarsel. Varsling er en valgfri integrasjon, og en installasjon
    // uten Resend skal ikke fylle loggen med klager over det.
    logger.debug({ subject }, "Varsling er ikke satt opp – hopper over e-post");
    return;
  }

  const text = lines.join("\n");

  try {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ from: config.SNOAT_NOTIFY_FROM, to, subject, text }),
      // Uten dette kan et hengende kall holde en pipeline-oppgave åpen i
      // minutter. Varselet er ikke verdt å vente på.
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      logger.warn(
        { subject, status: response.status, body: await response.text().catch(() => "") },
        "Resend avviste varselet",
      );
      return;
    }

    logger.info({ subject, to: to.length }, "Varsel sendt");
  } catch (error) {
    logger.warn({ subject, err: error }, "Kunne ikke sende varsel");
  }
}

/**
 * Varsler drift om at en app er live på Snoat for første gang.
 *
 * ## Hvorfor første gang, og ikke hver deploy
 *
 * «Noen spinner opp en webapp» er en hendelse som skjer én gang per prosjekt.
 * Et varsel per deploy ville betydd én e-post per push for hver kunde med
 * auto-deploy – og da er det ingen som leser dem, heller ikke den ene som
 * betydde noe.
 *
 * ## Hvorfor vi teller deployments i stedet for å sette et flagg
 *
 * `deployments` har fasit allerede: er det nøyaktig én vellykket rad for
 * prosjektet, er det denne. Et `notified_at`-felt på `projects` ville vært en
 * migrering, og en kolonne til å holde synkron, for et spørsmål databasen kan
 * svare på selv.
 *
 * Merk at *opprettelsen* av prosjektet ikke kan varsles herfra: dashboardet
 * inserter raden direkte i Supabase gjennom RLS, uten å røre backend
 * (`CONTEXT_FOR_AI/03_deployment_flow.md`). Første vellykkede deployment er det
 * tidligste tidspunktet backend med sikkerhet vet at appen finnes – og det er
 * også det punktet der den faktisk svarer på et vertsnavn.
 */
export async function notifyFirstDeploymentLive(
  project: Project,
  deployment: Deployment,
): Promise<void> {
  if (!notificationsEnabled()) return;

  const { count, error } = await supabase
    .from("deployments")
    .select("id", { count: "exact", head: true })
    .eq("project_id", project.id)
    .eq("status", "success");

  if (error) {
    logger.warn({ project: project.name, err: error }, "Kunne ikke telle vellykkede deployments");
    return;
  }

  // Ikke `!== 1`: en race der to bygg lander samtidig skal gi null varsler for
  // mye, ikke ett. Er tellingen større enn én, har appen vært live før.
  if ((count ?? 0) > 1) return;

  const owner = await ownerEmail(project.user_id);

  await send(`Ny app live på Snoat: ${project.name}`, [
    `Prosjekt:    ${project.name}`,
    `Adresse:     ${deployment.url ?? "(ukjent)"}`,
    `Repository:  ${project.repo_url}`,
    `Gren:        ${project.branch ?? "(repoets standardgren)"}`,
    `Type:        ${project.static_output_dir ? "statisk side" : "app i container"}`,
    `Plan:        ${project.plan ?? "free"}`,
    `Eier:        ${owner ?? project.user_id}`,
    "",
    `Deployment:  ${deployment.id}`,
  ]);
}

/** E-posten til eieren, for at varselet skal si hvem det gjelder. */
async function ownerEmail(userId: string): Promise<string | null> {
  const { data, error } = await supabase.auth.admin.getUserById(userId);

  if (error || !data.user) {
    logger.debug({ userId, err: error }, "Fant ikke eierens e-post til varselet");
    return null;
  }

  return data.user.email ?? null;
}
