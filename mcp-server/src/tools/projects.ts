import { z } from "zod";
import { SnoatClient } from "../client.js";
import { resolveRepoAccess } from "./github.js";

/**
 * Håndterere for prosjektverktøyene.
 *
 * Skjemaene ligger i `index.ts`, som er der `ListTools` faktisk svarer fra.
 * Denne filen hadde tidligere sin egen `registerProjectTools()` med en komplett
 * kopi av alle skjemaene, men den ble aldri kalt – `index.ts` bygde lista
 * inline. To sannheter om samme verktøy er verre enn én på et upraktisk sted:
 * skjemaene her hadde alt begynt å avvike fra dem som ble sendt til klienten.
 */

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
          allowUnverifiedRepo: z.boolean().optional(),
        })
        .parse(args);

      const { allowUnverifiedRepo, githubInstallationId, ...project } = parsed;

      // Tilgangen avgjøres *før* prosjektet opprettes. Rekkefølgen er hele
      // poenget: et prosjekt som peker på et repo vi ikke rekker, feiler
      // først ved neste deployment, og da med en melding om git – ikke om
      // konfigurasjonen som var gal. `resolveRepoAccess` kaster i stedet en
      // feil som sier hva som mangler og hvor tilgangen gis.
      const access = await resolveRepoAccess(client, project.repoUrl, {
        explicitInstallationId: githubInstallationId,
        allowUnverifiedRepo,
      });

      const res = await client.createProject({
        ...project,
        ...(access.installationId !== null
          ? { githubInstallationId: access.installationId }
          : {}),
      });

      return {
        content: [
          {
            type: "text",
            text: `Prosjekt "${res.project.name}" ble opprettet! ID: ${res.project.id}\n${access.note}`,
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
          githubInstallationId: z.number().nullable().optional(),
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
      await client.stopProject(projectId);
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

      await client.deleteProject(projectId);
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
