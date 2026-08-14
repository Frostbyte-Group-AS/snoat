#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import dotenv from "dotenv";
import { SnoatClient } from "./client.js";
import { registerDeploymentToolSchemas, handleDeploymentToolCall } from "./tools/deployments.js";
import { registerProjectTools, handleProjectToolCall } from "./tools/projects.js";

dotenv.config();

const apiKey = process.env.SNOAT_API_KEY;
const apiUrl = process.env.SNOAT_API_URL || "http://api.snoat.localhost";
const allowDangerousDeletions =
  process.env.ALLOW_DANGEROUS_DELETIONS === "true" || process.env.ALLOW_DANGEROUS_DELETIONS === "1";

if (!apiKey) {
  console.error("FEIL: SNOAT_API_KEY er udefinert i miljøvariablene.");
  console.error("Vennligst sett SNOAT_API_KEY=snoat_ak_... når du starter Snoat MCP Server.");
  process.exit(1);
}

const client = new SnoatClient(apiKey, apiUrl);

const server = new Server(
  {
    name: "snoat-mcp-server",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// Håndter ListToolsRequest
server.setRequestHandler(ListToolsRequestSchema, async () => {
  const deploymentTools = registerDeploymentToolSchemas();

  const projectTools = [
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
            description: "Domenenavnet som skal kobles til prosjektet.",
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
  ];

  return {
    tools: [...projectTools, ...deploymentTools],
  };
});

// Håndter CallToolRequest
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    const projectResult = await handleProjectToolCall(name, args, client, allowDangerousDeletions);
    if (projectResult) return projectResult;

    const deploymentResult = await handleDeploymentToolCall(name, args, client);
    if (deploymentResult) return deploymentResult;

    throw new Error(`Ukjent MCP verktøy: ${name}`);
  } catch (error: any) {
    return {
      content: [
        {
          type: "text",
          text: `Feil ved utførelse av verktøy "${name}": ${error?.message || error}`,
        },
      ],
      isError: true,
    };
  }
});

async function run() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

run().catch((error) => {
  console.error("Kritisk feil i Snoat MCP Server:", error);
  process.exit(1);
});
