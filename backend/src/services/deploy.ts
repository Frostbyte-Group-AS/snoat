import { config } from "../config.js";
import * as caddy from "../lib/caddy.js";
import { logger } from "../lib/logger.js";
import { supabase } from "../lib/supabase.js";
import { DeployError, type Deployment, type DeploymentStatus, type Project } from "../types.js";
import * as containers from "./containers.js";
import { cleanupWorkspace, cloneRepository } from "./git.js";
import { LogStream } from "./log-stream.js";
import { buildImage } from "./nixpacks.js";
import {
  assertCanDeploy,
  entitlementFor,
  planName,
  resourcesFor,
  type Entitlement,
} from "./plans.js";
import { pruneOldSites, publishStaticSite, removeProjectSites, siteDirFor } from "./static-site.js";
import { invalidateHostMap } from "./analytics-ingest.js";
import { rm, stat } from "node:fs/promises";

/**
 * Prosjekter som bygges akkurat nå.
 *
 * To samtidige builds av samme prosjekt ville kjempet om det samme image-navnet
 * og containernavnet, og den tregeste ville overskrevet den raskeste. Låsen er
 * per prosess – med flere backend-instanser må dette flyttes til en delt kø.
 */
const inFlight = new Set<string>();

/**
 * Deployments som venter på ledig byggekapasitet.
 *
 * `inFlight` hindrer at *samme* prosjekt bygges to ganger, men sier ingenting om
 * hvor mange builds som kjører totalt. Det holdt ikke: en nix-build tar det
 * minnet den trenger, og to samtidige på en liten VPS spiser hele verten. Da
 * fryser ikke bare byggene – Postgres og Caddy står på samme boks, så hele
 * plattformen går ned med dem. 30. juli 2026 skjedde nettopp det.
 *
 * Køen er global og har `SNOAT_MAX_CONCURRENT_BUILDS` plasser. Deploymenten
 * ligger i `queued` mens den venter, som er en status dashboardet allerede
 * kjenner, så brukeren ser at det skjer noe – bare ikke ennå.
 */
interface QueueEntry {
  project: Project;
  deployment: Deployment;
  logs: LogStream;
  /** Planen som gjaldt da bygget ble lagt i kø: prioritet og ressurstak. */
  entitlement: Entitlement;
}

const waiting: QueueEntry[] = [];

/**
 * Legger bygget i køen på riktig plass.
 *
 * Køen er prioritert, ikke ren FIFO: Pro og Business går foran Free. Med
 * `SNOAT_MAX_CONCURRENT_BUILDS` = 1 er dette en reell forskjell – en Free-bruker
 * som starter et tungt bygg skal ikke kunne holde produksjonen til en betalende
 * kunde ventende.
 *
 * Innenfor samme prioritet gjelder ankomstrekkefølgen: vi setter oss inn foran
 * den *første* som har lavere prioritet, altså bakerst blant våre likemenn.
 * Sammenligningen må derfor være streng ulikhet – med `<=` ville et nytt bygg
 * gått foran likemennene sine, og køen blitt LIFO for alle på samme plan.
 */
function enqueue(entry: QueueEntry): void {
  const index = waiting.findIndex(
    (queued) => queued.entitlement.limits.queuePriority < entry.entitlement.limits.queuePriority,
  );

  if (index === -1) waiting.push(entry);
  else waiting.splice(index, 0, entry);
}

export function isDeploying(projectId: string): boolean {
  return inFlight.has(projectId) || waiting.some((entry) => entry.project.id === projectId);
}

/**
 * Starter så mange ventende builds som det er ledige plasser til.
 *
 * Kalles når noe legges i køen og når en build blir ferdig. `inFlight` oppdateres
 * synkront før `runPipeline` får lov til å avvente noe, slik at løkka ikke kan
 * dele ut samme plass to ganger.
 */
function pump(): void {
  while (inFlight.size < config.SNOAT_MAX_CONCURRENT_BUILDS) {
    const next = waiting.shift();
    if (!next) return;

    inFlight.add(next.project.id);

    // Pipelinen fanger sine egne feil, men `catch`-en her er ikke pynt: en
    // avvisning fra det som ligger *utenfor* try-blokken i `runPipeline` ville
    // ellers blitt en unhandled rejection – og Node avslutter prosessen på dem.
    // Nå som webhooks starter builds uten at et menneske ser på, må en enkelt
    // rar deployment ikke kunne ta ned hele backend.
    void runPipeline(next.project, next.deployment, next.entitlement, next.logs)
      .catch((error) => {
        logger.error(
          { project: next.project.name, deployment: next.deployment.id, err: error },
          "Deployment-pipelinen kastet uventet",
        );
      })
      .finally(() => {
        inFlight.delete(next.project.id);
        pump();
      });
  }
}

