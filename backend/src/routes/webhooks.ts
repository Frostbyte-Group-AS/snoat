import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import * as github from "../lib/github.js";
import { logger } from "../lib/logger.js";
import { supabase } from "../lib/supabase.js";
import * as deploy from "../services/deploy.js";
import type { Project } from "../types.js";

/**
 * Webhook-mottak fra GitHub: automatisk re-deployment ved `git push`.
 *
 * Endepunktet er **offentlig**. Det monteres under `/api/webhooks`, men utenfor
 * `requireAuth` – GitHub har ingen Supabase-sesjon å sende med. Tilliten hviler
 * i stedet på HMAC-signaturen i `x-hub-signature-256`, på samme måte som
 * `/github/setup` hviler på en signert `state`. Se `index.ts` for hvorfor
 * rekkefølgen på monteringen betyr noe.
 *
 * To ting styrer utformingen:
 *
 *   1. **Vi svarer med én gang.** `startDeployment` oppretter deployment-raden
 *      og bygger videre i bakgrunnen, akkurat som det manuelle endepunktet, så
 *      GitHub venter aldri på en nixpacks-build.
 *   2. **Ingenting her får velte serveren.** Alt som kan feile fanges og logges
 *      med pino. Et uventet event, en tom payload eller en databasefeil skal
 *      bli en loggmelding – ikke en ubehandlet exception i en offentlig rute.
 */
export const githubWebhooks = new Hono();

/**
 * Push-payloader er små (GitHub tar med maks 20 commits), men ruten er åpen for
 * hvem som helst. Uten et tak kunne en tilfeldig POST med flere hundre megabyte
 * body spist minnet til backend før vi rakk å avvise signaturen.
 */
const MAX_BODY_BYTES = 5 * 1024 * 1024;

/** Grener vi deployer fra når payloaden ikke oppgir repoets hovedgren. */
const FALLBACK_BRANCHES = ["main", "master"];

/**
 * Skal en push til denne grenen utløse en deployment av *dette* prosjektet?
 *
 * Har prosjektet valgt en gren (`projects.branch`, migrasjon 0012), er det den
 * som gjelder, og bare den. Ellers er repoets egen `default_branch` autoriteten
 * – det er grenen brukeren har pekt ut på GitHub – med `main`/`master` som
 * fallback for en payload som mangler feltet.
 *
 * ⚠️ Avgjørelsen er **per prosjekt**, ikke per push, og det er hele forskjellen
 * fra før. Flere prosjekter kan peke på samme repo med ulike grener: ett som
 * bygger `main` og ett som bygger `dev` for et forhåndsvisnings-subdomene. En
 * push til `dev` skal da starte deployment for det andre og la det første stå
 * urørt. Sammenligningen kan derfor ikke gjøres før vi vet hvilke prosjekter
 * pushen gjelder.
 */
function isDeployBranch(
  branch: string,
  project: Project,
  defaultBranch: string | undefined,
): boolean {
  if (project.branch) return branch === project.branch;
  return defaultBranch ? branch === defaultBranch : FALLBACK_BRANCHES.includes(branch);
}

/**
 * Tolker råkroppen som en push-payload.
 *
 * GitHub sender enten JSON, eller `payload=<json>` form-encoded, avhengig av hva
 * som er valgt under «Content type» i webhook-innstillingene. Signaturen dekker
 * råkroppen i begge tilfeller, så det er kun tolkningen som skiller dem.
 */
function parsePayload(body: Buffer, contentType: string | undefined): github.GithubPushPayload {
  const raw = contentType?.includes("application/x-www-form-urlencoded")
    ? new URLSearchParams(body.toString("utf8")).get("payload")
    : body.toString("utf8");

  if (!raw) throw new Error("Tom payload");

  // `JSON.parse("null")` og `JSON.parse("3")` er gyldig JSON, men ikke en
  // payload. Uten sjekken ville feltoppslagene under kastet TypeError og gitt
  // 500 der 400 er det riktige svaret.
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object") throw new Error("Payloaden er ikke et objekt");

  return parsed as github.GithubPushPayload;
}

