import type Dockerode from "dockerode";
import { config } from "../config.js";
import { docker, ensureAppsNetwork } from "../lib/docker.js";
import { logger } from "../lib/logger.js";
import { DeployError, type Project } from "../types.js";
import type { LogStream } from "./log-stream.js";

const LABEL_MANAGED = "no.snoat.managed";
const LABEL_PROJECT = "no.snoat.project-id";
const LABEL_DEPLOYMENT = "no.snoat.deployment-id";

/**
 * Navnet containerne hadde før rullerende utrulling, da hvert prosjekt hadde
 * nøyaktig én container. Beholdt for å kunne finne igjen apper som ble deployet
 * med den gamle pipelinen – de skal ikke drepes av en reconcile.
 */
function legacyContainerName(project: Project): string {
  return `snoat-app-${project.name}`;
}

/**
 * Containernavnet én bestemt deployment kjører under.
 *
 * Hver deployment får sitt eget navn slik at ny og gammel versjon kan kjøre
 * side om side mens Caddy byttes over (03_deployment_flow.md steg 5). Uuid-en
 * kortes ned til åtte tegn: navnet er samtidig DNS-navnet på apps-nettverket, og
 * en DNS-label tåler maks 63 tegn.
 */
export function containerNameFor(project: Project, deploymentId: string): string {
  return `snoat-app-${project.name}-${deploymentId.replace(/-/g, "").slice(0, 8)}`;
}

/** `containernavn:port` – det Caddy skal dial-e. */
export function upstreamFor(containerName: string): string {
  return `${containerName}:${config.SNOAT_APP_PORT}`;
}

interface ProjectContainer {
  id: string;
  name: string;
  running: boolean;
  /** Unix-sekunder. Brukes til å finne den nyeste containeren. */
  created: number;
}

/**
 * Ressurstaket containeren kjøres under.
 *
 * Var tidligere `config.SNOAT_APP_MEMORY_MB` lest rett fra `runContainer`. Nå
 * kommer verdiene fra brukerens plan (`services/plans.ts`), fordi det er
 * nettopp minne per container gratisplanen selger mindre av.
 */
export interface ContainerResources {
  memoryMb: number;
  cpus: number;
}

/** Docker svarer med HTTP-statuskoder på socketen; de skiller «finnes ikke» fra reell feil. */
function statusCode(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null || !("statusCode" in error)) return undefined;
  const value = (error as { statusCode: unknown }).statusCode;
  return typeof value === "number" ? value : undefined;
}

async function inspectByName(name: string): Promise<ProjectContainer | null> {
  try {
    const info = await docker.getContainer(name).inspect();
    return {
      id: info.Id,
      name,
      running: info.State.Running === true,
      created: Math.floor(Date.parse(info.Created) / 1000),
    };
  } catch {
    return null;
  }
}

/**
 * Alle containere Snoat eier for prosjektet, nyeste først.
 *
 * Vi slår opp på label og ikke på navn, fordi navnet nå inneholder
 * deployment-id-en. Labelen er det stabile båndet mellom en container og
 * prosjektet den tilhører.
 */