/**
 * Merker deployments som mistet prosessen sin som feilet.
 *
 * Køen og `inFlight` lever i minnet til backend-prosessen. Restartes den –
 * plattform-oppdatering, server-reboot, OOM-drap – er det ingen som bygger
 * videre på radene som sto i `queued` eller `building`. Uten denne ryddingen blir
 * de stående for alltid, og dashboardet teller opp «Bygger: 55m» på en build som
 * døde for lenge siden. Det skjedde i praksis 30. juli 2026.
 *
 * At *alle* slike rader er foreldreløse ved oppstart forutsetter én backend-
 * instans, akkurat som `inFlight` gjør. Kjøres flere, ville dette drept en
 * kollegas kjørende build, og køen må da flyttes til delt lagring med eierskap
 * og heartbeat.
 */
export async function failOrphanedDeployments(): Promise<number> {
  const { data, error } = await supabase
    .from("deployments")
    .select("id, logs")
    .in("status", ["queued", "building"]);

  if (error) throw new Error(`Kunne ikke lese avbrutte deployments: ${error.message}`);

  const orphans = (data ?? []) as Array<{ id: string; logs: string | null }>;

  for (const orphan of orphans) {
    const note =
      `\n── Deployment avbrutt ──\n` +
      `Backend startet på nytt mens denne deploymenten pågikk. Vanligste årsaker er en ` +
      `plattform-oppdatering eller at serveren gikk tom for minne. Bygget ble aldri fullført.\n` +
      `Den forrige versjonen kjører videre som før – start en ny deployment når du er klar.\n`;

    const { error: updateError } = await supabase
      .from("deployments")
      .update({ status: "failed", logs: `${orphan.logs ?? ""}${note}` })
      .eq("id", orphan.id);

    if (updateError) {
      logger.warn({ deployment: orphan.id, err: updateError }, "Kunne ikke rydde avbrutt deployment");
    }
  }

  if (orphans.length > 0) {
    logger.warn({ count: orphans.length }, "Avbrutte deployments merket som feilet ved oppstart");
  }

  return orphans.length;
}

async function setStatus(
  deploymentId: string,
  status: DeploymentStatus,
  fields: Partial<Pick<Deployment, "url" | "commit_hash" | "duration_ms">> = {},
): Promise<void> {
  const { error } = await supabase
    .from("deployments")
    .update({ status, ...fields })
    .eq("id", deploymentId);

  if (error) {
    logger.error({ deploymentId, status, err: error }, "Kunne ikke oppdatere deployment-status");
  }
}

/**
 * Oppretter en deployment og starter pipelinen i bakgrunnen.
 *
 * Vi returnerer så snart raden finnes, slik at dashboardet umiddelbart kan
 * abonnere på den via Supabase Realtime og følge byggingen. HTTP-forespørselen
 * venter altså ikke på at bygget blir ferdig.
 */
