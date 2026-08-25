import { createHmac, createSign, timingSafeEqual } from "node:crypto";
import { config } from "../config.js";
import { logger } from "./logger.js";

/**
 * Klient mot GitHub som en GitHub App.
 *
 * Vi bruker App-modellen framfor en OAuth-app fordi den passer produktløftet:
 * brukeren velger selv *hvilke* repoer Snoat får se, tilgangen er lesetilgang
 * til innhold, og vi slipper å oppbevare et langlevd token som gir skrivetilgang
 * til alt vedkommende eier.
 *
 * Autentiseringen skjer i to steg:
 *
 *   1. App-JWT   – signert med App-ens private nøkkel, lever i 10 minutter.
 *                  Brukes kun til å be om installasjonstokens.
 *   2. Installasjonstoken – kortlevd (én time), scopet til én installasjon.
 *                  Brukes til alle faktiske API-kall og til git clone.
 *
 * Ingen av delene lagres i databasen. Vi kjenner bare installasjons-ID-en.
 */

const GITHUB_API = "https://api.github.com";

/** Snoat-navn på et repository, slik frontend viser det. */
export interface GithubRepo {
  id: number;
  name: string;
  fullName: string;
  private: boolean;
  cloneUrl: string;
  defaultBranch: string;
  updatedAt: string | null;
  installationId: number;
}

export interface GithubInstallationAccount {
  installationId: number;
  accountLogin: string;
  accountType: string;
}

export class GithubError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "GithubError";
  }
}

/**
 * Er App-en konfigurert?
 *
 * Integrasjonen er valgfri, på samme måte som GitHub-innlogging. Er den ikke
 * satt opp, svarer endepunktene at den er utilgjengelig i stedet for å krasje,
 * og brukeren limer inn en URL som før.
 */
export function isConfigured(): boolean {
  return Boolean(config.GITHUB_APP_ID && config.GITHUB_APP_PRIVATE_KEY && config.GITHUB_APP_SLUG);
}

function requireConfig(): { appId: string; privateKey: string; slug: string } {
  if (!isConfigured()) {
    throw new GithubError(503, "GitHub-integrasjonen er ikke konfigurert på denne installasjonen");
  }

  // Nøkkelen ligger base64-kodet i miljøet. En PEM inneholder linjeskift, og de
  // overlever verken .env-filer eller docker-compose uten kluss.
  const privateKey = Buffer.from(config.GITHUB_APP_PRIVATE_KEY!, "base64").toString("utf8");

  if (!privateKey.includes("PRIVATE KEY")) {
    throw new GithubError(
      500,
      "GITHUB_APP_PRIVATE_KEY ser ikke ut som en base64-kodet PEM. Kjør: base64 -i <nøkkel>.pem",
    );
  }

  return { appId: config.GITHUB_APP_ID!, privateKey, slug: config.GITHUB_APP_SLUG! };
}

const b64url = (input: Buffer | string) =>
  Buffer.from(input).toString("base64url");

/**
 * Signerer App-JWT-en GitHub krever for app-nivå-kall.
 *
 * `iat` settes ett minutt tilbake med vilje – GitHub avviser tokens som ser ut
 * til å komme fra framtiden, og klokkene er sjelden helt like.
 */
function appJwt(): string {
  const { appId, privateKey } = requireConfig();
  const now = Math.floor(Date.now() / 1000);

  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = b64url(JSON.stringify({ iat: now - 60, exp: now + 540, iss: appId }));

  const signature = createSign("RSA-SHA256")
    .update(`${header}.${payload}`)
    .sign(privateKey)
    .toString("base64url");

  return `${header}.${payload}.${signature}`;
}

