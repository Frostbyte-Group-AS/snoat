import { config } from "../config.js";
import { logger } from "../lib/logger.js";
import { dashboardUrl } from "../lib/public-url.js";
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
    `Dashboard:   ${projectLink(project)}`,
  ]);
}

/**
 * Varsler drift om at en deployment endte som `failed`.
 *
 * ## Hvorfor hver gang, i motsetning til varselet over
 *
 * `notifyFirstDeploymentLive` varsler bevisst bare første gang et prosjekt blir
 * live, fordi «appen er live» er sant hele tiden etterpå og en e-post per push
 * ville druknet den ene som betydde noe. Et feilet bygg er det motsatte: det er
 * en hendelse med et tidspunkt, og nummer to er ikke mindre interessant enn
 * nummer én – det er ofte den som viser at forrige rettelse ikke virket.
 *
 * Det gjør varselet støyende for et prosjekt som feiler ved hver push, og det er
 * en avveining vi tar med åpne øyne: `commit`-linjen i e-posten er det som
 * skiller «samme feil på nytt» fra «en ny feil». Blir det for mye, er det
 * mottakerlista (`SNOAT_NOTIFY_TO`) som skrus av, ikke logikken her.
 *
 * ## Hvorfor ingen egen idempotens
 *
 * Kalles fra ett sted: catch-blokka i `runPipeline()`, etter at statusen er satt
 * til `failed`. Én deployment kan bare feile én gang, så det finnes ingen
 * gjentakelse å beskytte seg mot – i motsetning til sveipene, som ser samme rad
 * om og om igjen (se `helse.ts` og `signups.ts`).
 *
 * Merk at `failOrphanedDeployments()` også setter rader til `failed`, ved
 * oppstart, uten å varsle. Det er med vilje: de byggene døde fordi backend
 * restartet, ikke fordi noe var galt med koden, og en plattform-oppdatering skal
 * ikke sende en bunke e-poster om bygg ingen lenger venter på.
 */
export async function notifyDeploymentFailed(
  project: Project,
  deployment: Deployment,
  failure: { step: string; message: string },
): Promise<void> {
  if (!notificationsEnabled()) return;

  // Raden leses på nytt framfor å bruke `deployment`-objektet direkte:
  // pipelinen har skrevet `branch` og `commit_hash` til basen underveis, mens
  // objektet vi fikk er slik det så ut da det ble lagt i køen – og de lokale
  // variablene fra try-blokka finnes ikke i catch. Uten dette ville e-posten
  // manglet nettopp den commiten som skiller «samme feil igjen» fra en ny feil.
  const [owner, row] = await Promise.all([ownerEmail(project.user_id), failedRow(deployment.id)]);

  const branch = row?.branch ?? deployment.branch ?? project.branch;
  const commit = row?.commit_hash ?? deployment.commit_hash;
  const seconds = row?.duration_ms ? `${(row.duration_ms / 1000).toFixed(1)}s` : "(ukjent)";

  await send(`Snoat: bygget feilet for ${project.name}`, [
    `Prosjekt:    ${project.name}`,
    `Gren:        ${branch ?? "(repoets standardgren)"}`,
    `Commit:      ${commit ?? "(ikke nådd så langt)"}`,
    `Repository:  ${project.repo_url}`,
    `Eier:        ${owner ?? project.user_id}`,
    `Steg:        ${failure.step}`,
    `Varighet:    ${seconds}`,
    "",
    "Årsak:",
    // `message` fra `DeployError` er allerede diagnosen der en finnes:
    // `nixpacks.ts` sender byggeloggens hale gjennom `describeBuildFailure()`
    // (`services/build-diagnosis.ts`) før den kaster, så teksten under er den
    // samme forklaringen kunden ser i loggvinduet – tittel, sted og råd. Traff
    // ingen signatur, står den generelle meldingen her, og da er byggeloggen
    // fasiten.
    failure.message,
    "",
    `Deployment:  ${deployment.id}`,
    `Byggelogg:   ${projectLink(project)}`,
    "",
    "Den forrige versjonen kjører videre som før – en feilet deployment tar ikke ned appen.",
  ]);
}

/**
 * Varsler drift om at en ny bruker har registrert seg.
 *
 * Kalles av sveipet i `services/signups.ts`, som også eier idempotensen: raden i
 * `profiles` er krysset av før denne funksjonen kalles, slik at samme
 * registrering ikke kan varsles to ganger. Se den fila for hvorfor det må være
 * et sveip og ikke en webhook.
 *
 * `email` slås opp her, ikke i sveipet, av samme grunn som `ownerEmail` finnes:
 * `profiles` har ingen e-postkolonne (den bor i `auth.users`, og skal bo der),
 * og oppslaget mot Supabase Auth er allerede innkapslet her.
 */
export async function notifyNewSignup(signup: {
  userId: string;
  fullName: string | null;
  createdAt: string;
}): Promise<void> {
  if (!notificationsEnabled()) return;

  const bruker = await authUser(signup.userId);

  await send(`Ny bruker på Snoat: ${bruker?.email ?? signup.userId}`, [
    `E-post:      ${bruker?.email ?? "(ukjent – slettet før varselet rakk ut?)"}`,
    `Navn:        ${signup.fullName ?? "(ikke oppgitt)"}`,
    // Hvordan de kom inn: `email` for vanlig registrering, `github` for
    // OAuth-innloggingen. Det er det mest interessante enkeltfeltet her, fordi
    // det er det eneste tallet som sier om GitHub-innloggingen faktisk brukes.
    `Metode:      ${bruker?.provider ?? "(ukjent)"}`,
    `Bekreftet:   ${bekreftelse(bruker)}`,
    `Registrert:  ${signup.createdAt}`,
    `Bruker-ID:   ${signup.userId}`,
    "",
    `Brukere totalt: ${(await brukerantall()) ?? "(kunne ikke telles)"}`,
  ]);
}

