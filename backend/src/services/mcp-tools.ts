import { z } from "zod";
import { repoIdentity } from "../lib/github.js";
import { redactCredentials } from "../lib/redact.js";

/**
 * Verktøykatalogen MCP-klienter ser.
 *
 * Hvert verktøy er et tynt lag over et endepunkt som allerede finnes i
 * `routes/api.ts`. Det er hele poenget med filen: en MCP-server som snakker rett
 * med databasen ville vært en andre implementasjon av eierskapssjekker,
 * plangrenser, navnevalidering og opprydding – og den andre implementasjonen er
 * den som glemmer noe. Her går kallet gjennom `requireAuth` og
 * `loadOwnedProject` på samme vei som dashboardets egne kall.
 *
 * Konsekvensen er verdt å merke seg: legges det en ny sjekk i et REST-endepunkt,
 * gjelder den automatisk for Claude også. Og en connector kan aldri gjøre noe
 * kunden ikke kunne gjort selv i dashboardet.
 */

/** Utfører et internt kall mot vårt eget API med kallerens legitimasjon. */
export interface McpToolContext {
  call(
    method: "GET" | "POST" | "PATCH" | "DELETE",
    path: string,
    body?: unknown,
  ): Promise<{ ok: boolean; status: number; data: unknown; error: string | null }>;
}

export interface McpToolResult {
  /** Kort setning modellen leser først. */
  summary: string;
  /** Rådata, som JSON. Utelates for handlinger uten interessant svar. */
  data?: unknown;
}

export interface McpTool {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /**
   * Hint til klienten om hva verktøyet gjør (MCP «tool annotations»).
   *
   * Claude bruker dem til å avgjøre hva som kan kjøres uten å spørre og hva som
   * skal bekreftes først. `readOnlyHint` er derfor ikke pynt: uten den må kunden
   * godkjenne hver enkelt visning av prosjektlisten sin.
   */
  annotations: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
  };
  run(args: unknown, ctx: McpToolContext): Promise<McpToolResult>;
  /**
   * Bare for eierkontoen (`SNOAT_OWNER_ACCOUNTS`). Skjules i `tools/list` og
   * avvises i `tools/call` for alle andre – i tillegg til at REST-endepunktet
   * bak sier 403. For en vanlig kunde finnes verktøyet ikke.
   */
  ownerOnly?: boolean;
}

// --- Maskering -------------------------------------------------------------

/**
 * Hvor mye av en hemmelighet som er trygt å vise: nok til å kjenne den igjen,
 * for lite til å bruke den.
 */
const ENV_VALUE_HINT_LENGTH = 4;

/**
 * Skjuler verdiene i `env_vars`, men beholder nøklene.
 *
 * `GET /api/projects` returnerer miljøvariablene i klartekst, og det er riktig
 * for dashboardet: kunden har allerede sett dem, og skal kunne redigere dem.
 * Gjennom MCP er situasjonen en annen – svaret havner i en modellkontekst, og
 * derfra i en samtalelogg hos en tredjepart. Én `snoat_list_projects` ville ellers
 * sendt databasepassord og API-nøkler for *alle* prosjektene på kontoen ut av
 * huset, uten at kunden ba om annet enn en oversikt.
 *
 * Nøklene beholdes fordi de er halve nytten: «hvilke variabler har dette
 * prosjektet?» er et rimelig spørsmål å stille en assistent, og
 * `snoat_update_project` kan sette en ny verdi uten å ha sett den gamle.
 */
function maskEnvVars(vars: Record<string, unknown>): Record<string, string> {
  const masked: Record<string, string> = {};

  for (const [key, value] of Object.entries(vars)) {
    const text = typeof value === "string" ? value : String(value ?? "");

    if (text.length === 0) {
      masked[key] = "(tom)";
      continue;
    }

    masked[key] =
      text.length <= ENV_VALUE_HINT_LENGTH
        ? "••• (skjult)"
        : `${text.slice(0, ENV_VALUE_HINT_LENGTH)}… ••• (skjult, ${text.length} tegn)`;
  }

  return masked;
}

/** Hvor mye byggelogg som sendes med. Nok til å se hva som feilet. */
const LOG_TAIL_LENGTH = 20_000;

/**
 * Går gjennom et API-svar og gjør det trygt og lite nok for en modellkontekst.
 *
 * To ting skjer: `env_vars` maskeres, og lange logger klippes til halen. Uten
 * klippingen kan én `snoat_get_deployment_logs` mot et feilet nix-bygg fylle hele
 * kontekstvinduet med nedlastingslinjer, og da er det ikke plass til svaret.
 */
function sanitize(value: unknown, depth = 0): unknown {
  if (depth > 8 || value === null || typeof value !== "object") return value;

  if (Array.isArray(value)) return value.map((item) => sanitize(item, depth + 1));

  const result: Record<string, unknown> = {};

  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (key === "env_vars" && child && typeof child === "object" && !Array.isArray(child)) {
      result[key] = maskEnvVars(child as Record<string, unknown>);
      continue;
    }

    if (key === "logs" && typeof child === "string") {
      const redacted = redactCredentials(child);
      result[key] =
        redacted.length > LOG_TAIL_LENGTH
          ? `… (${redacted.length - LOG_TAIL_LENGTH} tegn utelatt fra starten)\n${redacted.slice(-LOG_TAIL_LENGTH)}`
          : redacted;
      continue;
    }

    result[key] = sanitize(child, depth + 1);
  }

  return result;
}

// --- Hjelpere -------------------------------------------------------------

/**
 * Kaller API-et og kaster en lesbar feil hvis det svarte nei.
 *
 * Feilteksten fra backend er norsk og forklarer hva som gikk galt – f.eks. at
 * navnet ikke er en gyldig subdomene-slug, eller at planen er brukt opp. Den er
 * langt mer nyttig for modellen enn en statuskode, så vi sender den videre.
 */
async function callOrThrow(
  ctx: McpToolContext,
  method: "GET" | "POST" | "PATCH" | "DELETE",
  path: string,
  body?: unknown,
): Promise<unknown> {
  const response = await ctx.call(method, path, body);

  if (!response.ok) {
    throw new Error(response.error ?? `Kallet feilet med status ${response.status}`);
  }

  return sanitize(response.data);
}

/** Prosjekt-ID er alltid en uuid hos oss. */
const projectIdSchema = z.object({ projectId: z.string().min(1) });

function record<T>(value: T): Record<string, unknown> {
  return value as unknown as Record<string, unknown>;
}

// --- GitHub-tilgang ---------------------------------------------------------

interface GithubStatusResponse {
  configured?: boolean;
  installations?: Array<{ installationId: number; accountLogin: string }>;
  installUrl?: string | null;
}

interface GithubReposResponse {
  repos?: Array<{ fullName: string; installationId: number }>;
}

interface ResolvedRepoAccess {
  installationId: number | null;
  note: string;
}