async function githubFetch<T>(path: string, token: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${GITHUB_API}${path}`, {
    ...init,
    headers: {
      ...init.headers,
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "snoat",
    },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new GithubError(
      response.status,
      `GitHub ${init.method ?? "GET"} ${path} feilet (${response.status}): ${body.slice(0, 200)}`,
    );
  }

  return (await response.json()) as T;
}

// --- Installasjonstokens ----------------------------------------------------

interface CachedToken {
  token: string;
  expiresAt: number;
}

const tokenCache = new Map<number, CachedToken>();

/**
 * Henter et installasjonstoken, med cache.
 *
 * Tokenet lever i én time. Vi fornyer fem minutter før utløp, slik at en lang
 * `git clone` ikke får tokenet revet vekk under seg midtveis.
 */
export async function installationToken(installationId: number): Promise<string> {
  const cached = tokenCache.get(installationId);
  if (cached && cached.expiresAt - Date.now() > 5 * 60 * 1000) {
    return cached.token;
  }

  const result = await githubFetch<{ token: string; expires_at: string }>(
    `/app/installations/${installationId}/access_tokens`,
    appJwt(),
    { method: "POST" },
  );

  tokenCache.set(installationId, {
    token: result.token,
    expiresAt: Date.parse(result.expires_at),
  });

  return result.token;
}

/** Glemmer et cachet token. Brukes når en installasjon viser seg å være borte. */
export function forgetInstallation(installationId: number): void {
  tokenCache.delete(installationId);
}

// --- Oppslag ----------------------------------------------------------------

interface InstallationResponse {
  id: number;
  account: { login: string; type: string } | null;
}

/**
 * Bekrefter at en installasjon finnes, og henter kontoen den tilhører.
 *
 * Kalles før vi lagrer koblingen: `installation_id` kommer fra en redirect i
 * nettleseren, og skal ikke tas for god fisk bare fordi state-signaturen holdt.
 */
export async function getInstallation(installationId: number): Promise<GithubInstallationAccount> {
  const data = await githubFetch<InstallationResponse>(
    `/app/installations/${installationId}`,
    appJwt(),
  );

  return {
    installationId: data.id,
    accountLogin: data.account?.login ?? "ukjent",
    accountType: data.account?.type ?? "User",
  };
}

interface RepositoriesResponse {
  total_count: number;
  repositories: Array<{
    id: number;
    name: string;
    full_name: string;
    private: boolean;
    clone_url: string;
    default_branch: string;
    updated_at: string | null;
  }>;
}

/** Maks antall sider vi henter. 100 per side holder for enhver rimelig konto. */
const MAX_PAGES = 10;

/**
 * Repoene brukeren har gitt Snoat tilgang til gjennom denne installasjonen.
 *
 * Returnerer tom liste hvis installasjonen er fjernet på GitHub-siden – da har
 * raden vår blitt foreldet, og kalleren rydder den bort.
 */
export async function listRepositories(installationId: number): Promise<GithubRepo[]> {
  const token = await installationToken(installationId);
  const repos: GithubRepo[] = [];

  for (let page = 1; page <= MAX_PAGES; page++) {
    const data = await githubFetch<RepositoriesResponse>(
      `/installation/repositories?per_page=100&page=${page}`,
      token,
    );

    for (const repo of data.repositories) {
      repos.push({
        id: repo.id,
        name: repo.name,
        fullName: repo.full_name,
        private: repo.private,
        cloneUrl: repo.clone_url,
        defaultBranch: repo.default_branch,
        updatedAt: repo.updated_at,
        installationId,
      });
    }

    if (repos.length >= data.total_count || data.repositories.length === 0) break;
  }

  return repos;
}

interface BranchResponse {
  name: string;
}

export interface RepoBranches {
  /** Grenen GitHub bruker når ingen er valgt. Det Snoat gjør med NULL. */
  defaultBranch: string;
  branches: string[];
}

/**
 * Grenene i ett repo, slik dashboardet kan tilby en liste å velge fra.
 *
 * Uten denne måtte grenvalget vært et fritekstfelt, og et fritekstfelt for et
 * navn som må stemme tegn for tegn med noe på GitHub er en skrivefeil som først
 * viser seg som en feilet build. Med lista er valget et valg.
 *
 * `defaultBranch` er med fordi det er den grenen «ingen gren valgt» faktisk
 * betyr. Skal dashboardet kunne skrive *hvilken* gren standardvalget er, må det
 * vite navnet – ellers står det bare «standardgren», og brukeren må gjette.
 *
 * `owner/repo` legges i stien, så verdien må være et par enkle segmenter – vi
 * bruker normalformen fra `repoIdentity()` og ikke noe brukeren har skrevet.
 * `MAX_PAGES` er samme tak som for repo-listen: 1000 grener er langt mer enn en
 * nedtrekksliste er nyttig for.
 */
export async function listBranches(installationId: number, repo: string): Promise<RepoBranches> {
  const identity = repoIdentity(repo);
  if (!identity) throw new GithubError(400, `Ukjent repository: ${repo}`);

  const token = await installationToken(installationId);

  // Rekkefølgen er ikke tilfeldig: dette kallet er også tilgangssjekken. Rekker
  // ikke installasjonen repoet, svarer GitHub 404 her, og vi slipper å hente en
  // grenliste vi ikke har lov til å se.
  const repository = await githubFetch<{ default_branch?: string }>(
    `/repos/${identity}`,
    token,
  );

  const branches: string[] = [];

  for (let page = 1; page <= MAX_PAGES; page++) {
    const data = await githubFetch<BranchResponse[]>(
      `/repos/${identity}/branches?per_page=100&page=${page}`,
      token,
    );

    for (const branch of data) branches.push(branch.name);

    // GitHub sender ingen totalsum for grener, så en side som ikke er full er
    // den eneste stoppbetingelsen vi har.
    if (data.length < 100) break;
  }

  return { defaultBranch: repository.default_branch ?? "main", branches };
}

// --- Installasjonsflyt ------------------------------------------------------

/**
 * URL-en «Koble til GitHub» sender brukeren til.
 *
 * `state` er en HMAC-signert referanse til Snoat-brukeren. GitHub sender den
 * uendret tilbake til Setup-URL-en, og det er slik vi vet hvem installasjonen
 * hører til – uten å måtte holde på en midlertidig rad i databasen.
 */
export function installUrl(userId: string): string {
  const { slug } = requireConfig();
  return `https://github.com/apps/${slug}/installations/new?state=${encodeURIComponent(signState(userId))}`;
}