export async function startDeployment(project: Project): Promise<Deployment> {
  if (isDeploying(project.id)) {
    throw new DeployError(
      "queue",
      "Prosjektet bygges allerede. Vent til den kjørende buildet er ferdig.",
      { code: "deploy.already_building" },
    );
  }

  /**
   * Planen håndheves her, og ikke i API-laget.
   *
   * `startDeployment` er den eneste veien inn til pipelinen – både det manuelle
   * endepunktet og GitHub-webhooken går gjennom den. En sjekk i `routes/api.ts`
   * ville ikke dekket auto-deploy ved push, og det er nettopp den som kan starte
   * bygg i det uendelige uten at noen sitter og ser på.
   *
   * Merk at prosjektet *ikke* opprettes gjennom backend i det hele tatt –
   * frontend inserter direkte i Supabase med RLS. Det er derfor grensen står på
   * deployment og ikke på opprettelse. Det er også riktig sted økonomisk: et
   * prosjekt uten container koster ingenting.
   */
  const entitlement = await entitlementFor(project.user_id);
  await assertCanDeploy(project, entitlement);

  // Trafikkanalysen trenger ingen registrering her: statistikken hentes ut av
  // Caddy-loggen, og vertsnavnet er alt ingesten trenger for å vite hvilket
  // prosjekt et treff gjelder. Det eneste som må skje, er at ingesten lærer om
  // et helt nytt vertsnavn – og det gjør den når ruten opprettes lenger nede.

  // Prosjektet er ikke lenger stoppet – brukeren har nettopp bedt om at det
  // kjører igjen. Nullstilles her og ikke ved vellykket build, slik at
  // dashboardet slutter å si «Stoppet» med én gang byggingen er i gang.
  // Feiler bygget, forteller deployment-statusen resten av historien.
  if (project.stopped_at) {
    const { error: clearError } = await supabase
      .from("projects")
      .update({ stopped_at: null })
      .eq("id", project.id);

    if (clearError) {
      logger.warn(
        { project: project.name, err: clearError },
        "Kunne ikke fjerne stoppet-markeringen",
      );
    }
  }

  const { data, error } = await supabase
    .from("deployments")
    .insert({ project_id: project.id, status: "queued" })
    .select()
    .single();

  if (error || !data) {
    throw new DeployError("queue", `Kunne ikke opprette deployment: ${error?.message}`);
  }

  const deployment = data as Deployment;

  // Loggen opprettes her, ikke i pipelinen, fordi ventetiden i køen er noe
  // brukeren skal kunne se. `LogStream` skriver hele teksten ved hver flush, så
  // det må være *samme* instans hele veien – to instanser for én deployment
  // ville overskrevet hverandre.
  const logs = new LogStream(deployment.id);
  logs.write(`Snoat deployer ${project.name}`);
  logs.write(`Repository: ${project.repo_url}`);

  enqueue({ project, deployment, logs, entitlement });

  // Hvor mange som faktisk står foran *dette* bygget, ikke hvor mange som er i
  // køen totalt: med prioritert kø kan et Pro-bygg ha hoppet forbi flere.
  const ahead = inFlight.size + waiting.findIndex((entry) => entry.deployment.id === deployment.id);

  if (ahead >= config.SNOAT_MAX_CONCURRENT_BUILDS) {
    logs.write(
      `\nVenter på ledig byggekapasitet – ${ahead} ${ahead === 1 ? "build" : "builds"} foran i køen.`,
    );
    if (entitlement.limits.queuePriority === 0) {
      logs.write(`Bygg på betalte planer går foran i køen.`);
    }
    await logs.flush();
  }

  if (entitlement.downgraded) {
    logs.write(
      `\n⚠️  Betalingen for ${planName(entitlement.billedPlan)} har feilet, og nådefristen er ute. ` +
        `Bygget kjører på gratisgrensene (${entitlement.limits.memoryMb} MB) til betalingen er i orden.`,
    );
    await logs.flush();
  }

  pump();

  return deployment;
}

/**
 * Advarer når bygget kjører på nøyaktig samme commit som sist, og sist feilet.
 *
 * Den vanligste grunnen til at «samme feil kom igjen» er ikke at fiksen ikke
 * virket, men at den aldri forlot maskinen. Snoat kloner standardgrenen fra
 * GitHub, så en rettelse som ligger ucommittet – eller committet uten push –
 * finnes rett og slett ikke her. Brukeren ser da en byggelogg som er identisk
 * med forrige, uten noen ledetråd om hvorfor.
 *
 * Vi har commiten fra begge deployments allerede, så sammenligningen er gratis.
 * Advarselen står før byggesteget, slik at den er lest før loggen fylles opp.
 *
 * Ingenting her får velte deploymenten: dette er en hjelpsom observasjon, ikke
 * en betingelse for å bygge. Feiler oppslaget, bygger vi videre i stillhet.
 */