/**
 * Finner installasjonen som faktisk rekker et repo, før prosjektet opprettes.
 *
 * Bakgrunnen er en feil som var lett å gå på og vanskelig å forstå:
 * `githubInstallationId` ble tatt imot som et hvilket som helst tall og skrevet
 * rett i raden. Pekte den på en installasjon som ikke rakk repoet – for
 * eksempel en organisasjons installasjon, når repoet ligger på en personlig
 * konto – ble prosjektet opprettet uten innvending, og feilen dukket først opp
 * minutter senere som `remote: Repository not found` i en byggelogg. Ingenting i
 * meldingen pekte tilbake mot feltet som var galt.
 *
 * Modellen i den andre enden hadde heller ingen vei ut. Den kunne ikke se
 * hvilke kontoer som var koblet til, ikke hvilke repoer vi rakk, og ikke hvor
 * brukeren måtte sendes for å gi tilgang – bare gjette på nye tall.
 *
 * Oppslaget veier tyngre enn parameteren kalleren sendte. Lista fra GitHub er
 * verifisert kunnskap om hva som kan klones; parameteren er i beste fall et
 * godt gjett. Blir de uenige, vinner lista, og notatet sier at vi overstyrte.
 */
async function resolveRepoAccess(
  ctx: McpToolContext,
  repoUrl: string,
  options: { explicitInstallationId?: number; allowUnverifiedRepo?: boolean },
): Promise<ResolvedRepoAccess> {
  const { explicitInstallationId, allowUnverifiedRepo } = options;
  const identity = repoIdentity(repoUrl);

  const status = (await callOrThrow(ctx, "GET", "/github/status")) as GithubStatusResponse;

  // Er App-en ikke satt opp på denne instansen, finnes det ingen liste å slå
  // opp i. Da skal vi ikke blokkere: offentlige repoer klones fint uten token.
  if (!status.configured) {
    return {
      installationId: explicitInstallationId ?? null,
      note: "GitHub-integrasjonen er ikke konfigurert på denne instansen, så tilgangen kunne ikke verifiseres. Repoet må være offentlig.",
    };
  }

  const { repos = [] } = (await callOrThrow(ctx, "GET", "/github/repos")) as GithubReposResponse;
  const match = identity ? repos.find((repo) => repoIdentity(repo.fullName) === identity) : undefined;

  if (match) {
    const overridden =
      explicitInstallationId !== undefined && explicitInstallationId !== match.installationId;

    return {
      installationId: match.installationId,
      note: overridden
        ? `Brukte installasjon ${match.installationId}, som er den som faktisk rekker ${match.fullName}. Den oppgitte ID-en ${explicitInstallationId} gjør det ikke, og ble ignorert.`
        : `Bekreftet tilgang til ${match.fullName} gjennom installasjon ${match.installationId}.`,
    };
  }

  // Herfra vet vi at Snoat ikke rekker repoet. Et offentlig repo klones likevel
  // fint, så kalleren skal kunne overstyre – men det må være et valg. Uten
  // flagget er stillhet det verste svaret vi kan gi.
  if (allowUnverifiedRepo) {
    return {
      installationId: explicitInstallationId ?? null,
      note: `Snoat har ikke tilgang til ${identity ?? repoUrl} gjennom noen tilkoblet konto. Fortsetter fordi allowUnverifiedRepo er satt – kloningen virker bare hvis repoet er offentlig.`,
    };
  }

  const accounts = (status.installations ?? []).map((row) => row.accountLogin);

  throw new Error(
    [
      `Snoat har ikke tilgang til ${identity ?? repoUrl}, så prosjektet ble ikke opprettet.`,
      accounts.length
        ? `Tilkoblede GitHub-kontoer: ${accounts.join(", ")}. Repoet er ikke blant de ${repos.length} repoene disse rekker.`
        : "Ingen GitHub-kontoer er koblet til denne Snoat-brukeren ennå.",
      status.installUrl
        ? `Slik løses det: åpne ${status.installUrl}, velg kontoen repoet ligger under, og gi Snoat tilgang. Bekreft deretter med snoat_list_github_repos.`
        : "Installasjons-URL-en er utilgjengelig – sjekk GitHub-integrasjonen i dashbordet.",
      "Er repoet offentlig, kan allowUnverifiedRepo: true brukes i stedet.",
    ].join("\n\n"),
  );
}

// --- Katalogen -----------------------------------------------------------