const STATE_TTL_MS = 30 * 60 * 1000;

function stateSecret(): string {
  if (!config.GITHUB_APP_STATE_SECRET) {
    throw new GithubError(500, "GITHUB_APP_STATE_SECRET mangler");
  }
  return config.GITHUB_APP_STATE_SECRET;
}

export function signState(userId: string): string {
  const payload = b64url(JSON.stringify({ userId, ts: Date.now() }));
  const signature = createHmac("sha256", stateSecret()).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

/**
 * Verifiserer state fra GitHub-redirecten og henter ut bruker-ID-en.
 *
 * Uten denne kunne hvem som helst kalt Setup-URL-en med en vilkårlig
 * `installation_id` og knyttet andres repoer til sin egen konto.
 */
export function verifyState(state: string): string | null {
  const [payload, signature] = state.split(".");
  if (!payload || !signature) return null;

  const expected = createHmac("sha256", stateSecret()).update(payload).digest("base64url");
  const given = Buffer.from(signature);
  const want = Buffer.from(expected);

  if (given.length !== want.length || !timingSafeEqual(given, want)) {
    logger.warn("GitHub setup: ugyldig state-signatur");
    return null;
  }

  try {
    const { userId, ts } = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
      userId?: string;
      ts?: number;
    };

    if (!userId || typeof ts !== "number" || Date.now() - ts > STATE_TTL_MS) return null;
    return userId;
  } catch {
    return null;
  }
}

// --- Kloning ----------------------------------------------------------------

/**
 * Bygger en klone-URL med installasjonstoken.
 *
 * Formatet `x-access-token:<token>@` er GitHub sin egen konvensjon for
 * installasjonstokens over HTTPS.
 *
 * ADVARSEL: den returnerte URL-en er en hemmelighet. Den må aldri logges –
 * `services/git.ts` logger den redigerte varianten i stedet.
 */
export async function authenticatedCloneUrl(
  repoUrl: string,
  installationId: number,
): Promise<string> {
  const token = await installationToken(installationId);
  const url = new URL(repoUrl);
  url.username = "x-access-token";
  url.password = token;
  return url.toString();
}

// --- Webhooks ---------------------------------------------------------------

/**
 * Feltene vi bruker fra et `push`-event. GitHub sender langt mer enn dette;
 * typen speiler bevisst bare det `routes/webhooks.ts` faktisk leser, og alt er
 * valgfritt fordi payloaden kommer utenfra og ikke kan tas for gitt.
 */
