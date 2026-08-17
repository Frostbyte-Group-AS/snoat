import { z } from "zod";
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
      "Henter detaljene for ett prosjekt: byggekommando, miljøvariabelnavn, eget domene og siste deployment.",
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
      "Oppretter et nytt prosjekt fra et GitHub-repository. Prosjektet bygges ikke automatisk – " +
      "kall snoat_trigger_deployment etterpå for å rulle det ut.",
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
          description: "GitHub App-installasjonens ID. Påkrevd for private repoer.",
        },
        staticOutputDir: {
          type: "string",
          description: "Mappen med ferdigbygde filer dersom dette er en ren statisk side, f.eks. «dist».",
        },
        staticSpaFallback: {
          type: "boolean",
          description: "Sett true for at en statisk side skal falle tilbake til index.html (SPA-ruting).",
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
          buildCommand: z.string().optional(),
          envVars: z.record(z.string()).optional(),
          githubInstallationId: z.number().optional(),
          staticOutputDir: z.string().optional(),
          staticSpaFallback: z.boolean().optional(),
        })
        .parse(args);

      const data = await callOrThrow(ctx, "POST", "/projects", parsed);
      const result = data as { project?: { id?: string; name?: string }; created?: boolean };

      return {
        summary: result.created
          ? `Prosjektet «${result.project?.name}» er opprettet (ID ${result.project?.id}). Det er ikke bygget ennå.`
          : `Prosjektet «${result.project?.name}» fantes allerede (ID ${result.project?.id}).`,
        data,
      };
    },
  },

  {
    name: "snoat_update_project",
    title: "Oppdater prosjekt",
    description:
      "Endrer byggekommando, miljøvariabler eller statiske innstillinger. " +
      "Merk at envVars erstatter hele settet – hent prosjektet først og send med alle nøklene som skal bestå. " +
      "Endringen får effekt ved neste deployment.",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string", description: "Prosjektets ID." },
        buildCommand: { type: "string", description: "Ny byggekommando." },
        envVars: {
          type: "object",
          description: "Hele settet med miljøvariabler. Erstatter det som ligger der.",
          additionalProperties: { type: "string" },
        },
        staticOutputDir: { type: "string", description: "Ny mappe for statiske filer." },
        staticSpaFallback: { type: "boolean", description: "SPA-fallback av eller på." },
      },
      required: ["projectId"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    async run(args, ctx) {
      const { projectId, ...updates } = z
        .object({
          projectId: z.string().min(1),
          buildCommand: z.string().optional(),
          envVars: z.record(z.string()).optional(),
          staticOutputDir: z.string().optional(),
          staticSpaFallback: z.boolean().optional(),
        })
        .parse(args);

      if (Object.keys(updates).length === 0) {
        throw new Error("Ingenting å oppdatere: oppgi minst ett felt utover projectId.");
      }

      const data = await callOrThrow(ctx, "PATCH", `/projects/${projectId}`, record(updates));

      return {
        summary: `Prosjektet er oppdatert. Endringen gjelder fra neste deployment – kall snoat_trigger_deployment for å ta den i bruk nå.`,
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
    description: "Henter de 20 siste deploymentene for et prosjekt, med status og varighet.",
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
      const list = (data as { deployments?: Array<{ status?: string }> }).deployments ?? [];

      return {
        summary:
          list.length === 0
            ? "Prosjektet har ingen deployments ennå."
            : `${list.length} deployment${list.length === 1 ? "" : "er"}, siste status: ${list[0]?.status}.`,
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