export const MCP_TOOLS: McpTool[] = [
  {
    name: "snoat_list_projects",
    title: "List prosjekter",
    description:
      "Henter alle prosjekter på Snoat-kontoen, med status på siste deployment. " +
      "Verdiene i env_vars er maskert; bruk snoat_get_project for detaljer om ett prosjekt.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, idempotentHint: true },
    async run(_args, ctx) {
      const data = await callOrThrow(ctx, "GET", "/projects");
      const projects = (data as { projects?: unknown[] }).projects ?? [];

      return {
        summary:
          projects.length === 0
            ? "Kontoen har ingen prosjekter ennå."
            : `Kontoen har ${projects.length} prosjekt${projects.length === 1 ? "" : "er"}.`,
        data,
      };
    },
  },

  {
    name: "snoat_get_project",
    title: "Hent prosjekt",
    description:
      "Henter detaljene for ett prosjekt: gren, byggekommando, miljøvariabelnavn, eget domene og siste deployment. " +
      "branch = null betyr at repoets standardgren bygges.",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string", description: "Prosjektets ID (uuid)." },
      },
      required: ["projectId"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, idempotentHint: true },
    async run(args, ctx) {
      const { projectId } = projectIdSchema.parse(args);
      const data = await callOrThrow(ctx, "GET", `/projects/${projectId}`);
      const name = (data as { project?: { name?: string } }).project?.name ?? projectId;

      return { summary: `Detaljer for «${name}».`, data };
    },
  },

  {
    name: "snoat_create_project",
    title: "Opprett prosjekt",
    description:
      "Oppretter et nytt prosjekt fra et GitHub-repository. Slår selv opp hvilken GitHub " +
      "App-installasjon som rekker repoet, så githubInstallationId trenger normalt ikke oppgis. " +
      "Har Snoat ingen tilgang til repoet, feiler kallet med en gang og oppgir URL-en brukeren må " +
      "åpne for å gi tilgang. Prosjektet bygges ikke automatisk – kall snoat_trigger_deployment " +
      "etterpå for å rulle det ut.",
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description:
            "Subdomene-slug: små bokstaver, tall og bindestrek, 1–63 tegn, kan ikke starte eller slutte med bindestrek.",
        },
        repoUrl: {
          type: "string",
          description: "Full URL til GitHub-repositoryet, f.eks. https://github.com/eier/repo.",
        },
        branch: {
          type: "string",
          description:
            "Grenen som skal bygges og deployes, f.eks. «dev». Utelates den, brukes repoets standardgren – " +
            "og da er det også standardgrenen auto-deploy ved push lytter på.",
        },
        buildCommand: {
          type: "string",
          description: "Valgfri overstyring av byggekommandoen, f.eks. «npm run build».",
        },
        envVars: {
          type: "object",
          description: "Miljøvariabler som nøkkel/verdi.",
          additionalProperties: { type: "string" },
        },
        githubInstallationId: {
          type: "number",
          description:
            "Valgfri GitHub App-installasjons-ID. Utledes automatisk fra repoet, og oppslaget vinner hvis de er uenige. Bruk snoat_list_github_repos for å se gyldige ID-er.",
        },
        staticOutputDir: {
          type: "string",
          description:
            "Mappen med ferdigbygde filer dersom dette er en ren statisk side, f.eks. «out» eller «dist». Da serverer Caddy filene direkte, og ingen container startes. Utelates den for et prosjekt uten fungerende «npm start», svarer siden 502.",
        },
        staticSpaFallback: {
          type: "boolean",
          description: "Sett true for at en statisk side skal falle tilbake til index.html (SPA-ruting).",
        },
        allowUnverifiedRepo: {
          type: "boolean",
          description:
            "Hopper over tilgangssjekken mot GitHub. Kun for offentlige repoer, som klones uten token.",
        },
      },
      required: ["name", "repoUrl"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
    async run(args, ctx) {
      const parsed = z
        .object({
          name: z.string().min(1),
          repoUrl: z.string().min(1),
          branch: z.string().optional(),
          buildCommand: z.string().optional(),
          envVars: z.record(z.string()).optional(),
          githubInstallationId: z.number().optional(),
          staticOutputDir: z.string().optional(),
          staticSpaFallback: z.boolean().optional(),
          allowUnverifiedRepo: z.boolean().optional(),
        })
        .parse(args);

      const { allowUnverifiedRepo, githubInstallationId, ...project } = parsed;

      // Tilgangen avgjøres før raden skrives. Rekkefølgen er hele poenget: et
      // prosjekt som peker på et repo vi ikke rekker, feiler først ved neste
      // deployment – og da med en melding om git, ikke om konfigurasjonen som
      // var gal.
      const access = await resolveRepoAccess(ctx, project.repoUrl, {
        explicitInstallationId: githubInstallationId,
        allowUnverifiedRepo,
      });

      const data = await callOrThrow(ctx, "POST", "/projects", {
        ...project,
        ...(access.installationId !== null
          ? { githubInstallationId: access.installationId }
          : {}),
      });
      const result = data as { project?: { id?: string; name?: string }; created?: boolean };

      return {
        summary: result.created
          ? `Prosjektet «${result.project?.name}» er opprettet (ID ${result.project?.id}). ${access.note} Det er ikke bygget ennå.`
          : `Prosjektet «${result.project?.name}» fantes allerede (ID ${result.project?.id}).`,
        data,
      };
    },
  },

  {
    name: "snoat_update_project",
    title: "Oppdater prosjekt",
    description:
      "Endrer repo-URL, gren, byggekommando, miljøvariabler eller statiske innstillinger. " +
      "repoUrl brukes når repoet er flyttet til en annen konto eller har fått nytt navn; tilgangen sjekkes mot " +
      "GitHub, og installasjonen som rekker repoet settes samtidig. " +
      "Merk at envVars erstatter hele settet, og at verdiene du ser er maskerte – sendes de tilbake, blir hemmelighetene " +
      "overskrevet med maskeringsteksten. Skal du endre, legge til eller fjerne enkelte variabler, bruk snoat_set_env_vars. " +
      "Endringen får effekt ved neste deployment.",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string", description: "Prosjektets ID." },
        repoUrl: {
          type: "string",
          description:
            "Ny URL til GitHub-repositoryet, f.eks. https://github.com/ny-eier/repo. For et repo som er flyttet eller omdøpt.",
        },
        branch: {
          type: ["string", "null"],
          description:
            "Ny gren å bygge og deploye, eller null for å gå tilbake til repoets standardgren. " +
            "Styrer også hvilken gren auto-deploy ved push lytter på.",
        },
        buildCommand: { type: "string", description: "Ny byggekommando." },
        envVars: {
          type: "object",
          description:
            "Hele settet med miljøvariabler. Erstatter det som ligger der. Bruk snoat_set_env_vars for enkeltendringer.",
          additionalProperties: { type: "string" },
        },
        staticOutputDir: { type: "string", description: "Ny mappe for statiske filer, f.eks. «out»." },
        staticSpaFallback: { type: "boolean", description: "SPA-fallback av eller på." },
        githubInstallationId: {
          type: ["number", "null"],
          description:
            "Ny GitHub App-installasjons-ID, eller null for å klone uten token. Retter en feil kobling uten at prosjektet må slettes og opprettes på nytt.",
        },
      },
      required: ["projectId"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    async run(args, ctx) {
      const { projectId, ...updates } = z
        .object({
          projectId: z.string().min(1),
          repoUrl: z.string().min(1).optional(),
          branch: z.string().nullable().optional(),
          buildCommand: z.string().optional(),
          envVars: z.record(z.string()).optional(),
          staticOutputDir: z.string().optional(),
          staticSpaFallback: z.boolean().optional(),
          githubInstallationId: z.number().nullable().optional(),
        })
        .parse(args);

      if (Object.keys(updates).length === 0) {
        throw new Error("Ingenting å oppdatere: oppgi minst ett felt utover projectId.");
      }

      // Ny repo-URL: tilgangen avgjøres før raden skrives, som ved opprettelse,
      // og installasjonen som faktisk rekker repoet følger med – med mindre
      // kalleren eksplisitt ba om null (klone uten token).
      let note = "";
      if (updates.repoUrl !== undefined) {
        const access = await resolveRepoAccess(ctx, updates.repoUrl, {
          explicitInstallationId: updates.githubInstallationId ?? undefined,
        });
        if (updates.githubInstallationId !== null && access.installationId !== null) {
          updates.githubInstallationId = access.installationId;
        }
        note = ` ${access.note}`;
      }

      const data = await callOrThrow(ctx, "PATCH", `/projects/${projectId}`, record(updates));

      return {
        summary: `Prosjektet er oppdatert.${note} Endringen gjelder fra neste deployment – kall snoat_trigger_deployment for å ta den i bruk nå.`,
        data,
      };
    },
  },

  {
    name: "snoat_set_env_vars",
    title: "Sett eller fjern miljøvariabler",
    description:
      "Setter, endrer eller fjerner enkelte miljøvariabler på et prosjekt eller en dev-gren, uten å røre de andre. " +
      "Flettingen skjer på serveren mot de ekte verdiene, så du trenger ikke kjenne de eksisterende. " +
      "En tom streng er en tom verdi; bruk unset for å fjerne nøkkelen. " +
      "Endringen får effekt ved neste deployment.",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string", description: "Prosjektets eller dev-grenens ID." },
        set: {
          type: "object",
          description: "Nøkler som skal settes, med ny verdi. Finnes nøkkelen, overskrives verdien.",
          additionalProperties: { type: "string" },
        },
        unset: {
          type: "array",
          items: { type: "string" },
          description: "Nøkler som skal fjernes helt.",
        },
      },
      required: ["projectId"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    async run(args, ctx) {
      const { projectId, set, unset } = z
        .object({
          projectId: z.string().min(1),
          set: z.record(z.string()).optional(),
          unset: z.array(z.string()).optional(),
        })
        .parse(args);

      if (Object.keys(set ?? {}).length === 0 && (unset ?? []).length === 0) {
        throw new Error("Ingenting å endre: oppgi minst én nøkkel i set eller unset.");
      }

      const data = (await callOrThrow(ctx, "PATCH", `/projects/${projectId}`, {
        ...(set ? { setEnvVars: set } : {}),
        ...(unset ? { unsetEnvVars: unset } : {}),
      })) as {
        envChanges?: { added: string[]; changed: string[]; removed: string[]; missing: string[] };
      };

      const changes = data.envChanges;
      const parts = changes
        ? [
            changes.added.length ? `lagt til ${changes.added.join(", ")}` : "",
            changes.changed.length ? `endret ${changes.changed.join(", ")}` : "",
            changes.removed.length ? `fjernet ${changes.removed.join(", ")}` : "",
            changes.missing.length ? `fantes ikke fra før: ${changes.missing.join(", ")}` : "",
          ].filter(Boolean)
        : [];

      return {
        summary:
          `${parts.length ? `Miljøvariabler: ${parts.join("; ")}.` : "Ingen endring – verdiene var allerede slik."} ` +
          `Andre nøkler er urørt. Endringen gjelder fra neste deployment – kall snoat_trigger_deployment for å ta den i bruk nå.`,
        data,
      };
    },
  },

  {
    name: "snoat_list_github_repos",
    title: "List GitHub-repoer",
    description:
      "Viser hvilke GitHub-kontoer som er koblet til kontoen, og hvilke repoer Snoat kan klone. " +
      "Hvert repo oppgir installasjons-ID-en som rekker det. Er ingenting koblet til, returneres " +
      "URL-en brukeren må åpne for å gi tilgang. Kall dette først når du er i tvil om et repo kan deployes.",
    inputSchema: {
      type: "object",
      properties: {
        repoUrl: {
          type: "string",
          description: "Valgfritt. Sjekk bare ett repo. Godtar både full URL og «eier/repo».",
        },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, idempotentHint: true },
    async run(args, ctx) {
      const { repoUrl } = z.object({ repoUrl: z.string().optional() }).parse(args ?? {});

      const status = (await callOrThrow(ctx, "GET", "/github/status")) as GithubStatusResponse;

      if (!status.configured) {
        return {
          summary:
            "GitHub-integrasjonen er ikke konfigurert på denne instansen. Kun offentlige repoer kan deployes.",
        };
      }

      const { repos = [] } = (await callOrThrow(ctx, "GET", "/github/repos")) as GithubReposResponse;
      const identity = repoUrl ? repoIdentity(repoUrl) : null;
      const shown = identity
        ? repos.filter((repo) => repoIdentity(repo.fullName) === identity)
        : repos;

      // Et tomt filtrert resultat er ikke «ingen data» – det er svaret på
      // «kan dette repoet deployes?», og svaret er nei. Da hører
      // installasjons-URL-en med, ellers står kalleren fast igjen.
      const summary =
        identity && shown.length === 0
          ? `Snoat har ingen tilgang til ${identity}. Åpne ${status.installUrl ?? "GitHub-innstillingene i dashbordet"} og gi Snoat tilgang til repoet.`
          : identity
            ? `Snoat rekker ${identity} gjennom installasjon ${shown[0]!.installationId}.`
            : `${repos.length} repo(er) tilgjengelig, fordelt på ${(status.installations ?? []).length} tilkoblet konto(er).`;

      return {
        summary,
        data: { accounts: status.installations ?? [], installUrl: status.installUrl, repos: shown },
      };
    },
  },

  {
    name: "snoat_connect_github",
    title: "Koble til GitHub-installasjon",
    description:
      "Registrerer en GitHub App-installasjon på kontoen, slik at repoene den rekker blir tilgjengelige. " +
      "Brukes når installasjonen er gjort på github.com utenfor dashbordet: ID-en står til slutt i URL-en " +
      "github.com/settings/installations/<ID>. Selve installasjonen kan ikke gjøres herfra – GitHub krever " +
      "at et menneske godkjenner den – så be brukeren åpne installUrl fra snoat_list_github_repos først.",
    inputSchema: {
      type: "object",
      properties: {
        installationId: {
          type: "number",
          description: "GitHub App-installasjonens ID, f.eks. 150187645.",
        },
      },
      required: ["installationId"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    async run(args, ctx) {
      const { installationId } = z.object({ installationId: z.number() }).parse(args);

      const data = await callOrThrow(ctx, "POST", "/github/installations", { installationId });
      const account = (data as { installation?: { accountLogin?: string } }).installation;

      return {
        summary: `Installasjon ${installationId} (${account?.accountLogin ?? "ukjent konto"}) er koblet til. Kall snoat_list_github_repos for å se hvilke repoer den gir tilgang til.`,
        data,
      };
    },
  },

  {
    name: "snoat_trigger_deployment",
    title: "Deploy prosjekt",
    description:
      "Starter en ny bygging og utrulling. Svaret kommer så snart bygget er lagt i kø – " +
      "bruk snoat_get_deployments eller snoat_get_deployment_logs for å følge det videre.",
    inputSchema: {
      type: "object",
      properties: { projectId: { type: "string", description: "Prosjektets ID." } },
      required: ["projectId"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
    async run(args, ctx) {
      const { projectId } = projectIdSchema.parse(args);
      const data = await callOrThrow(ctx, "POST", `/projects/${projectId}/deploy`);
      const id = (data as { deployment?: { id?: string } }).deployment?.id;

      return {
        summary: `Bygget er lagt i kø (deployment ${id}). Det tar vanligvis noen minutter.`,
        data,
      };
    },
  },

  {
    name: "snoat_get_deployments",
    title: "Hent deployments",
    description:
      "Henter de 20 siste deploymentene for et prosjekt, med status, varighet og hvilken GREN som ble bygget. " +
      "Grenen er verdt å lese: et prosjekt og dets dev-sider bygger ulike grener, og et bygg som ser feil ut " +
      "er ofte bare den andre grenen.",
    inputSchema: {
      type: "object",
      properties: { projectId: { type: "string", description: "Prosjektets ID." } },
      required: ["projectId"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, idempotentHint: true },
    async run(args, ctx) {
      const { projectId } = projectIdSchema.parse(args);
      const data = await callOrThrow(ctx, "GET", `/projects/${projectId}/deployments`);
      const list =
        (data as { deployments?: Array<{ status?: string; branch?: string | null }> }).deployments ?? [];
      const siste = list[0];
      const gren = siste?.branch ? ` på gren «${siste.branch}»` : "";

      return {
        summary:
          list.length === 0
            ? "Prosjektet har ingen deployments ennå."
            : `${list.length} deployment${list.length === 1 ? "" : "er"}, siste status: ${siste?.status}${gren}.`,
        data,
      };
    },
  },

  {
    name: "snoat_get_deployment_logs",
    title: "Hent byggelogg",
    description:
      "Henter status og bygge-/kjøretidslogg for én deployment. Bruk denne til å finne ut hvorfor et bygg feilet. " +
      "Svært lange logger klippes til halen, der feilen normalt står.",
    inputSchema: {
      type: "object",
      properties: {
        deploymentId: {
          type: "string",
          description: "Deploymentens ID, slik den kommer fra snoat_get_deployments.",
        },
      },
      required: ["deploymentId"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, idempotentHint: true },
    async run(args, ctx) {
      const { deploymentId } = z.object({ deploymentId: z.string().min(1) }).parse(args);
      const data = await callOrThrow(ctx, "GET", `/deployments/${deploymentId}`);
      const status = (data as { deployment?: { status?: string } }).deployment?.status;

      return { summary: `Deployment ${deploymentId} har status «${status}».`, data };
    },
  },

  {
    name: "snoat_get_analytics",
    title: "Hent trafikkstatistikk",
    description:
      "Henter besøkstall for et prosjekt: sidevisninger, unike besøkende, responstider, statuskoder og toppliste over stier. " +
      "Tallene kommer fra Caddys access-logg, så det kreves ingen sporingskode i appen.",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string", description: "Prosjektets ID." },
        from: { type: "string", description: "Start på vinduet, ISO-tidspunkt." },
        to: { type: "string", description: "Slutt på vinduet, ISO-tidspunkt." },
        unit: {
          type: "string",
          enum: ["hour", "day"],
          description: "Oppløsning på tidsserien. Standard velges ut fra vinduets lengde.",
        },
      },
      required: ["projectId"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, idempotentHint: true },
    async run(args, ctx) {
      const { projectId, from, to, unit } = z
        .object({
          projectId: z.string().min(1),
          from: z.string().optional(),
          to: z.string().optional(),
          unit: z.enum(["hour", "day"]).optional(),
        })
        .parse(args);

      const query = new URLSearchParams();
      if (from) query.set("from", from);
      if (to) query.set("to", to);
      if (unit) query.set("unit", unit);
      const suffix = query.toString() ? `?${query.toString()}` : "";

      const data = await callOrThrow(ctx, "GET", `/projects/${projectId}/analytics${suffix}`);

      return { summary: "Trafikkstatistikk hentet.", data };
    },
  },

  {
    name: "snoat_list_errors",
    title: "Hent nye feil",
    description:
      "Henter feil og krasj som er observert i appene, gruppert slik at samme feil er én rad med en teller – ikke én rad per forekomst. " +
      "Uten projectId går den på tvers av alle prosjektene kontoen eier, som er det du vil ha når du leter etter noe å rette. " +
      "Hver gruppe har melding, fil, linjenummer, de nyeste stacktracene, hvor mange ganger den har skjedd, og hvilken commit som var utrullet da den dukket opp første gang. " +
      "Feilene samles inn av plattformen selv: klientfeil injiseres av proxyen, serverunntak leses av containernes stderr, og krasj kommer fra helsesveipet. Det er ingenting å slå på per app.",
    inputSchema: {
      type: "object",
      properties: {
        projectId: {
          type: "string",
          description: "Begrens til ett prosjekt. Utelat for alle prosjektene kontoen eier.",
        },
        since: {
          type: "string",
          description:
            "Kun feil sist sett etter dette ISO-tidspunktet. Standard er siste døgn. Gjelder ikke sammen med projectId.",
        },
        status: {
          type: "string",
          enum: ["open", "resolved", "ignored", "all"],
          description: "Kun sammen med projectId. Standard «open».",
        },
        minEvents: {
          type: "number",
          description:
            "Hopp over feil med færre forekomster enn dette. Nyttig for å filtrere bort engangsstøy fra nettleserutvidelser. Standard 1.",
        },
        limit: { type: "number", description: "Maks antall grupper. Standard 50." },
        stacks: {
          type: "number",
          description: "Antall stacktraces per gruppe. Standard 3 på tvers av prosjekter, 1 for ett prosjekt.",
        },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, idempotentHint: true },
    async run(args, ctx) {
      const input = z
        .object({
          projectId: z.string().min(1).optional(),
          since: z.string().optional(),
          status: z.enum(["open", "resolved", "ignored", "all"]).optional(),
          minEvents: z.number().optional(),
          limit: z.number().optional(),
          stacks: z.number().optional(),
        })
        .parse(args);

      const query = new URLSearchParams();
      if (input.limit !== undefined) query.set("limit", String(input.limit));
      if (input.stacks !== undefined) query.set("stacks", String(input.stacks));

      if (input.projectId) {
        if (input.status) query.set("status", input.status);
        const suffix = query.toString() ? `?${query.toString()}` : "";
        const data = await callOrThrow(ctx, "GET", `/projects/${input.projectId}/errors${suffix}`);
        const count = (data as { errors?: unknown[] }).errors?.length ?? 0;

        return { summary: `${count} feilgrupper i prosjektet.`, data };
      }

      if (input.since) query.set("since", input.since);
      if (input.minEvents !== undefined) query.set("minEvents", String(input.minEvents));
      const suffix = query.toString() ? `?${query.toString()}` : "";

      const data = await callOrThrow(ctx, "GET", `/errors${suffix}`);
      const count = (data as { errors?: unknown[] }).errors?.length ?? 0;

      return {
        summary:
          count === 0
            ? "Ingen nye feil i vinduet."
            : `${count} feilgrupper er sett i vinduet, sortert etter hvor ofte de skjer.`,
        data,
      };
    },
  },

  {
    name: "snoat_resolve_error",
    title: "Lukk eller demp en feil",
    description:
      "Setter status på én feilgruppe. Bruk «resolved» når en fiks er laget, «ignored» for støy som aldri skal rettes, og «open» for å angre. " +
      "Send med prUrl når det finnes en pull request for fiksen – da vil neste gjennomgang se at feilen allerede er tatt hånd om og ikke foreslå den på nytt. " +
      "En feilgruppe som får en ny forekomst åpnes automatisk igjen, så «resolved» er en påstand om at fiksen virket, ikke en måte å skjule feilen på.",
    inputSchema: {
      type: "object",
      properties: {
        errorId: { type: "string", description: "Feilgruppens ID, slik den kommer fra snoat_list_errors." },
        status: { type: "string", enum: ["open", "resolved", "ignored"] },
        prUrl: { type: "string", description: "Lenke til pull requesten som fikser feilen." },
      },
      required: ["errorId", "status"],
      additionalProperties: false,
    },
    annotations: { idempotentHint: true },
    async run(args, ctx) {
      const { errorId, status, prUrl } = z
        .object({
          errorId: z.string().min(1),
          status: z.enum(["open", "resolved", "ignored"]),
          prUrl: z.string().url().optional(),
        })
        .parse(args);

      const data = await callOrThrow(ctx, "PATCH", `/errors/${errorId}`, { status, prUrl });

      return { summary: `Feilgruppen er satt til «${status}».`, data };
    },
  },

  {
    name: "snoat_set_custom_domain",
    title: "Sett eget domene",
    description:
      "Kobler et eget domene til prosjektet, eller fjerner det ved å sende null. " +
      "Domenet må peke mot Snoat i DNS før sertifikatet kan utstedes – sjekk med snoat_get_domain_status etterpå.",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string", description: "Prosjektets ID." },
        customDomain: {
          type: ["string", "null"],
          description: "Domenet, f.eks. «app.mittdomene.no». Send null for å fjerne det.",
        },
      },
      required: ["projectId", "customDomain"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    async run(args, ctx) {
      const { projectId, customDomain } = z
        .object({
          projectId: z.string().min(1),
          customDomain: z.string().nullable(),
        })
        .parse(args);

      const data = await callOrThrow(ctx, "PATCH", `/projects/${projectId}/domain`, {
        custom_domain: customDomain,
      });

      return {
        summary: customDomain
          ? `Domenet «${customDomain}» er koblet til prosjektet. Sjekk DNS og sertifikat med snoat_get_domain_status.`
          : "Det egne domenet er fjernet fra prosjektet.",
        data,
      };
    },
  },

  {
    name: "snoat_get_domain_status",
    title: "Sjekk domenestatus",
    description:
      "Sjekker om det egne domenet faktisk virker: peker DNS hit, finnes ruten i Caddy, og er sertifikatet på plass.",
    inputSchema: {
      type: "object",
      properties: { projectId: { type: "string", description: "Prosjektets ID." } },
      required: ["projectId"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, idempotentHint: true },
    async run(args, ctx) {
      const { projectId } = projectIdSchema.parse(args);
      const data = await callOrThrow(ctx, "GET", `/projects/${projectId}/domain/status`);

      return { summary: "Domenestatus hentet.", data };
    },
  },

  /*
   * ── DEV-GRENER ────────────────────────────────────────────────────────────
   *
   * En dev-side er en egen prosjektrad med `parent_project_id` satt: den arver
   * repo, byggekommando, plan og miljøvariabler fra hovedprosjektet, men bygger
   * en annen gren og er passordbeskyttet fra fødselen av.
   *
   * Verktøyene her finnes fordi en assistent ellers måtte be brukeren om å gå
   * inn i grensesnittet for å spinne opp en forhåndsvisning — som er nøyaktig
   * den friksjonen dev-grener skal fjerne.
   */
  {
    name: "snoat_list_dev_sites",
    title: "List dev-grener",
    description:
      "Henter dev-grenene til et prosjekt: hvilken gren hver av dem bygger, adressen de svarer på, " +
      "og om de er passordbeskyttet.",
    inputSchema: {
      type: "object",
      properties: { projectId: { type: "string", description: "HOVEDprosjektets ID, ikke dev-sidens." } },
      required: ["projectId"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, idempotentHint: true },
    async run(args, ctx) {
      const { projectId } = projectIdSchema.parse(args);
      const data = await callOrThrow(ctx, "GET", `/projects/${projectId}/dev-sites`);
      const list = (data as { devSites?: Array<{ branch?: string }> }).devSites ?? [];

      return {
        summary:
          list.length === 0
            ? "Prosjektet har ingen dev-grener."
            : `${list.length} dev-gren${list.length === 1 ? "" : "er"}: ${list.map((d) => d.branch ?? "?").join(", ")}.`,
        data,
      };
    },
  },

  {
    name: "snoat_create_dev_site",
    title: "Opprett dev-gren",
    description:
      "Spinner opp en passordbeskyttet forhåndsvisning av en gren. Den arver repo, byggekommando, plan og " +
      "miljøvariabler fra hovedprosjektet — miljøvariablene som en KOPI, så dev-siden kan peke på en testdatabase " +
      "uten at produksjonen gjør det. Passordet er påkrevd: en dev-side uten det ville ligget åpent på internett. " +
      "Svaret kommer så snart raden finnes; bygget følges med snoat_get_deployments.",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string", description: "HOVEDprosjektets ID. En dev-side kan ikke ha egne dev-sider." },
        branch: { type: "string", description: "Grenen som skal bygges, f.eks. «dev»." },
        password: { type: "string", description: "Passordet som beskytter forhåndsvisningen." },
      },
      required: ["projectId", "branch", "password"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
    async run(args, ctx) {
      const { projectId, branch, password } = z
        .object({ projectId: z.string(), branch: z.string(), password: z.string() })
        .parse(args);

      const data = await callOrThrow(ctx, "POST", `/projects/${projectId}/dev-sites`, {
        branch,
        password,
      });
      const site = (data as { project?: { name?: string; id?: string } }).project;

      return {
        summary: `Dev-grenen «${branch}» er opprettet som ${site?.name ?? "et nytt prosjekt"}. Bygget starter nå.`,
        data,
      };
    },
  },

  {
    name: "snoat_set_access_password",
    title: "Sett eller fjern passord",
    description:
      "Legger et passord foran en app, eller fjerner det med password: null. Caddy-ruten skrives om umiddelbart, " +
      "så endringen gjelder uten en ny deployment. Gjelder alle prosjekter, ikke bare dev-grener — «legg et passord " +
      "foran denne appen» er like nyttig for en kundedemo.",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string", description: "Prosjektets ID — hovedprosjekt eller dev-side." },
        password: {
          type: ["string", "null"],
          description: "Det nye passordet, eller null for å fjerne beskyttelsen.",
        },
      },
      required: ["projectId", "password"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
    async run(args, ctx) {
      const { projectId, password } = z
        .object({ projectId: z.string(), password: z.string().nullable() })
        .parse(args);

      const data = await callOrThrow(ctx, "PATCH", `/projects/${projectId}/access`, { password });

      return {
        summary: password === null ? "Passordbeskyttelsen er fjernet." : "Passordet er satt.",
        data,
      };
    },
  },

  {
    name: "snoat_stop_project",
    title: "Stopp prosjekt",
    description:
      "Stopper containeren og fjerner ruten, slik at appen ikke lenger svarer. Prosjektet og innstillingene beholdes, " +
      "og snoat_trigger_deployment starter det igjen.",
    inputSchema: {
      type: "object",
      properties: { projectId: { type: "string", description: "Prosjektets ID." } },
      required: ["projectId"],
      additionalProperties: false,
    },
    // Destruktivt i MCP-forstand: appen slutter å svare. Klienten skal spørre først.
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    async run(args, ctx) {
      const { projectId } = projectIdSchema.parse(args);
      await callOrThrow(ctx, "POST", `/projects/${projectId}/stop`);

      return {
        summary:
          "Appen er stoppet og svarer ikke lenger. Prosjektet og innstillingene er beholdt – deploy på nytt for å starte den igjen.",
      };
    },
  },

  {
    name: "snoat_delete_project",
    title: "Slett prosjekt",
    description:
      "SLETTER et prosjekt permanent: containere, Caddy-rute, deployments og logger forsvinner, og kan ikke gjenopprettes. " +
      "Krever at confirmProjectName stemmer med prosjektets faktiske navn, og at confirmPermanentDeletion er true. " +
      "Spør alltid brukeren eksplisitt før du kaller dette.",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string", description: "Prosjektets ID." },
        confirmProjectName: {
          type: "string",
          description: "Prosjektets navn, stavet nøyaktig. Sikrer at det er riktig prosjekt som slettes.",
        },
        confirmPermanentDeletion: {
          type: "boolean",
          description: "Må være true. Finnes for at slettingen ikke kan skje ved et uhell.",
        },
      },
      required: ["projectId", "confirmProjectName", "confirmPermanentDeletion"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true },
    async run(args, ctx) {
      const { projectId, confirmProjectName, confirmPermanentDeletion } = z
        .object({
          projectId: z.string().min(1),
          confirmProjectName: z.string().min(1),
          confirmPermanentDeletion: z.boolean(),
        })
        .parse(args);

      if (!confirmPermanentDeletion) {
        throw new Error(
          "Slettingen er avbrutt: confirmPermanentDeletion må settes eksplisitt til true.",
        );
      }

      /**
       * Navnesjekken gjøres mot prosjektet slik det faktisk er, ikke mot noe
       * modellen tror den vet. Uten oppslaget først kunne en forvekslet ID
       * slettet naboprosjektet med et navn som «stemte» fordi modellen hentet
       * begge fra samme setning.
       */
      const project = (await callOrThrow(ctx, "GET", `/projects/${projectId}`)) as {
        project?: { name?: string };
      };

      const actualName = project.project?.name;

      if (!actualName) {
        throw new Error(`Fant ikke noe prosjekt med ID ${projectId}.`);
      }

      if (confirmProjectName.trim().toLowerCase() !== actualName.toLowerCase()) {
        throw new Error(
          `Slettingen er avbrutt: «${confirmProjectName}» stemmer ikke med prosjektets navn «${actualName}».`,
        );
      }

      await callOrThrow(ctx, "DELETE", `/projects/${projectId}`);

      return { summary: `Prosjektet «${actualName}» er slettet permanent.` };
    },
  },

  // --- VPS-er (kun eierkontoen) ---------------------------------------------

  {
    name: "snoat_vps_list",
    title: "List VPS-er",
    description:
      "Lister VPS-ene (LXC-containere på Proxmox) med status, IP, SSH-kommando, RAM og disk, og viser RAM-poolen: " +
      "hvor mye av vertens RAM som er reservert for resten av serveren, og taket alle VPS-ene til sammen kan bruke.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
    ownerOnly: true,
    async run(_args, ctx) {
      const data = (await callOrThrow(ctx, "GET", "/vps")) as { vps: unknown[]; ram: { takMb: number; iBrukMb: number } };
      return {
        summary: `${data.vps.length} VPS-er. VPS-ene bruker ${data.ram.iBrukMb} MB av et felles tak på ${data.ram.takMb} MB.`,
        data,
      };
    },
  },

  {
    name: "snoat_vps_create",
    title: "Lag VPS",
    description:
      "Lager og starter en ny VPS (Debian/Ubuntu i en LXC-container med Docker-støtte). Tar typisk 20–60 sekunder. " +
      "Uten memoryMaxMb kan VPS-en bruke alt ledig minne innenfor det felles VPS-taket; memoryMinMb er minnet den " +
      "beholder når andre VPS-er presser. Standardnøklene til eieren legges alltid inn; sshPublicKeys legger til flere. " +
      "Svaret inneholder SSH-kommandoen.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Vertsnavn: små bokstaver, tall og bindestrek, 2–40 tegn." },
        template: { type: "string", enum: ["debian-12", "debian-13", "ubuntu-24.04"], description: "Standard: debian-12." },
        cores: { type: "integer", minimum: 1, description: "CPU-kjerner (tråder den kan bruke). Standard: 2. Maks: vertens tråder." },
        diskGb: { type: "integer", minimum: 4, maximum: 300, description: "Disk i GB. Standard: 20. Se snoat_vps_resources for hvor mye som er ledig." },
        memoryMaxMb: { type: "integer", minimum: 256, description: "Eget RAM-tak. Utelat for å bare følge det felles taket." },
        memoryMinMb: { type: "integer", minimum: 0, description: "Garantert RAM. Standard: 0. Summen av garantiene kan ikke passere det felles taket." },
        sshPublicKeys: { type: "array", items: { type: "string" }, description: "Ekstra offentlige SSH-nøkler." },
      },
      required: ["name"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
    ownerOnly: true,
    async run(args, ctx) {
      const data = (await callOrThrow(ctx, "POST", "/vps", args)) as {
        vps: { name: string; vmid: number; ip: string; ssh?: { command: string } | null };
      };
      return {
        summary: `VPS-en «${data.vps.name}» (ID ${data.vps.vmid}, ${data.vps.ip}) kjører.${data.vps.ssh ? ` Logg inn med: ${data.vps.ssh.command}` : ""}`,
        data,
      };
    },
  },

  {
    name: "snoat_vps_power",
    title: "Start, stopp eller restart VPS",
    description:
      "Strømhandling på en VPS: start, shutdown (pen nedstengning), stop (hard, som å trekke ut strømmen) eller reboot.",
    inputSchema: {
      type: "object",
      properties: {
        vmid: { type: "integer", description: "VPS-ens ID fra snoat_vps_list." },
        action: { type: "string", enum: ["start", "shutdown", "stop", "reboot"] },
      },
      required: ["vmid", "action"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true },
    ownerOnly: true,
    async run(args, ctx) {
      const { vmid, action } = z
        .object({ vmid: z.number().int().positive(), action: z.enum(["start", "shutdown", "stop", "reboot"]) })
        .parse(args);
      const data = (await callOrThrow(ctx, "POST", `/vps/${vmid}/${action}`)) as { vps: { name: string; status: string } };
      return { summary: `«${data.vps.name}» er nå ${data.vps.status}.`, data };
    },
  },

  {
    name: "snoat_vps_update",
    title: "Endre VPS-ressurser",
    description:
      "Endrer CPU-kjerner, eget RAM-tak (memoryMaxMb) eller garantert RAM (memoryMinMb) på en VPS. Trer i kraft uten omstart.",
    inputSchema: {
      type: "object",
      properties: {
        vmid: { type: "integer" },
        cores: { type: "integer", minimum: 1, maximum: 12 },
        memoryMaxMb: { type: "integer", minimum: 256 },
        memoryMinMb: { type: "integer", minimum: 0 },
      },
      required: ["vmid"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, idempotentHint: true },
    ownerOnly: true,
    async run(args, ctx) {
      const { vmid, ...endring } = z
        .object({
          vmid: z.number().int().positive(),
          cores: z.number().int().optional(),
          memoryMaxMb: z.number().int().optional(),
          memoryMinMb: z.number().int().optional(),
        })
        .parse(args);
      const data = (await callOrThrow(ctx, "PATCH", `/vps/${vmid}`, endring)) as { vps: { name: string } };
      return { summary: `«${data.vps.name}» er oppdatert.`, data };
    },
  },

  {
    name: "snoat_vps_delete",
    title: "Slett VPS",
    description:
      "SLETTER en VPS permanent, med disk. Kan ikke angres. Krever at confirmName stemmer med VPS-ens navn og at " +
      "confirmPermanentDeletion er true. Spør alltid brukeren eksplisitt først.",
    inputSchema: {
      type: "object",
      properties: {
        vmid: { type: "integer" },
        confirmName: { type: "string", description: "VPS-ens navn, stavet nøyaktig." },
        confirmPermanentDeletion: { type: "boolean", description: "Må være true." },
      },
      required: ["vmid", "confirmName", "confirmPermanentDeletion"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true },
    ownerOnly: true,
    async run(args, ctx) {
      const { vmid, confirmName, confirmPermanentDeletion } = z
        .object({ vmid: z.number().int().positive(), confirmName: z.string().min(1), confirmPermanentDeletion: z.boolean() })
        .parse(args);
      if (!confirmPermanentDeletion) {
        throw new Error("Slettingen er avbrutt: confirmPermanentDeletion må settes eksplisitt til true.");
      }
      await callOrThrow(ctx, "DELETE", `/vps/${vmid}`, { confirmName });
      return { summary: `VPS-en «${confirmName}» er slettet permanent.` };
    },
  },

  {
    name: "snoat_vps_resources",
    title: "Vis ledige ressurser for VPS-er",
    description:
      "Viser hva serveren har ledig før du lager eller endrer en VPS: CPU-tråder og belastning, RAM-poolen " +
      "(tak, i bruk, garantert) og disk, og grensene snoat_vps_create godtar (maks disk, maks garantert RAM).",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
    ownerOnly: true,
    async run(_args, ctx) {
      const data = (await callOrThrow(ctx, "GET", "/vps/ressurser")) as {
        ressurser: {
          cpu: { traader: number; bruktProsent: number; tildeltVps: number };
          ram: { takMb: number; iBrukMb: number; garantertMb: number };
          disk: { ledigGb: number; maksNyGb: number };
          grenser: { maksGarantertMb: number };
        };
      };
      const { cpu, ram, disk, grenser } = data.ressurser;
      return {
        summary:
          `CPU: ${cpu.traader} tråder, ${cpu.bruktProsent} % i bruk, ${cpu.tildeltVps} tildelt VPS-er (deles, ikke reservert). ` +
          `RAM: felles tak ${ram.takMb} MB, ${ram.iBrukMb} MB i bruk, ${ram.garantertMb} MB garantert (kan garantere ${grenser.maksGarantertMb} MB til). ` +
          `Disk: ${disk.ledigGb} GB ledig, en ny VPS kan få opptil ${disk.maksNyGb} GB.`,
        data,
      };
    },
  },

  {
    name: "snoat_vps_get_ram_pool",
    title: "Vis RAM-poolen for VPS-er",
    description:
      "Viser vertens totale RAM, hvor mye som er reservert for resten av serveren (Snoat-plattformen, Proxmox), taket " +
      "alle VPS-ene til sammen kan bruke, og hvor mye de bruker nå.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
    ownerOnly: true,
    async run(_args, ctx) {
      const data = (await callOrThrow(ctx, "GET", "/vps/ram")) as {
        ram: { totalMb: number; reservertMb: number; takMb: number; iBrukMb: number };
      };
      const { totalMb, reservertMb, takMb, iBrukMb } = data.ram;
      return {
        summary: `Verten har ${totalMb} MB. ${reservertMb} MB er reservert for resten av serveren, så VPS-ene kan til sammen bruke ${takMb} MB (i bruk nå: ${iBrukMb} MB).`,
        data,
      };
    },
  },

  {
    name: "snoat_vps_set_ram_pool",
    title: "Endre RAM reservert for resten av serveren",
    description:
      "Setter hvor mye RAM (MB) som alltid skal være igjen til resten av serveren. VPS-ene får til sammen bruke " +
      "verts-RAM minus dette, og hver VPS kan bruke alt ledig minne innenfor taket. Avvises hvis taket ville blitt " +
      "lavere enn det VPS-ene allerede bruker. Trer i kraft innen 15 sekunder.",
    inputSchema: {
      type: "object",
      properties: { reservertMb: { type: "integer", minimum: 8192, description: "F.eks. 57344 for 56 GB." } },
      required: ["reservertMb"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, idempotentHint: true },
    ownerOnly: true,
    async run(args, ctx) {
      const { reservertMb } = z.object({ reservertMb: z.number().int() }).parse(args);
      const data = (await callOrThrow(ctx, "PATCH", "/vps/ram", { reservertMb })) as { ram: { takMb: number } };
      return {
        summary: `${reservertMb} MB er nå reservert for resten av serveren. VPS-ene kan til sammen bruke ${data.ram.takMb} MB.`,
        data,
      };
    },
  },

  // --- Snoat selv (kun eierkontoen) -----------------------------------------

  {
    name: "snoat_platform_status",
    title: "Status for Snoat selv",
    description:
      "Viser hvilken commit av Frostbyte-Group-AS/snoat som kjører, hva main står på, om noe bygger nå, " +
      "om automatikken er på pause, og de siste byggene. Snoat deployer main av seg selv innen et minutt etter en merge.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, idempotentHint: true },
    ownerOnly: true,
    async run(_args, ctx) {
      const data = (await callOrThrow(ctx, "GET", "/plattform")) as {
        aktivert: boolean;
        deployetCommit: string | null;
        mainCommit: string | null;
        kjorer: boolean;
        pause: boolean;
      };
      if (!data.aktivert) return { summary: "Selvoppdateringen er ikke installert på serveren.", data };
      const kort = (sha: string | null) => (sha ? sha.slice(0, 7) : "ukjent");
      return {
        summary:
          `Kjører ${kort(data.deployetCommit)}, main er ${kort(data.mainCommit)}` +
          `${data.kjorer ? ", et bygg pågår" : ""}${data.pause ? ", automatikken er på pause" : ""}.`,
        data,
      };
    },
  },

  {
    name: "snoat_platform_deploy",
    title: "Deploy Snoat selv",
    description:
      "Ber serveren deploye Snoat-plattformen: main som den er nå, eller en bestemt commit på main (for å rulle " +
      "tilbake). Bygget tar noen minutter og restarter backend og Caddy – alle apper får et kort avbrudd. Spør brukeren først.",
    inputSchema: {
      type: "object",
      properties: {
        commit: { type: "string", description: "SHA på main. Utelat for å deploye main slik den er nå." },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
    ownerOnly: true,
    async run(args, ctx) {
      const { commit } = z.object({ commit: z.string().min(7).optional() }).parse(args);
      const data = await callOrThrow(ctx, "POST", "/plattform/deploy", { commit: commit ?? null });
      return {
        summary: `Deploy av ${commit ? commit.slice(0, 7) : "main"} er bestilt. Følg med med snoat_platform_status.`,
        data,
      };
    },
  },

  {
    name: "snoat_platform_logs",
    title: "Bygglogg for Snoat selv",
    description: "Henter loggen til ett bygg av Snoat-plattformen (ID fra snoat_platform_status).",
    inputSchema: {
      type: "object",
      properties: { byggId: { type: "string", description: "Byggets ID, f.eks. «20261005T101500Z-b38722b»." } },
      required: ["byggId"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, idempotentHint: true },
    ownerOnly: true,
    async run(args, ctx) {
      const { byggId } = z.object({ byggId: z.string().min(1) }).parse(args);
      const data = (await callOrThrow(ctx, "GET", `/plattform/bygg/${byggId}/logg`)) as { logg: string };
      return { summary: "Bygglogg hentet.", data: { logg: data.logg.slice(-LOG_TAIL_LENGTH) } };
    },
  },
];

export const MCP_TOOLS_BY_NAME = new Map(MCP_TOOLS.map((tool) => [tool.name, tool]));

/**
 * Teksten klienten får ved oppkobling, som en systemnær instruksjon.
 *
 * Den er kort med vilje – den ligger i kontekstvinduet for hver samtale. Det som
 * står her er det modellen ikke kan lese ut av verktøynavnene: at env-verdier er
 * maskert, og at et bygg tar tid.
 */
export const MCP_INSTRUCTIONS = [
  "Snoat er en hostingplattform. Verktøyene her gjelder kun kontoen tokenet tilhører.",
  "Verdiene i env_vars er maskert av personvernhensyn; nøkkelnavnene er ekte.",
  "snoat_trigger_deployment legger bygget i kø og svarer med én gang – bygget tar typisk noen minutter, så hent status eller logg etterpå framfor å anta at det er ferdig.",
  "Spør brukeren før du stopper eller sletter noe.",
].join(" ");

/** Tillegg for eierkontoen, som også ser VPS-verktøyene. */
export const MCP_INSTRUCTIONS_EIER =
  "VPS-verktøyene (snoat_vps_*) lager LXC-containere på Proxmox. Alle VPS-er deler ett RAM-tak (verts-RAM minus det som er reservert for resten av serveren); en VPS uten eget tak kan bruke alt ledig minne innenfor det. " +
  "Snoat selv deployer main av seg selv innen et minutt etter en merge; snoat_platform_status viser hva som kjører.";