export interface GithubPushPayload {
  /** Full ref, f.eks. `refs/heads/main`. */
  ref?: string;
  /** Commit-en grenen peker på etter pushen. */
  after?: string;
  /** `true` når pushen slettet grenen. Da finnes det ingen kode å bygge. */
  deleted?: boolean;
  repository?: {
    full_name?: string;
    clone_url?: string;
    default_branch?: string;
  };
  /** Installasjonen eventet kom gjennom. Finnes på App-webhooks. */
  installation?: { id?: number };
  pusher?: { name?: string };
}

/** Er webhook-secreten satt? Uten den kan vi ikke verifisere signaturer. */
export function isWebhookSecretConfigured(): boolean {
  return Boolean(config.GITHUB_WEBHOOK_SECRET);
}

/**
 * Verifiserer `x-hub-signature-256` mot råkroppen av forespørselen.
 *
 * HMAC-en må regnes over de rå bytene GitHub sendte – ikke over noe vi har
 * parset og serialisert på nytt. `JSON.stringify` gir ikke nødvendigvis samme
 * bytes tilbake (nøkkelrekkefølge, unicode-escaping), og da hadde hver eneste
 * signatur feilet.
 *
 * Sammenligningen er `timingSafeEqual`, som ellers i kodebasen: en `===` på
 * signaturer lekker hvor langt en angriper har gjettet riktig.
 */
export function verifyWebhookSignature(body: Buffer, header: string | undefined): boolean {
  const secret = config.GITHUB_WEBHOOK_SECRET;
  if (!secret || !header) return false;

  const expected = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
  const given = Buffer.from(header);
  const want = Buffer.from(expected);

  return given.length === want.length && timingSafeEqual(given, want);
}

const BRANCH_REF_PREFIX = "refs/heads/";

/**
 * Grennavnet i en push-ref, eller `null` hvis refen ikke er en gren.
 *
 * GitHub sender `push` også for tags (`refs/tags/v1`), som vi ikke deployer fra.
 */
export function branchFromRef(ref: string | undefined): string | null {
  if (!ref?.startsWith(BRANCH_REF_PREFIX)) return null;
  return ref.slice(BRANCH_REF_PREFIX.length) || null;
}

/**
 * Verten må være github.com.
 *
 * Uten sjekken kunne en webhook for `github.com/eier/app` trigget en deployment
 * av `gitlab.com/eier/app` – samme `owner/repo`, helt annen kode. Vi snakker kun
 * med api.github.com, så GitHub Enterprise-verter hører ikke hjemme her.
 */
function isGithubHost(host: string): boolean {
  const name = host.split("@").pop()!.split(":")[0]!.toLowerCase();
  return name === "github.com" || name === "www.github.com";
}

/**
 * Normaliserer et repository til `owner/repo` med små bokstaver.
 *
 * Godtar både en klone-URL og `full_name` fra en webhook-payload, og det er
 * hele poenget: `projects.repo_url` skrives like ofte av et menneske som av
 * repo-velgeren, så den finnes i alle varianter – med og uten `.git`, med og
 * uten skråstrek til slutt, med `/tree/main` hengende på, med vilkårlig store
 * bokstaver. Webhooken kjenner bare `full_name`. Denne normalformen er det som
 * lar de to møtes.
 *
 * Returnerer `null` for verdier vi ikke kjenner igjen. Da matcher vi ingenting,
 * i stedet for å gjette og deploye feil prosjekt.
 */
export function repoIdentity(value: string): string | null {
  // Query og fragment først: «…/app?tab=readme» skal ikke bli en del av navnet.
  let rest = value.trim().split(/[?#]/)[0]!;

  const schemeEnd = rest.indexOf("://");
  if (schemeEnd !== -1) {
    const hostAndPath = rest.slice(schemeEnd + 3);
    const pathStart = hostAndPath.indexOf("/");
    if (pathStart === -1) return null;
    if (!isGithubHost(hostAndPath.slice(0, pathStart))) return null;
    rest = hostAndPath.slice(pathStart + 1);
  }

  const segments = rest
    .replace(/\/+$/, "")
    .replace(/\.git$/i, "")
    .split("/")
    .filter(Boolean);

  const [owner, repo] = segments;
  if (!owner || !repo) return null;

  return `${owner}/${repo}`.toLowerCase();
}
