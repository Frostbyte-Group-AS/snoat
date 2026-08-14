import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { SnoatClient } from "../client.js";

export function registerProjectTools(server: Server, client: SnoatClient, allowDangerousDeletions: boolean) {
  // Liste over verktøy
  server.setRequestHandler(ListToolsRequestSchema, async (request) => {
    // Hvis vi har eksisterende verktøy registrert, kan de slås sammen
    return {
      tools: [
        {
          name: "snoat_list_projects",
          description: "Henter en oversikt over alle prosjekter registrert på din Snoat-bruker.",
          inputSchema: {
            type: "object",
            properties: {},
          },
        },
        {
          name: "snoat_get_project",
          description: "Henter detaljert informasjon om et spesifikt Snoat-prosjekt basert på prosjekt-ID.",
          inputSchema: {
            type: "object",
            properties: {
              projectId: {
                type: "string",
                description: "Unik ID for prosjektet i Snoat.",
              },
            },
            required: ["projectId"],
          },
        },
        {
          name: "snoat_create_project",
          description: "Oppretter og registrerer et nytt prosjekt i Snoat fra et GitHub-repository.",
          inputSchema: {
            type: "object",
            properties: {
              name: {
                type: "string",
                description: "URL-vennlig navneslug for subdomenet (f.eks. 'min-app'). Kun små bokstaver, tall og bindestrek.",
              },
              repoUrl: {
                type: "string",
                description: "Full URL til GitHub-repository (f.eks. 'https://github.com/eier/repo').",
              },
              buildCommand: {
                type: "string",
                description: "Valgfri overstyring av byggekommando (f.eks. 'npm run build').",
              },
              envVars: {
                type: "object",
                description: "Nøkkel-verdi par med miljøvariabler for applikasjonen.",
                additionalProperties: { type: "string" },
              },
              githubInstallationId: {
                type: "number",
                description: "GitHub App installasjons-ID dersom repoet er privat.",
              },
              staticOutputDir: {
                type: "string",
                description: "Valgfri mappe for statiske filer dersom det er en ren statisk side (f.eks. 'dist').",
              },
              staticSpaFallback: {
                type: "boolean",
                description: "Sett til true dersom statisk side skal bruke index.html fallback (SPA).",
              },
            },
            required: ["name", "repoUrl"],
          },
        },
        {
          name: "snoat_update_project",
          description: "Oppdaterer konfigurasjonen (miljøvariabler, byggekommando osv.) for et prosjekt.",
          inputSchema: {
            type: "object",
            properties: {
              projectId: {
                type: "string",
                description: "Unik ID for prosjektet.",
              },
              buildCommand: {
                type: "string",
                description: "Ny byggekommando.",
              },
              envVars: {
                type: "object",
                description: "Oppdaterte miljøvariabler.",
                additionalProperties: { type: "string" },
              },
              staticOutputDir: {
                type: "string",
                description: "Ny statisk ut-mappe.",
              },
              staticSpaFallback: {
                type: "boolean",
                description: "Statisk SPA fallback flagg.",
              },
            },
            required: ["projectId"],
          },
        },
        {
          name: "snoat_stop_project",
          description: "Stopper kjørende container og fjerner Caddy-ruten for et prosjekt (uten å slette prosjektet).",
          inputSchema: {
            type: "object",
            properties: {
              projectId: {
                type: "string",
                description: "Unik ID for prosjektet som skal stoppes.",
              },
            },
            required: ["projectId"],
          },
        },
        {
          name: "snoat_set_custom_domain",
          description: "Kobler eller oppdaterer et eget tilpasset domene (f.eks. 'app.mittdomene.no') for prosjektet.",
          inputSchema: {
            type: "object",
            properties: {
              projectId: {
                type: "string",
                description: "Unik ID for prosjektet.",
              },
              customDomain: {
                type: "string",
                description: "Domenenavnet som skal kobles til prosjektet, eller null/tom streng for å fjerne.",
              },
            },
            required: ["projectId", "customDomain"],
          },
        },
        {
          name: "snoat_delete_project",
          description: "SLETTER et Snoat-prosjekt permanent, fjerner containere og ruter. (KREVER EKSPLISITT BEKREFTELSE OG SIKKERHETSFLAGG).",
          inputSchema: {
            type: "object",
            properties: {
              projectId: {
                type: "string",
                description: "Unik ID for prosjektet som skal slettes.",
              },
              confirmProjectName: {
                type: "string",
                description: "Prosjektets navn eller slug for å bekrefte at du sletter riktig prosjekt.",
              },
              confirmPermanentDeletion: {
                type: "boolean",
                description: "Må settes eksplisitt til true for at sletting skal gjennomføres.",
              },
            },
            required: ["projectId", "confirmProjectName", "confirmPermanentDeletion"],
          },
        },
      ],
    };
  });
}