/**
 * Varsler drift om at helsesveipet (`services/helse.ts`) fant et avvik: basen
 * påstår appen kjører, men containeren er borte fra Docker.
 *
 * ## Hvorfor bare ved overgangen, ikke ved hvert sveip
 *
 * Sveipet kjører hvert par minutter (`SNOAT_HEALTH_CHECK_INTERVAL_MS`). Uten en
 * overgangssjekk ville en app som står nede i en dag gitt flere hundre
 * identiske e-poster – nøyaktig samme grunn som `notifyFirstDeploymentLive` bare
 * varsler første gang en app blir live. `helse.ts` kaller denne kun idet
 * `container_died_at` går fra NULL til satt, aldri på et sveip som bekrefter et
 * avvik som allerede er kjent.
 */
export async function notifyContainerUnhealthy(project: Project, detail: string): Promise<void> {
  if (!notificationsEnabled()) return;

  const owner = await ownerEmail(project.user_id);

  await send(`Snoat: ${project.name} svarer ikke`, [
    `Prosjekt:  ${project.name}`,
    `Avvik:     ${detail}`,
    `Eier:      ${owner ?? project.user_id}`,
    "",
    "Basen er rettet: prosjektet vises ikke lenger som Live i dashboardet.",
    "Containeren er ikke startet på nytt av dette varselet – se CONTEXT_FOR_AI/03_deployment_flow.md.",
  ]);
}

/**
 * Varsler drift om at en app helsesveipet tidligere meldte som nede, svarer
 * igjen – enten fordi Docker sin egen `on-failure`-restart lyktes til slutt,
 * eller fordi noen rettet det manuelt uten å redeploye.
 */
export async function notifyContainerRecovered(project: Project): Promise<void> {
  if (!notificationsEnabled()) return;

  const owner = await ownerEmail(project.user_id);

  await send(`Snoat: ${project.name} svarer igjen`, [
    `Prosjekt:  ${project.name}`,
    `Eier:      ${owner ?? project.user_id}`,
    "",
    "Helsesveipet fant containeren oppe igjen, og basen er rettet tilbake til Live.",
  ]);
}

/** E-posten til eieren, for at varselet skal si hvem det gjelder. */
async function ownerEmail(userId: string): Promise<string | null> {
  return (await authUser(userId))?.email ?? null;
}

/**
 * Det vi trenger å vite om en bruker fra Supabase Auth.
 *
 * Ett oppslag, ikke ett per felt: `getUserById` er et HTTP-kall mot GoTrue, og
 * signup-varselet vil ha både e-post, innloggingsmetode og bekreftelsesstatus.
 * Returnerer `null` ved feil – et varsel uten navn er bedre enn ingen varsel.
 */
async function authUser(
  userId: string,
): Promise<{ email: string | null; provider: string | null; confirmed: boolean } | null> {
  const { data, error } = await supabase.auth.admin.getUserById(userId);

  if (error || !data.user) {
    logger.debug({ userId, err: error }, "Fant ikke brukeren til varselet");
    return null;
  }

  // `app_metadata.provider` er «email» for vanlig registrering og «github» for
  // OAuth. Typen er `unknown`-aktig i klienten, så den snevres inn her.
  const provider = data.user.app_metadata?.provider;

  return {
    email: data.user.email ?? null,
    provider: typeof provider === "string" ? provider : null,
    confirmed: Boolean(data.user.email_confirmed_at ?? data.user.confirmed_at),
  };
}

/**
 * Bekreftelsesstatusen i klartekst.
 *
 * Skiller «nei» fra «vi vet ikke»: fant vi ikke brukeren i Supabase Auth, er det
 * feil å skrive at e-posten ikke er bekreftet – da har vi ikke spurt om det.
 */
function bekreftelse(bruker: { confirmed: boolean } | null): string {
  if (bruker === null) return "(ukjent)";
  return bruker.confirmed ? "ja" : "nei – e-posten er ikke bekreftet ennå";
}

/** Hvor mange brukere plattformen har, slik varselet kan si «nummer hvor mange». */
async function brukerantall(): Promise<number | null> {
  const { count, error } = await supabase
    .from("profiles")
    .select("id", { count: "exact", head: true });

  if (error) {
    logger.debug({ err: error }, "Kunne ikke telle brukere til signup-varselet");
    return null;
  }

  return count ?? null;
}

/**
 * Lenken til prosjektet i dashboardet – der byggeloggen står.
 *
 * `dashboardUrl()` er den kanoniske originen (`lib/public-url.ts`), altså den
 * samme MCP-samtykkesiden bruker. Stien er frontendens rute
 * `/projects/$projectId`; endres den, er det denne linja som må følge etter.
 */
function projectLink(project: Project): string {
  return `${dashboardUrl()}/projects/${project.id}`;
}

/**
 * Feltene pipelinen skrev til deployment-raden underveis.
 *
 * Kaster aldri og logger kun på `debug`: dette er pynt på et varsel om at noe
 * *allerede* har feilet, og skal ikke kunne gjøre den situasjonen verre.
 */
async function failedRow(
  deploymentId: string,
): Promise<Pick<Deployment, "branch" | "commit_hash" | "duration_ms"> | null> {
  const { data, error } = await supabase
    .from("deployments")
    .select("branch, commit_hash, duration_ms")
    .eq("id", deploymentId)
    .single();

  if (error || !data) {
    logger.debug({ deploymentId, err: error }, "Kunne ikke lese deployment-raden til varselet");
    return null;
  }

  return data as Pick<Deployment, "branch" | "commit_hash" | "duration_ms">;
}