async function warnOnRepeatedFailedCommit(
  project: Project,
  deployment: Deployment,
  commitHash: string,
  logs: LogStream,
): Promise<void> {
  const { data, error } = await supabase
    .from("deployments")
    .select("status, commit_hash")
    .eq("project_id", project.id)
    .neq("id", deployment.id)
    .not("commit_hash", "is", null)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    logger.warn({ project: project.name, err: error }, "Kunne ikke lese forrige deployment");
    return;
  }

  const previous = data as Pick<Deployment, "status" | "commit_hash"> | null;

  // Gikk forrige bygg bra, er det helt normalt å deploye samme commit på nytt –
  // en omstart eller en endret miljøvariabel er gyldige grunner.
  if (!previous || previous.status !== "failed") return;
  if (previous.commit_hash !== commitHash) return;

  logs.write(
    `\n⚠️  Denne deploymenten bygger nøyaktig samme commit som forrige, og den feilet ` +
      `(${commitHash.slice(0, 7)}).\n` +
      `Snoat kloner standardgrenen fra GitHub, så endringer som ikke er committet og pushet ` +
      `blir ikke med. Er rettelsen din pushet? Bygget under kommer til å gi samme resultat ` +
      `som sist hvis den ikke er det.`,
  );
}

/**
 * Peker Caddy tilbake dit trafikken gikk før deploymenten, og rydder containeren
 * som ikke ble god nok.
 *
 * Hele poenget med rullerende utrulling: en feilet deployment skal ikke koste
 * brukeren nedetid. Den forrige containeren er urørt, så det er nok å fjerne vår
 * egen. Ingenting her får kaste – den opprinnelige feilen er det brukeren skal se.
 */
async function rollback(
  project: Project,
  containerName: string,
  previousUpstream: string | null,
  logs: LogStream,
): Promise<void> {
  logs.step("Ruller tilbake");

  if (previousUpstream) {
    const current = await caddy.appRouteUpstream(project.name).catch(() => previousUpstream);

    if (current !== previousUpstream) {
      try {
        await caddy.upsertAppRoute(project.name, project.custom_domain, previousUpstream);
        logs.write(`Ruten peker igjen på ${previousUpstream}.`);
      } catch (error) {
        logs.write(`Advarsel: kunne ikke peke ruten tilbake til ${previousUpstream}.`);
        logger.error({ project: project.name, err: error }, "Kunne ikke rulle tilbake Caddy-ruten");
      }
    } else {
      logs.write(`Forrige versjon serverer fortsatt trafikk på ${previousUpstream}.`);
    }
  }

  await containers.removeContainerByName(containerName).catch((error) => {
    logger.warn({ container: containerName, err: error }, "Kunne ikke rydde feilet container");
  });
}

/**
 * Utrulling av et prosjekt som bare er filer.
 *
 * Rekkefølgen er den samme som for containere, og av samme grunn: den nye
 * versjonen legges ved siden av den gamle, og ruten byttes først når filene
 * ligger på plass. Feiler noe underveis, står forrige versjon urørt – Caddy har
 * ikke fått vite om den nye i det hele tatt.
 */
