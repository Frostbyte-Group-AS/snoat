import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { z } from "zod";
import { SnoatClient } from "../client.js";

export function registerDeploymentToolSchemas() {
  return [
    {
      name: "snoat_trigger_deployment",
      description: "Starter en ny bygge- og utrullingsprosess (deployment) for et spesifikt Snoat-prosjekt.",
      inputSchema: {
        type: "object",
        properties: {
          projectId: {
            type: "string",
            description: "Unik ID for prosjektet som skal deployes.",
          },
        },
        required: ["projectId"],
      },
    },
    {
      name: "snoat_get_deployments",
      description: "Henter en liste over historiske deployments og deres status for et prosjekt.",
      inputSchema: {
        type: "object",
        properties: {
          projectId: {
            type: "string",
            description: "Unik ID for prosjektet.",
          },
        },
        required: ["projectId"],
      },
    },
    {
      name: "snoat_get_deployment_logs",
      description: "Henter detaljer og byggelogger/kjøretidslogger for en spesifikk deployment.",
      inputSchema: {
        type: "object",
        properties: {
          deploymentId: {
            type: "string",
            description: "Unik ID for deploymenten.",
          },
        },
        required: ["deploymentId"],
      },
    },
    {
      name: "snoat_get_analytics",
      description: "Henter trafikkstatistikk (sidevisninger, unike besøkende, responstider, feilkoder) for et prosjekt.",
      inputSchema: {
        type: "object",
        properties: {
          projectId: {
            type: "string",
            description: "Unik ID for prosjektet.",
          },
          from: {
            type: "string",
            description: "Valgfri startdato/tidspunkt (ISO format eller f.eks. '24h', '7d').",
          },
          to: {
            type: "string",
            description: "Valgfri sluttdato/tidspunkt.",
          },
          unit: {
            type: "string",
            description: "Aggregeringsenhet ('hour' eller 'day').",
          },
        },
        required: ["projectId"],
      },
    },
    {
      name: "snoat_get_domain_status",
      description: "Sjekker status på tilpasset eget domene (DNS, ruting og TLS-sertifikat) for et prosjekt.",
      inputSchema: {
        type: "object",
        properties: {
          projectId: {
            type: "string",
            description: "Unik ID for prosjektet.",
          },
        },
        required: ["projectId"],
      },
    },
  ];
}

export async function handleDeploymentToolCall(name: string, args: any, client: SnoatClient) {
  switch (name) {
    case "snoat_trigger_deployment": {
      const { projectId } = z.object({ projectId: z.string() }).parse(args);
      const res = await client.triggerDeployment(projectId);
      return {
        content: [
          {
            type: "text",
            text: `Deployment startet for prosjekt ${projectId}! Deployment ID: ${res.deployment?.id || "ukjent"}`,
          },
          {
            type: "text",
            text: JSON.stringify(res, null, 2),
          },
        ],
      };
    }

    case "snoat_get_deployments": {
      const { projectId } = z.object({ projectId: z.string() }).parse(args);
      const res = await client.getDeployments(projectId);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(res, null, 2),
          },
        ],
      };
    }

    case "snoat_get_deployment_logs": {
      const { deploymentId } = z.object({ deploymentId: z.string() }).parse(args);
      const res = await client.getDeploymentLogs(deploymentId);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(res, null, 2),
          },
        ],
      };
    }

    case "snoat_get_analytics": {
      const { projectId, from, to, unit } = z
        .object({
          projectId: z.string(),
          from: z.string().optional(),
          to: z.string().optional(),
          unit: z.string().optional(),
        })
        .parse(args);

      const res = await client.getAnalytics(projectId, from, to, unit);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(res, null, 2),
          },
        ],
      };
    }

    case "snoat_get_domain_status": {
      const { projectId } = z.object({ projectId: z.string() }).parse(args);
      const res = await client.getDomainStatus(projectId);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(res, null, 2),
          },
        ],
      };
    }

    default:
      return null;
  }
}