async function listProjectContainers(project: Project): Promise<ProjectContainer[]> {
  const infos = await docker.listContainers({
    all: true,
    filters: { label: [`${LABEL_PROJECT}=${project.id}`] },
  });

  const found: ProjectContainer[] = infos.map((info) => ({
    id: info.Id,
    name: (info.Names[0] ?? "").replace(/^\//, ""),
    running: info.State === "running",
    created: info.Created,
  }));

  // Containere fra før labelene fantes har bare det gamle navnet å gå etter.
  const legacy = legacyContainerName(project);
  if (!found.some((container) => container.name === legacy)) {
    const orphan = await inspectByName(legacy);
    if (orphan) found.push(orphan);
  }

  return found.sort((a, b) => b.created - a.created);
}

/**
 * Stopper containeren pent før den fjernes.
 *
 * `stop` gir appen SIGTERM og `SNOAT_APP_STOP_TIMEOUT_S` sekunder på å avslutte
 * forespørsler den holder på, i stedet for å bli revet bort midt i et svar.
 * Feiler stoppen likevel, tar `force: true` den ned hardt – en container vi har
 * bestemt oss for å fjerne skal ikke kunne bli liggende.
 */
async function stopAndRemove(idOrName: string): Promise<void> {
  const container = docker.getContainer(idOrName);

  try {
    await container.stop({ t: config.SNOAT_APP_STOP_TIMEOUT_S });
  } catch (error) {
    const status = statusCode(error);
    // 304 = allerede stoppet, 404 = allerede borte. Begge er ønsket tilstand.
    if (status !== 304 && status !== 404) {
      logger.warn({ container: idOrName, err: error }, "Kunne ikke stoppe containeren pent");
    }
  }

  try {
    await container.remove({ force: true });
  } catch (error) {
    if (statusCode(error) === 404) return;
    throw error;
  }
}

/** Fjerner en container ved navn. No-op hvis den ikke finnes. */
export async function removeContainerByName(name: string): Promise<void> {
  if (!(await inspectByName(name))) return;

  try {
    await stopAndRemove(name);
    logger.info({ container: name }, "Container fjernet");
  } catch (error) {
    throw new DeployError("run", `Kunne ikke fjerne containeren ${name}: ${String(error)}`);
  }
}

/**
 * Starter applikasjonen i en ny container.
 *
 * Dokploy oppretter Swarm-*services*; vi kjører vanlige containere mot én
 * daemon, slik 03_deployment_flow.md beskriver. Containeren publiserer ingen
 * port på verten – Caddy når den over det interne apps-nettverket på
 * containernavnet, som holder brukerapper utilgjengelige utenfra bortsett fra
 * gjennom proxyen.
 *
 * Den forrige containeren røres **ikke** her. Den fortsetter å serve trafikk til
 * den nye er bekreftet oppe og Caddy er byttet over (`retirePrevious`).
 */
export async function runContainer(
  project: Project,
  deploymentId: string,
  image: string,
  resources: ContainerResources,
  logs: LogStream,
): Promise<void> {
  await ensureAppsNetwork();

  const name = containerNameFor(project, deploymentId);

  logs.step("Starter container");

  // Et tidligere, avbrutt forsøk på *samme* deployment kan ha lagt igjen en
  // container med dette navnet. Den kjørende versjonen har et annet navn.
  await removeContainerByName(name);

  const env = [
    `PORT=${config.SNOAT_APP_PORT}`,
    `HOST=0.0.0.0`,
    // Byggets `NODE_OPTIONS` er bakt inn i image-et av nixpacks, og det taket er
    // satt for en build – langt over det containeren faktisk får bruke. Tror V8
    // den har mer heap enn `Memory` tillater, rydder den for lat og Docker
    // OOM-dreper containeren. Vi overstyrer derfor med et tak som passer taket.
    //
    // Verdien må komme fra *samme* tall som `HostConfig.Memory` under. Regnes de
    // to fra hver sin kilde – for eksempel fordi planen hever den ene og
    // konfigurasjonen den andre – er OOM-drapet tilbake, og da i en form som
    // bare rammer kunder på én plan.
    `NODE_OPTIONS=--max-old-space-size=${Math.floor(resources.memoryMb * 0.75)}`,
    // Brukerens egne variabler kommer sist og vinner: Docker lar den siste
    // forekomsten av en nøkkel gjelde.
    ...Object.entries(project.env_vars ?? {}).map(([key, value]) => `${key}=${value}`),
  ];

  const options: Dockerode.ContainerCreateOptions = {
    name,
    Image: image,
    Env: env,
    Labels: {
      [LABEL_MANAGED]: "true",
      [LABEL_PROJECT]: project.id,
      [LABEL_DEPLOYMENT]: deploymentId,
    },
    ExposedPorts: { [`${config.SNOAT_APP_PORT}/tcp`]: {} },
    HostConfig: {
      // Ressurstak – ett prosjekt skal ikke kunne spise opp verten. Hvor høyt
      // taket er, avgjøres av kundens plan (`services/plans.ts`).
      Memory: resources.memoryMb * 1024 * 1024,
      NanoCpus: Math.round(resources.cpus * 1e9),
      RestartPolicy: { Name: "unless-stopped" },
      NetworkMode: config.SNOAT_APPS_NETWORK,
    },
    NetworkingConfig: {
      EndpointsConfig: {
        // Aliaset er stabilt på tvers av deployments, så apper kan nå hverandre
        // på prosjektnavnet. I sekundene der to versjoner kjører samtidig peker
        // det på begge (round-robin) – Caddy dial-er containernavnet, som alltid
        // er entydig.
        [config.SNOAT_APPS_NETWORK]: { Aliases: [project.name] },
      },
    },
  };

  let container: Dockerode.Container;
  try {
    container = await docker.createContainer(options);
    await container.start();
  } catch (error) {
    throw new DeployError("run", `Containeren startet ikke: ${String(error)}`);
  }

  logs.write(`Container startet: ${name} (${resources.memoryMb} MB, ${resources.cpus} CPU)`);
}

/**
 * Kaster med applikasjonens egen logg vedlagt – den forklarer nesten alltid
 * hvorfor containeren ikke ble frisk.
 */
async function failWithAppLogs(
  container: Dockerode.Container,
  logs: LogStream,
  message: string,
): Promise<never> {
  const tail = await container
    .logs({ stdout: true, stderr: true, tail: 50 })
    .then((buffer) => buffer.toString())
    .catch(() => "");

  if (tail) {
    logs.step("Applikasjonens logg");
    logs.write(tail);
  }

  throw new DeployError("run", message);
}

/**
 * Helsesjekken den nye versjonen må gjennom før trafikken flyttes over.
 *
 * En app som krasjer umiddelbart (manglende miljøvariabel, feil startkommando)
 * ville ellers blitt markert som «Live» selv om ingenting svarer – og med
 * rullerende utrulling ville den i tillegg fått en fungerende versjon revet ned
 * under seg. Feiler sjekken, blir den forrige containeren stående.
 *
 * Vi poller gjennom hele vinduet i stedet for å inspisere én gang på slutten:
 * `RestartPolicy: unless-stopped` starter en krasjende app på nytt igjen og
 * igjen, og `State.Running` er sann i glimtene mellom omstartene. Ett enkelt
 * øyeblikksbilde slipper altså en app i krasj-loop rett gjennom.
 */
export async function assertStillRunning(
  containerName: string,
  logs: LogStream,
  windowMs = 3000,
  intervalMs = 500,
): Promise<void> {
  const container = docker.getContainer(containerName);
  const deadline = Date.now() + windowMs;

  for (;;) {
    const remaining = Math.max(0, deadline - Date.now());
    await new Promise((resolve) => setTimeout(resolve, Math.min(intervalMs, remaining)));

    let info: Dockerode.ContainerInspectInfo;
    try {
      info = await container.inspect();
    } catch (error) {
      throw new DeployError("run", `Containeren ${containerName} finnes ikke lenger: ${String(error)}`);
    }

    if (info.RestartCount > 0 || info.State.Restarting) {
      await failWithAppLogs(
        container,
        logs,
        `Containeren krasjet og ble startet på nytt ${Math.max(info.RestartCount, 1)} gang(er) rett etter oppstart. ` +
          `Appen kommer ikke opp – forrige versjon står urørt.`,
      );
    }

    if (!info.State.Running) {
      await failWithAppLogs(
        container,
        logs,
        `Containeren stoppet rett etter oppstart (exit code ${info.State.ExitCode}). Lytter appen på $PORT?`,
      );
    }

    if (Date.now() >= deadline) {
      logs.write(`Containeren står stabilt – ${containerName} kjører.`);
      return;
    }
  }
}

/**
 * Fjerner alle containere for prosjektet bortsett fra `keep`.
 *
 * Kalles først *etter* at Caddy er bekreftet byttet over til `keep`, slik at den
 * forrige versjonen serverer trafikk helt til det finnes en ny som gjør det.
 * Feiler oppryddingen, er deploymenten fortsatt vellykket – trafikken går
 * allerede til den nye containeren – så vi logger og går videre.
 */
export async function retirePrevious(
  project: Project,
  keep: string,
  logs: LogStream,
): Promise<string[]> {
  const stale = (await listProjectContainers(project)).filter((container) => container.name !== keep);
  const removed: string[] = [];

  if (stale.length === 0) return removed;

  logs.step("Rydder forrige versjon");

  for (const container of stale) {
    try {
      await stopAndRemove(container.id);
      removed.push(container.name);
      logs.write(`Fjernet forrige container: ${container.name}`);
    } catch (error) {
      logs.write(`Advarsel: kunne ikke fjerne ${container.name}. Den må ryddes manuelt.`);
      logger.warn(
        { project: project.name, container: container.name, err: error },
        "Kunne ikke fjerne utgått container",
      );
    }
  }

  return removed;
}

/**
 * Fjerner containere for prosjektet som ikke er den `keep` peker på.
 *
 * Samme jobb som `retirePrevious`, men uten en LogStream å skrive til – den
 * finnes bare mens en deployment kjører. En utrulling som ble avbrutt midtveis
 * (backend drept mellom helsesjekk og opprydding) etterlater to kjørende
 * containere for samme prosjekt, og hver av dem holder på sin CPU-andel og sitt
 * minne i det uendelige. Før ble dette bare logget som en advarsel.
 */
export async function removeStaleContainers(project: Project, keep: string): Promise<string[]> {
  const stale = (await listProjectContainers(project)).filter((container) => container.name !== keep);
  const removed: string[] = [];

  for (const container of stale) {
    try {
      await stopAndRemove(container.id);
      removed.push(container.name);
      logger.info({ project: project.name, container: container.name }, "Fjernet foreldreløs container");
    } catch (error) {
      logger.warn(
        { project: project.name, container: container.name, err: error },
        "Kunne ikke fjerne foreldreløs container",
      );
    }
  }

  return removed;
}

/**
 * Fjerner containere som tilhører prosjekter som ikke finnes lenger.
 *
 * `removeStaleContainers` rydder rester av *samme* prosjekt, men den slår opp på
 * prosjekt-ID – så en container fra et prosjekt som er slettet fra databasen blir
 * aldri sett av noen. Den fortsetter å kjøre, holder på minnet og CPU-andelen sin,
 * og overlever hver eneste restart. Vi fant en slik som hadde kjørt siden et
 * prosjekt som ikke lenger eksisterer.
 *
 * Kjøres ved oppstart, når vi uansett leser hele prosjektlisten. Tar bare
 * containere vi selv har merket, og bare når vi har en fullstendig liste å
 * sammenligne mot – ellers ville en tom liste sett ut som «slett alt».
 */
export async function removeContainersForUnknownProjects(knownProjectIds: Set<string>): Promise<string[]> {
  if (knownProjectIds.size === 0) return [];

  const infos = await docker.listContainers({
    all: true,
    filters: { label: [`${LABEL_MANAGED}=true`] },
  });

  const removed: string[] = [];

  for (const info of infos) {
    const projectId = info.Labels?.[LABEL_PROJECT];
    // Uten prosjekt-ID vet vi ikke hva den hører til, og da lar vi den stå.
    if (!projectId || knownProjectIds.has(projectId)) continue;

    const name = (info.Names[0] ?? "").replace(/^\//, "");
    try {
      await stopAndRemove(info.Id);
      removed.push(name);
      logger.info({ container: name, projectId }, "Fjernet container fra slettet prosjekt");
    } catch (error) {
      logger.warn({ container: name, projectId, err: error }, "Kunne ikke fjerne container fra slettet prosjekt");
    }
  }

  return removed;
}

/** Stopper og fjerner alle containere for prosjektet. Brukes når det slettes. */
export async function removeContainer(project: Project): Promise<void> {
  for (const container of await listProjectContainers(project)) {
    try {
      await stopAndRemove(container.id);
      logger.info({ container: container.name }, "Container fjernet");
    } catch (error) {
      throw new DeployError("run", `Kunne ikke fjerne containeren ${container.name}: ${String(error)}`);
    }
  }
}

/**
 * Containeren som skal ta imot trafikk nå: den nyeste som kjører.
 *
 * `null` betyr at prosjektet ikke har noen kjørende versjon – enten fordi det
 * aldri er deployet, eller fordi containeren er borte.
 */
export async function currentContainerName(project: Project): Promise<string | null> {
  const running = (await listProjectContainers(project)).filter((container) => container.running);
  return running[0]?.name ?? null;
}

/**
 * Prosjektene som har minst én kjørende container akkurat nå, som et sett av
 * prosjekt-ID-er.
 *
 * Grunnlaget for grensen på antall samtidige apper per plan. Vi spør Docker én
 * gang for alle Snoat-containere i stedet for å inspisere hvert prosjekt for
 * seg: en bruker med tjue prosjekter ville ellers gitt tjue kall per deployment.
 *
 * Uten `all: true` returnerer Docker kun det som kjører, som er nøyaktig
 * spørsmålet – et stoppet prosjekt koster ikke minne og skal ikke telles.
 */
export async function runningProjectIds(): Promise<Set<string>> {
  const infos = await docker.listContainers({ filters: { label: [`${LABEL_MANAGED}=true`] } });

  const ids = new Set<string>();
  for (const info of infos) {
    const projectId = info.Labels?.[LABEL_PROJECT];
    if (projectId) ids.add(projectId);
  }

  return ids;
}

/** Antall kjørende containere for prosjektet. Mer enn én betyr en avbrutt deployment. */
export async function countRunning(project: Project): Promise<number> {
  return (await listProjectContainers(project)).filter((container) => container.running).length;
}

/** True hvis containeren med dette navnet kjører nå. */
export async function isRunningByName(name: string): Promise<boolean> {
  return (await inspectByName(name))?.running === true;
}

/** True hvis prosjektet har en kjørende container. Brukes ved reconcile. */
export async function isRunning(project: Project): Promise<boolean> {
  return (await currentContainerName(project)) !== null;
}
