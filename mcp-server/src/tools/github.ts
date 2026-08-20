import { z } from "zod";
import { SnoatClient } from "../client.js";

/**
 * GitHub-tilgangen, sett fra MCP-siden.
 *
 * Bakgrunnen for denne filen er en konkret feil som var altfor lett å gå på:
 * `snoat_create_project` tok imot `githubInstallationId` som et hvilket som
 * helst tall og skrev det rett i prosjektet. Var tallet feil – for eksempel en
 * installasjon som tilhørte en organisasjon i stedet for kontoen repoet ligger
 * under – ble prosjektet opprettet uten innvending, og feilen dukket først opp
 * i en byggelogg som sa `remote: Repository not found`. Da hadde det gått
 * minutter, og ingenting i meldingen pekte tilbake mot feltet som var galt.
 *
 * Modellen i den andre enden hadde heller ingen vei ut: den kunne ikke se
 * hvilke kontoer som var koblet til, ikke hvilke repoer Snoat rakk, og ikke
 * hvor brukeren skulle sendes for å gi tilgang. Den eneste utveien var å gjette
 * på nye tall.
 *
 * Løsningen er å slå opp sannheten før vi skriver noe. Backend vet allerede
 * alt vi trenger – `GET /api/github/repos` svarer med hvert repo brukeren har
 * delt, og hvilken installasjon som rekker det – så oppslaget gjør både at
 * `githubInstallationId` kan utledes automatisk, og at et repo vi *ikke* rekker
 * gir en feilmelding med det ene som faktisk hjelper: URL-en der tilgangen
 * gis.
 */

export interface GithubRepoSummary {
  fullName: string;
  private: boolean;
  cloneUrl: string;
  defaultBranch: string;
  installationId: number;
  updatedAt: string | null;
}

export interface GithubStatus {
  configured: boolean;
  connected: boolean;
  installations: Array<{ installationId: number; accountLogin: string; accountType: string }>;
  installUrl: string | null;
}

/**
 * Feil som betyr «mennesket må gjøre noe i GitHub før dette kan virke».
 *
 * Egen klasse fordi den skal formuleres annerledes enn andre feil: den er ikke
 * en bug å rapportere, men en instruks å følge. Meldingen inneholder derfor
 * alltid installasjons-URL-en.
 */
export class GithubAccessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GithubAccessError";
  }
}

/**
 * Reduserer et repository til `owner/repo` med små bokstaver.
 *
 * Samme normalform som `repoIdentity()` i backend, og av samme grunn: verdien
 * kommer i alle varianter. En modell skriver like gjerne
 * `github.com/Eier/App/tree/main` som `https://github.com/eier/app.git`, og
 * begge skal treffe raden GitHub kaller `eier/app`.
 *
 * Returnerer `null` for noe vi ikke kjenner igjen. Da matcher vi ingenting, i
 * stedet for å gjette og koble til feil repo.
 */