export async function handleProjectToolCall(
  name: string,
  args: any,
  client: SnoatClient,
  allowDangerousDeletions: boolean
) {
  switch (name) {
    case "snoat_list_projects": {
      const res = await client.listProjects();
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(res, null, 2),
          },
        ],
      };
    }

    case "snoat_get_project": {
      const { projectId } = z.object({ projectId: z.string() }).parse(args);
      const res = await client.getProject(projectId);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(res, null, 2),
          },
        ],
      };
    }

    case "snoat_create_project": {
      const parsed = z
        .object({
          name: z.string(),
          repoUrl: z.string(),
          buildCommand: z.string().optional(),
          envVars: z.record(z.string()).optional(),
          githubInstallationId: z.number().optional(),
          staticOutputDir: z.string().optional(),
          staticSpaFallback: z.boolean().optional(),
        })
        .parse(args);

      const res = await client.createProject(parsed);
      return {
        content: [
          {
            type: "text",
            text: `Prosjekt "${res.project.name}" ble opprettet! ID: ${res.project.id}`,
          },
          {
            type: "text",
            text: JSON.stringify(res, null, 2),
          },
        ],
      };
    }

    case "snoat_update_project": {
      const parsed = z
        .object({
          projectId: z.string(),
          buildCommand: z.string().optional(),
          envVars: z.record(z.string()).optional(),
          staticOutputDir: z.string().optional(),
          staticSpaFallback: z.boolean().optional(),
        })
        .parse(args);

      const { projectId, ...updates } = parsed;
      const res = await client.updateProject(projectId, updates);
      return {
        content: [
          {
            type: "text",
            text: `Prosjekt ${projectId} ble oppdatert!`,
          },
          {
            type: "text",
            text: JSON.stringify(res, null, 2),
          },
        ],
      };
    }

    case "snoat_stop_project": {
      const { projectId } = z.object({ projectId: z.string() }).parse(args);
      const res = await client.stopProject(projectId);
      return {
        content: [
          {
            type: "text",
            text: `Prosjekt ${projectId} er nå stoppet.`,
          },
        ],
      };
    }

    case "snoat_set_custom_domain": {
      const { projectId, customDomain } = z
        .object({ projectId: z.string(), customDomain: z.string() })
        .parse(args);
      const res = await client.setCustomDomain(projectId, customDomain);
      return {
        content: [
          {
            type: "text",
            text: `Tilpasset domene "${res.custom_domain}" ble registrert for prosjekt ${projectId}.`,
          },
          {
            type: "text",
            text: JSON.stringify(res, null, 2),
          },
        ],
      };
    }

    case "snoat_delete_project": {
      // Sikkerhetssjekk 1: Miljøvariabel
      if (!allowDangerousDeletions) {
        throw new Error(
          "BEGRENSNING MOT SLETTING: Sletting av prosjekter er deaktivert på denne MCP-serveren. " +
            "For å tillate sletting må miljøvariabelen ALLOW_DANGEROUS_DELETIONS=true være satt ved oppstart."
        );
      }

      // Sikkerhetssjekk 2: Bekreftelsesparametere
      const { projectId, confirmProjectName, confirmPermanentDeletion } = z
        .object({
          projectId: z.string(),
          confirmProjectName: z.string(),
          confirmPermanentDeletion: z.boolean(),
        })
        .parse(args);

      if (!confirmPermanentDeletion) {
        throw new Error("Sletting avbrutt: confirmPermanentDeletion må settes eksplisitt til true.");
      }

      // Hent prosjektet først for å verifisere navnet
      const { project } = await client.getProject(projectId);
      if (!project) {
        throw new Error(`Prosjekt med ID ${projectId} finnes ikke.`);
      }

      if (
        confirmProjectName.toLowerCase().trim() !== project.name.toLowerCase().trim() &&
        confirmProjectName !== project.id
      ) {
        throw new Error(
          `Sletting avbrutt: Bekreftelsesnavnet "${confirmProjectName}" matchet ikke prosjektets faktiske navn "${project.name}".`
        );
      }

      const res = await client.deleteProject(projectId);
      return {
        content: [
          {
            type: "text",
            text: `Prosjekt "${project.name}" (ID: ${projectId}) ble PERMANENT SLETTET.`,
          },
        ],
      };
    }

    default:
      return null;
  }
}