/**
 * Prosjektene som peker på dette repoet.
 *
 * `ilike` finner kandidatene, men avgjør ikke: mønsteret treffer for bredt
 * (`%eier/app%` matcher også `eier/app-docs`), og `_` i et repo-navn er et
 * jokertegn for `ilike`. Den endelige sammenligningen skjer derfor på
 * normalformen fra `repoIdentity()` i JS, der `eier/app` er `eier/app` og
 * ingenting annet.
 *
 * Flere prosjekter kan peke på samme repo – to brukere i samme organisasjon,
 * ett repo deployet under to slugs, eller `main` og `dev` side om side på hvert
 * sitt subdomene. Alle kandidatene hentes her; `isDeployBranch()` avgjør etterpå
 * hvem av dem den pushede grenen faktisk angår.
 */
async function projectsForRepository(fullName: string): Promise<Project[]> {
  const wanted = github.repoIdentity(fullName);
  if (!wanted) return [];

  const { data, error } = await supabase.from("projects").select("*").ilike("repo_url", `%${fullName}%`);

  if (error) throw new Error(`Databasefeil: ${error.message}`);

  return ((data ?? []) as Project[]).filter((project) => github.repoIdentity(project.repo_url) === wanted);
}

type TriggerStatus = "deploying" | "already_building" | "failed";

interface TriggerResult {
  projectId: string;
  project: string;
  status: TriggerStatus;
  deploymentId?: string;
  message?: string;
}