export function normalizeRepo(value: string): string | null {
  let rest = value.trim().split(/[?#]/)[0] ?? "";

  const schemeEnd = rest.indexOf("://");
  if (schemeEnd !== -1) rest = rest.slice(schemeEnd + 3);

  // SSH-formen `git@github.com:eier/app.git` skiller vert og sti med kolon.
  rest = rest.replace(/^[^/@]+@/, "").replace(":", "/");

  const segments = rest
    .replace(/\/+$/, "")
    .replace(/\.git$/i, "")
    .split("/")
    .filter(Boolean);

  // Er første segment et domene, er det verten. GitHub tillater ikke punktum i
  // eiernavn, så heuristikken kan ikke spise en eier ved uhell.
  //
  // Verten må være github.com. Uten sjekken ville `gitlab.com/eier/app` blitt
  // normalisert til `eier/app` og kunne matchet et helt annet repo med samme
  // navn på GitHub – og da hadde vi festet et installasjonstoken til kode
  // eieren aldri har delt med oss.
  const host = segments[0]?.includes(".") ? segments.shift()! : null;
  if (host && !/^(www\.)?github\.com(:\d+)?$/i.test(host)) return null;

  const [owner, repo] = segments;
  if (!owner || !repo) return null;

  return `${owner}/${repo}`.toLowerCase();
}

export interface ResolvedRepoAccess {
  /** ID-en prosjektet skal lagre. `null` betyr «klones uten token». */
  installationId: number | null;
  /** Repoet vi fant, hvis oppslaget traff. */
  repo: GithubRepoSummary | null;
  /** Én setning om hvordan vi kom fram til svaret. Havner i verktøysvaret. */
  note: string;
}

/**
 * Finner installasjonen som faktisk rekker repoet.
 *
 * Rekkefølgen er bevisst: oppslaget veier tyngre enn en `githubInstallationId`
 * kalleren sendte inn. Lista fra GitHub er verifisert kunnskap om hvilken
 * installasjon som kan klone repoet, mens parameteren i beste fall er et godt
 * gjett. Blir de uenige, vinner lista – og notatet sier at vi overstyrte, slik
 * at det ikke skjer i det stille.
 */
export async function resolveRepoAccess(
  client: SnoatClient,
  repoUrl: string,
  options: { explicitInstallationId?: number; allowUnverifiedRepo?: boolean } = {},
): Promise<ResolvedRepoAccess> {
  const { explicitInstallationId, allowUnverifiedRepo } = options;
  const identity = normalizeRepo(repoUrl);

  const status = await client.githubStatus();

  // Er App-en ikke satt opp på denne Snoat-installasjonen, finnes det ingen
  // liste å slå opp i. Da skal vi ikke blokkere: offentlige repoer klones fint
  // uten token, og det er nøyaktig situasjonen en selvhostet instans uten
  // GitHub-integrasjon er i.
  if (!status.configured) {
    return {
      installationId: explicitInstallationId ?? null,
      repo: null,
      note: "GitHub-integrasjonen er ikke konfigurert på denne Snoat-instansen. Repoet må være offentlig for at kloningen skal virke.",
    };
  }

  const repos = await client.githubRepos();
  const match = identity ? repos.find((repo) => normalizeRepo(repo.fullName) === identity) : undefined;

  if (match) {
    const overridden =
      explicitInstallationId !== undefined && explicitInstallationId !== match.installationId;

    return {
      installationId: match.installationId,
      repo: match,
      note: overridden
        ? `Brukte installasjon ${match.installationId}, som er den som faktisk rekker ${match.fullName}. Den oppgitte ID-en ${explicitInstallationId} gjør det ikke, og ble ignorert.`
        : `Bekreftet tilgang til ${match.fullName} gjennom installasjon ${match.installationId}.`,
    };
  }

  // Herfra vet vi at Snoat *ikke* rekker repoet. Et offentlig repo klones
  // likevel fint uten token, så kalleren skal kunne overstyre – men det må være
  // et valg, ikke standardoppførselen. Uten flagget er stillhet det verste
  // svaret: prosjektet blir opprettet, og feilen kommer først i byggeloggen.
  if (allowUnverifiedRepo) {
    return {
      installationId: explicitInstallationId ?? null,
      repo: null,
      note: `Snoat har ikke tilgang til ${identity ?? repoUrl} gjennom noen tilkoblet konto. Fortsetter fordi «allowUnverifiedRepo» er satt – kloningen virker bare hvis repoet er offentlig.`,
    };
  }

  const accounts = status.installations.map((row) => row.accountLogin);

  throw new GithubAccessError(
    [
      `Snoat har ikke tilgang til ${identity ?? repoUrl}.`,
      accounts.length
        ? `Tilkoblede GitHub-kontoer: ${accounts.join(", ")}. Repoet ligger ikke blant de ${repos.length} repoene disse installasjonene rekker.`
        : "Ingen GitHub-kontoer er koblet til denne Snoat-brukeren ennå.",
      status.installUrl
        ? `Slik løses det: åpne ${status.installUrl}, velg kontoen repoet ligger under, og gi Snoat tilgang til det. Kall deretter «snoat_list_github_repos» for å bekrefte, eller «snoat_connect_github» med installasjons-ID-en hvis den ble installert utenfor denne flyten.`
        : "Installasjons-URL-en er utilgjengelig – sjekk GitHub-integrasjonen i Snoat-dashbordet.",
      "Er repoet offentlig, kan «allowUnverifiedRepo: true» brukes i stedet: da klones det uten token.",
    ].join("\n\n"),
  );
}

// --- Verktøy ---------------------------------------------------------------

export function registerGithubToolSchemas() {
  return [
    {
      name: "snoat_list_github_repos",
      description:
        "Viser hvilke GitHub-kontoer som er koblet til Snoat-brukeren og hvilke repoer Snoat har tilgang til å klone. " +
        "Hvert repo oppgir installasjons-ID-en som rekker det, så «snoat_create_project» slipper å gjette. " +
        "Er ingenting koblet til, returneres URL-en brukeren må åpne for å gi tilgang. " +
        "Kall dette først når du er i tvil om et repo kan deployes.",
      inputSchema: {
        type: "object",
        properties: {
          repoUrl: {
            type: "string",
            description:
              "Valgfritt. Oppgi et repo for å sjekke bare det ene. Godtar både full URL og 'eier/repo'.",
          },
        },
      },
    },
    {
      name: "snoat_connect_github",
      description:
        "Registrerer en GitHub App-installasjon på Snoat-brukeren, slik at repoene den rekker blir tilgjengelige. " +
        "Brukes når installasjonen er gjort på github.com utenfor Snoat-dashbordet: ID-en står til slutt i URL-en " +
        "github.com/settings/installations/<ID>. Selve installasjonen kan ikke gjøres herfra – GitHub krever at et " +
        "menneske godkjenner den – så be brukeren åpne «installUrl» fra «snoat_list_github_repos» først.",
      inputSchema: {
        type: "object",
        properties: {
          installationId: {
            type: "number",
            description: "GitHub App installasjons-ID, f.eks. 150187645.",
          },
        },
        required: ["installationId"],
      },
    },
  ];
}

export async function handleGithubToolCall(name: string, args: any, client: SnoatClient) {
  switch (name) {
    case "snoat_list_github_repos": {
      const { repoUrl } = z.object({ repoUrl: z.string().optional() }).parse(args ?? {});

      const status = await client.githubStatus();

      if (!status.configured) {
        return {
          content: [
            {
              type: "text",
              text: "GitHub-integrasjonen er ikke konfigurert på denne Snoat-instansen. Kun offentlige repoer kan deployes.",
            },
          ],
        };
      }

      const repos = await client.githubRepos();
      const identity = repoUrl ? normalizeRepo(repoUrl) : null;
      const shown = identity ? repos.filter((repo) => normalizeRepo(repo.fullName) === identity) : repos;

      // Treffer filteret ingenting, er det ikke et tomt resultat – det er
      // svaret på spørsmålet «kan dette repoet deployes?», og svaret er nei.
      // Da hører installasjons-URL-en med, ellers står modellen fast igjen.
      const summary =
        identity && shown.length === 0
          ? `Snoat har ingen tilgang til ${identity}. Åpne ${status.installUrl ?? "GitHub-innstillingene"} og gi Snoat tilgang til repoet.`
          : identity
            ? `Snoat rekker ${identity} gjennom installasjon ${shown[0]!.installationId}.`
            : `${repos.length} repo(er) tilgjengelig, fordelt på ${status.installations.length} tilkoblet konto(er).`;

      return {
        content: [
          { type: "text", text: summary },
          {
            type: "text",
            text: JSON.stringify(
              {
                accounts: status.installations,
                installUrl: status.installUrl,
                repos: shown,
              },
              null,
              2,
            ),
          },
        ],
      };
    }

    case "snoat_connect_github": {
      const { installationId } = z.object({ installationId: z.number() }).parse(args);
      const res = await client.connectGithubInstallation(installationId);

      return {
        content: [
          {
            type: "text",
            text: `Installasjon ${res.installation.installationId} (${res.installation.accountLogin}) er nå koblet til Snoat-brukeren. Kall «snoat_list_github_repos» for å se hvilke repoer den gir tilgang til.`,
          },
          { type: "text", text: JSON.stringify(res, null, 2) },
        ],
      };
    }

    default:
      return null;
  }
}