async function deployStatic(
  project: Project,
  deployment: Deployment,
  image: string,
  previousRoute: Awaited<ReturnType<typeof caddy.getAppRoute>>,
  logs: LogStream,
): Promise<void> {
  const root = await publishStaticSite(project, deployment.id, image, logs);

  try {
    logs.step("Flytter trafikken over");
    await caddy.upsertStaticRoute(project.name, project.custom_domain, root, project.static_spa_fallback);

    const active = await caddy.appRouteRoot(project.name);
    if (active !== root) {
      throw new DeployError(
        "route",
        `Caddy serverer ${active ?? "ingenting"} etter byttet, forventet ${root}.`,
      );
    }

    logs.write("Filene serveres direkte av Caddy – ingen container kjører for dette prosjektet.");
  } catch (error) {
    if (previousRoute) {
      await caddy.restoreAppRoute(project.name, project.custom_domain, previousRoute).catch((restoreError: unknown) => {
        logger.error({ project: project.name, err: restoreError }, "Kunne ikke rulle tilbake ruten");
      });
    }

    await rm(root, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }

  // Prosjektet kan ha kjørt som container tidligere. Den skal ikke stå igjen og
  // spise minne for en side som nå serveres fra disk – det er hele poenget.
  const running = await containers.countRunning(project).catch(() => 0);

  await containers.removeContainer(project).catch((error: unknown) => {
    logger.warn({ project: project.name, err: error }, "Kunne ikke fjerne tidligere container");
  });

  if (running > 0) {
    logs.write("Den tidligere containeren er stoppet og fjernet.");
  }

  await pruneOldSites(project.id, deployment.id);
}

/**
 * Livssyklusen fra 03_deployment_flow.md:
 * klone → nixpacks build → ny container → Caddy-bytte → rydd forrige → status.
 *
 * Den nye containeren startes under sitt eget navn ved siden av den som kjører,
 * og trafikken flyttes over først når den er bekreftet oppe. Derfor er det ingen
 * nedetid, og en feilet deployment lar den kjørende versjonen stå.
 */
async function runPipeline(
  project: Project,
  deployment: Deployment,
  entitlement: Entitlement,
  logs: LogStream,
): Promise<void> {
  const url = caddy.appUrl(project.name);
  const started = Date.now();

  await setStatus(deployment.id, "building");

  try {
    const { directory, commitHash } = await cloneRepository(
      project.repo_url,
      project.id,
      deployment.id,
      logs,
      project.github_installation_id,
    );
    await setStatus(deployment.id, "building", { commit_hash: commitHash });

    await warnOnRepeatedFailedCommit(project, deployment, commitHash, logs).catch((error: unknown) => {
      logger.warn({ project: project.name, err: error }, "Kunne ikke sjekke forrige commit");
    });

    const image = await buildImage(project, directory, logs);

    // Hva serverer trafikk nå? Leses før vi rører noe, slik at vi kan peke
    // tilbake hit hvis den nye versjonen ikke kommer opp. `null` = første
    // deployment, ingen rute å bevare. Vi tar vare på hele ruten, ikke bare
    // upstreamen: den forrige versjonen kan ha vært en katalog like gjerne som
    // en container, og rollbacken skal ikke bry seg om hvilken.
    const previousRoute = await caddy.getAppRoute(project.name).catch((error) => {
      logger.warn({ project: project.name, err: error }, "Kunne ikke lese gjeldende Caddy-rute");
      return null;
    });

    if (project.static_output_dir) {
      await deployStatic(project, deployment, image, previousRoute, logs);

      logs.write(`Live på ${url}`);

      const elapsed = Date.now() - started;
      const seconds = (elapsed / 1000).toFixed(1);
      logs.write(`\nFerdig på ${seconds}s.`);
      logs.write(`\n====================================================================`);
      logs.write(`[SNOAT] ✓ BYGGING FULLFØRT (${seconds}s) — Prossessen er avsluttet.`);
      logs.write(`====================================================================\n`);
      await logs.flush();
      await setStatus(deployment.id, "success", {
        url,
        commit_hash: commitHash,
        duration_ms: elapsed,
      });

      // Ruten er live. Uten dette ville analytikk-ingesten forkastet treffene
      // mot et helt nytt vertsnavn fram til den periodiske oppfriskningen kom.
      invalidateHostMap();

      logger.info({ project: project.name, deployment: deployment.id, seconds }, "Statisk deployment fullført");
      return;
    }

    const previousUpstream = caddy.routeUpstream(previousRoute);

    // Navnet er deterministisk ut fra deployment-id-en. Da treffer oppryddingen i
    // catch-blokka også hvis containeren ble opprettet men aldri kom i gang.
    const containerName = containers.containerNameFor(project, deployment.id);
    const upstream = containers.upstreamFor(containerName);

    try {
      await containers.runContainer(project, deployment.id, image, resourcesFor(entitlement, project), logs);
      await containers.assertStillRunning(containerName, logs);

      logs.step("Flytter trafikken over");
      await caddy.upsertAppRoute(project.name, project.custom_domain, upstream);

      // Caddy bytter ruten i minnet – vi leser den tilbake før vi river ned den
      // forrige containeren, slik at vi aldri fjerner det som faktisk svarer.
      const active = await caddy.appRouteUpstream(project.name);
      if (active !== upstream) {
        throw new DeployError(
          "route",
          `Caddy peker på ${active ?? "ingenting"} etter byttet, forventet ${upstream}.`,
        );
      }

      logs.write(`Trafikken går nå til ${containerName}.`);
    } catch (error) {
      await rollback(project, containerName, previousUpstream, logs);
      throw error;
    }

    // Trafikken er over på den nye containeren. Nå – og ikke før – er det trygt
    // å ta ned den forrige.
    await containers.retirePrevious(project, containerName, logs);

    logs.write(`Live på ${url}`);

    const elapsed = Date.now() - started;
    const seconds = (elapsed / 1000).toFixed(1);
    logs.write(`\nFerdig på ${seconds}s.`);
    logs.write(`\n====================================================================`);
    logs.write(`[SNOAT] ✓ BYGGING FULLFØRT (${seconds}s) — Prossessen er avsluttet.`);
    logs.write(`====================================================================\n`);
    await logs.flush();
    await setStatus(deployment.id, "success", {
      url,
      commit_hash: commitHash,
      duration_ms: elapsed,
    });

    // Se kommentaren i den statiske grenen: gjør vertsnavnet kjent for ingesten
    // med én gang, i stedet for å miste de første treffene.
    invalidateHostMap();

    logger.info({ project: project.name, deployment: deployment.id, seconds }, "Deployment fullført");
  } catch (error) {
    const step = error instanceof DeployError ? error.step : "ukjent";
    const message = error instanceof Error ? error.message : String(error);

    const elapsed = Date.now() - started;
    const seconds = (elapsed / 1000).toFixed(1);
    logs.step(`Deployment feilet (${step}) etter ${seconds}s`);
    logs.write(message);
    logs.write(`\nFeilet etter ${seconds}s.`);
    logs.write(`\n====================================================================`);
    logs.write(`[SNOAT] ✗ BYGGING FEILET (${step} etter ${seconds}s) — Prossessen er avsluttet.`);
    logs.write(`====================================================================\n`);
    await logs.flush();
    // Varigheten lagres også når bygget feiler: minuttene gikk med uansett, og
    // uten dem ville et repo som feiler etter 25 minutter vært gratis å kjøre om
    // og om igjen.
    await setStatus(deployment.id, "failed", { duration_ms: elapsed });

    logger.error({ project: project.name, deployment: deployment.id, step, seconds, err: error }, "Deployment feilet");
  } finally {
    // Kildekoden er ikke lenger nødvendig – imaget er artefakten vi beholder.
    await cleanupWorkspace(project.id, deployment.id).catch((error) => {
      logger.warn({ deployment: deployment.id, err: error }, "Kunne ikke rydde arbeidsområdet");
    });
  }
}

/**
 * Synkroniserer Caddy med det databasen sier er live.
 *
 * Caddy startes med `--config`, så dynamisk opprettede ruter forsvinner ved
 * restart. Supabase er source of truth, ikke proxyens minne, så vi bygger opp
 * igjen rutene ved oppstart for hvert prosjekt som faktisk har en kjørende
 * container.
 */
/**
 * Hvorfor et prosjekt ikke har en rute. Brukes av DNS-fanen til å si noe presist
 * i stedet for «virker ikke».
 */
export type RouteBlockedReason =
  | "no_deployment"
  | "stopped"
  | "missing_files"
  | "no_container";

export type RouteStatus = { routed: true } | { routed: false; reason: RouteBlockedReason };

/**
 * Sørger for at prosjektet har en Caddy-rute som dekker vertsnavnene sine.
 *
 * Skrives ubetinget, ikke bare når det allerede finnes en rute å endre: en rute
 * som mangler er nettopp tilfellet som må repareres. Caddy holder rutene i
 * minnet (`persist: false`), så en Caddy-restart uten en påfølgende reconcile
 * etterlater et prosjekt uten rute mens databasen fortsatt sier at alt er koblet
 * opp. Da svarer TLS-sjekken ja på domenet – den leser databasen – mens
 * forespørselen faller gjennom til catch-all-en og gir «ingen applikasjon er
 * rutet til dette domenet».
 */
export async function ensureProjectRoute(project: Project): Promise<RouteStatus> {
  // Et prosjekt brukeren har stoppet skal ikke komme tilbake. For containere er
  // dette allerede sant – de er fjernet – men en *statisk* side ligger fortsatt
  // på disk, og uten denne sjekken ville ruten blitt gjenopprettet.
  if (project.stopped_at) return { routed: false, reason: "stopped" };

  const { data: deployments } = await supabase
    .from("deployments")
    .select("id, created_at")
    .eq("project_id", project.id)
    .eq("status", "success")
    .order("created_at", { ascending: false })
    .limit(1);

  const latest = deployments?.[0];
  if (!latest) return { routed: false, reason: "no_deployment" };

  // Statiske prosjekter har ingen container å slå opp – ruten skal peke på
  // katalogen den siste vellykkede deploymenten la igjen. Finnes ikke katalogen
  // (volumet er nytt eller ryddet), må prosjektet deployes på nytt.
  if (project.static_output_dir) {
    const root = siteDirFor(project.id, latest.id);

    if (!(await directoryExists(root))) {
      logger.warn(
        { project: project.name, root },
        "Statisk prosjekt mangler filer på disk – må deployes på nytt",
      );
      return { routed: false, reason: "missing_files" };
    }

    await caddy.upsertStaticRoute(project.name, project.custom_domain, root, project.static_spa_fallback);
    return { routed: true };
  }

  // Databasen vet hvilken deployment som er live, så vi foretrekker containeren
  // som hører til den. Ellers ville en igjenglemt container fra en avbrutt
  // deployment kunne overta trafikken bare fordi den er nyest.
  const expected = containers.containerNameFor(project, latest.id);
  const name = (await containers.isRunningByName(expected))
    ? expected
    : await containers.currentContainerName(project);

  if (!name) return { routed: false, reason: "no_container" };

  await caddy.upsertAppRoute(project.name, project.custom_domain, containers.upstreamFor(name));

  // Rullerende utrulling som ble avbrutt midtveis (backend drept mellom
  // helsesjekk og opprydding) etterlater to kjørende containere. Ruten peker på
  // én av dem; resten er død vekt som holder på CPU-andel og minne til noen
  // rydder manuelt. Nå som ruten er skrevet og vi vet hvilken container som
  // gjelder, er det trygt å fjerne de andre.
  const removed = await containers.removeStaleContainers(project, name);
  if (removed.length > 0) {
    logger.info(
      { project: project.name, removed, routedTo: name },
      "Ryddet foreldreløse containere fra en avbrutt deployment",
    );
  }

  return { routed: true };
}

export async function reconcileRoutes(): Promise<{ restored: number; skipped: number }> {
  const { data, error } = await supabase
    .from("projects")
    .select("*")
    .order("created_at", { ascending: false });

  if (error) throw new Error(`Kunne ikke lese prosjekter: ${error.message}`);

  let restored = 0;
  let skipped = 0;

  const projects = (data ?? []) as Project[];

  for (const project of projects) {
    const status = await ensureProjectRoute(project);
    if (status.routed) restored += 1;
    else skipped += 1;
  }

  // Vi har nettopp lest hele prosjektlisten, og det er den eneste anledningen
  // der vi trygt kan avgjøre hva som *ikke* hører til noe prosjekt lenger.
  const orphaned = await containers.removeContainersForUnknownProjects(
    new Set(projects.map((project) => project.id)),
  );
  if (orphaned.length > 0) {
    logger.info({ orphaned }, "Ryddet containere fra slettede prosjekter");
  }

  logger.info({ restored, skipped }, "Caddy-ruter synkronisert mot Supabase");
  return { restored, skipped };
}

/**
 * Stopper applikasjonen og fjerner ruten.
 *
 * `markStopped` skiller de to grunnene til å kalle denne. Et stopp brukeren ba
 * om skal være **synlig** i dashboardet, mens en teardown på vei til sletting
 * ikke skal skrive til en rad som er i ferd med å forsvinne.
 */
export async function teardownProject(project: Project, markStopped = true): Promise<void> {
  await caddy.removeAppRoute(project.name);
  await containers.removeContainer(project);

  // Skrives etter at containeren faktisk er borte, ikke før: feiler
  // opprydningen, skal ikke databasen påstå at appen er stoppet.
  if (markStopped) {
    const { error } = await supabase
      .from("projects")
      .update({ stopped_at: new Date().toISOString() })
      .eq("id", project.id);

    if (error) {
      // Appen *er* nede – dette handler bare om at dashboardet ikke får vite
      // det. Vi kaster ikke, for da ville et vellykket stopp sett ut som en feil.
      logger.error({ project: project.name, err: error }, "Kunne ikke markere prosjektet som stoppet");
    }
  }

  // Statiske filer ligger på et delt volum og forsvinner ikke med containeren.
  // Kjøres også for prosjekter som aldri var statiske – da er det en no-op.
  await removeProjectSites(project.id).catch((error: unknown) => {
    logger.warn({ project: project.name, err: error }, "Kunne ikke fjerne statiske filer");
  });

  logger.info({ project: project.name }, "Prosjektet er tatt ned");
}

async function directoryExists(directory: string): Promise<boolean> {
  return await stat(directory).then(
    (info) => info.isDirectory(),
    () => false,
  );
}