githubWebhooks.post(
  "/github",
  bodyLimit({
    maxSize: MAX_BODY_BYTES,
    onError: (c) => c.json({ error: "Payloaden er for stor" }, 413),
  }),
  async (c) => {
    const event = c.req.header("x-github-event") ?? "ukjent";
    const log = logger.child({
      webhook: "github",
      event,
      // GitHub sin egen ID for leveringen. Den står i leveringsloggen på
      // github.com, og er dermed limet mellom deres side og våre logger.
      delivery: c.req.header("x-github-delivery") ?? "ukjent",
    });

    // Råkroppen, ikke en reserialisert variant – signaturen er regnet over
    // nøyaktig disse bytene.
    const body = Buffer.from(await c.req.arrayBuffer());

    if (github.isWebhookSecretConfigured()) {
      if (!github.verifyWebhookSignature(body, c.req.header("x-hub-signature-256"))) {
        log.warn("Avviste webhook: signaturen stemmer ikke");
        return c.json({ error: "Ugyldig signatur" }, 401);
      }
    } else {
      // Uten secret er dette et åpent endepunkt som starter builds. Vi tar den
      // imot for at oppsettet skal kunne prøves ut, men det skal stå i loggen.
      log.warn("GITHUB_WEBHOOK_SECRET er ikke satt – webhooken tas imot uverifisert");
    }

    // GitHub sender `ping` når webhooken opprettes, og fra «Redeliver»-knappen.
    // Et 2xx-svar her er det som gir den grønne huken i leveringsloggen.
    if (event === "ping") {
      log.info("Ping fra GitHub – webhooken er koblet til");
      return c.json({ received: true, message: "pong" });
    }

    if (event !== "push") {
      // App-en får alle eventene installasjonen abonnerer på. Resten er ikke en
      // feil – de er bare ikke vårt bord ennå.
      return c.json({ received: true, ignored: true, message: `Ignorerer «${event}»-event` });
    }

    let payload: github.GithubPushPayload;
    try {
      payload = parsePayload(body, c.req.header("content-type"));
    } catch (error) {
      log.warn({ err: error }, "Kunne ikke tolke webhook-payloaden");
      return c.json({ error: "Kunne ikke tolke payloaden" }, 400);
    }

    const fullName = payload.repository?.full_name;
    if (!fullName) {
      log.warn("Push-event uten repository.full_name");
      return c.json({ error: "Payloaden mangler repository.full_name" }, 400);
    }

    const branch = github.branchFromRef(payload.ref);

    // Tags bygger vi ikke fra, og en slettet gren har ingen kode å bygge.
    if (!branch || payload.deleted) {
      log.info({ repository: fullName, ref: payload.ref }, "Ignorerer push som ikke er til en levende gren");
      return c.json({
        received: true,
        ignored: true,
        message: `Ignorerer ref «${payload.ref ?? "ukjent"}»`,
      });
    }

    // Grensjekken kommer *etter* prosjektoppslaget, ikke før. Kriteriet er
    // «prosjektets valgte gren», og det kjenner vi ikke uten radene. Prisen er
    // én databasespørring også for pusher vi ender med å ignorere; alternativet
    // var å låse hele plattformen til repoets default branch.
    try {
      const projects = await projectsForRepository(fullName);

      if (projects.length === 0) {
        // Helt normalt: App-en ser alle repoene i installasjonen, også de som
        // aldri er lagt til i Snoat.
        log.info({ repository: fullName }, "Ingen prosjekter peker på dette repoet");
        return c.json({
          received: true,
          ignored: true,
          message: `Ingen Snoat-prosjekter bruker ${fullName}`,
        });
      }

      // Hvem av dem deployer fra grenen som ble pushet? De øvrige er ikke en
      // feil og ikke noe å rapportere – de bygger bare fra en annen gren.
      const matched = projects.filter((project) =>
        isDeployBranch(branch, project, payload.repository?.default_branch),
      );

      if (matched.length === 0) {
        log.info(
          { repository: fullName, branch, candidates: projects.length },
          "Push til en gren ingen av prosjektene deployer fra",
        );
        return c.json({
          received: true,
          ignored: true,
          message: `Ingen prosjekter som bruker ${fullName} deployer fra «${branch}»`,
        });
      }

      const results: TriggerResult[] = [];

      for (const project of matched) {
        // Sjekken gir en presis melding for det vanlige tilfellet – en push som
        // kommer mens forrige build fortsatt kjører. Det er `startDeployment`
        // som er den reelle låsen; den kaster hvis vi kappløper med den.
        if (deploy.isDeploying(project.id)) {
          results.push({
            projectId: project.id,
            project: project.name,
            status: "already_building",
            message: "Bygges allerede – denne pushen bygges ikke på nytt",
          });
          continue;
        }

        try {
          const deployment = await deploy.startDeployment(project);
          results.push({
            projectId: project.id,
            project: project.name,
            status: "deploying",
            deploymentId: deployment.id,
          });
        } catch (error) {
          // Én prosjektfeil skal ikke stoppe de øvrige treffene.
          const message = error instanceof Error ? error.message : String(error);
          log.error({ err: error, project: project.name }, "Kunne ikke starte deployment fra webhook");
          results.push({ projectId: project.id, project: project.name, status: "failed", message });
        }
      }

      const count = (status: TriggerStatus) => results.filter((r) => r.status === status).length;
      const parts: string[] = [];
      if (count("deploying")) parts.push(`${count("deploying")} deployment startet`);
      if (count("already_building")) parts.push(`${count("already_building")} bygges allerede`);
      if (count("failed")) parts.push(`${count("failed")} kunne ikke startes`);

      log.info(
        {
          repository: fullName,
          branch,
          commit: payload.after?.slice(0, 7),
          installation: payload.installation?.id,
          pusher: payload.pusher?.name,
          // Prosjekter som bruker repoet, og de av dem som deployer fra denne
          // grenen. Er de ulike, er det fordi noen har valgt en annen gren.
          candidates: projects.length,
          matched: results.length,
          started: count("deploying"),
        },
        "Push mottatt fra GitHub",
      );

      // 202, også når alt ble hoppet over fordi en build allerede kjørte: det er
      // en forventet tilstand, ikke en leveringsfeil. En 409 hadde bare farget
      // leveringen rød hos GitHub uten at noen skal gjøre noe med den.
      return c.json(
        {
          received: true,
          repository: fullName,
          branch,
          message: `${fullName}@${branch}: ${parts.join(", ")}`,
          results,
        },
        202,
      );
    } catch (error) {
      // Typisk en utilgjengelig database. GitHub viser leveringen som feilet,
      // og «Redeliver» er da riktig måte å prøve igjen på.
      log.error({ err: error, repository: fullName, branch }, "Kunne ikke behandle push-eventet");
      return c.json({ error: "Kunne ikke behandle eventet" }, 500);
    }
  },
);
