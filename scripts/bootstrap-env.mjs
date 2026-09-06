#!/usr/bin/env node
/**
 * Genererer .env for Snoat-plattformen – både lokalt og i produksjon.
 *
 * Vi genererer JWT-nøklene selv (i stedet for å bruke Supabase sine publiserte
 * demo-nøkler) slik at hver installasjon har unike hemmeligheter fra dag én.
 *
 *   node scripts/bootstrap-env.mjs                       # dev (snoat.localhost)
 *   SNOAT_DOMAIN=snoat.com node scripts/bootstrap-env.mjs # produksjon
 *   node scripts/bootstrap-env.mjs --force               # nye hemmeligheter
 *
 * Scriptet er **idempotent**: finnes .env fra før, beholdes alle hemmeligheter
 * og operatør-innstillinger, mens de domeneavledede verdiene regnes ut på nytt.
 * Det er dette som gjør at deploy-scriptet trygt kan kjøre det på serveren –
 * uten å bytte JWT_SECRET og POSTGRES_PASSWORD under føttene på en database
 * som allerede er initialisert.
 *
 * `--force` regenererer også hemmelighetene. Da må databasen tømmes
 * (`docker compose down -v`), siden rollepassordene kun settes ved initdb.
 */
import { execFileSync } from "node:child_process";
import { createHmac, randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const envPath = path.join(rootDir, ".env");
const frontendEnvPath = path.join(rootDir, "frontend/.env");
const force = process.argv.includes("--force");

const b64url = (input) =>
  Buffer.from(input).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** Signerer et Supabase-kompatibelt HS256 JWT for en gitt Postgres-rolle. */
const signJwt = (payload, secret) => {
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = b64url(JSON.stringify(payload));
  const signature = createHmac("sha256", secret).update(`${header}.${body}`).digest("base64url");
  return `${header}.${body}.${signature}`;
};

/**
 * Finner den faktiske Docker-socketen.
 *
 * Docker Desktop på macOS legger den under ~/.docker/run/ med mindre man har
 * huket av «Allow the default Docker socket to be used». Backend må montere den
 * riktige stien for at Dockerode og nixpacks skal nå daemonen. På en Linux-VPS
 * gir dette /var/run/docker.sock – derfor må verdien alltid regnes ut på nytt
 * på maskinen som faktisk skal kjøre stacken.
 */
const detectDockerSocket = () => {
  const fallback = "/var/run/docker.sock";
  try {
    const host = execFileSync(
      "docker",
      ["context", "inspect", "--format", "{{.Endpoints.docker.Host}}"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
    return host.startsWith("unix://") ? host.slice("unix://".length) : fallback;
  } catch {
    return fallback;
  }
};

/** Leser en eksisterende .env til et enkelt nøkkel/verdi-oppslag. */
const readEnvFile = (file) => {
  if (!existsSync(file)) return {};
  const result = {};
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (match) result[match[1]] = match[2];
  }
  return result;
};

// ---------------------------------------------------------------------------
// Domene
// ---------------------------------------------------------------------------
// Alt henger sammen: Caddy ruter `<domene>` til frontend og `api.<domene>` til
// Kong (/auth, /rest, /realtime, /storage) og backend (alt annet). Derfor er
// det ett domene som styrer både GoTrue, CORS og VITE_-variablene.

const domain = (process.env.SNOAT_DOMAIN ?? "snoat.localhost").trim().replace(/^\.+|\.+$/g, "");
const isLocal = domain === "localhost" || domain.endsWith(".localhost");
const scheme = isLocal ? "http" : "https";

const apiUrl = `${scheme}://api.${domain}`;

// Lokalt kjører dashboardet på Vite sin dev-server, ikke gjennom Caddy.
const siteUrl = isLocal ? "http://localhost:8080" : `${scheme}://${domain}`;
const redirectUrls = isLocal
  ? "http://localhost:8080/**,http://localhost:3000/**,http://snoat.localhost/**"
  : `${scheme}://${domain}/**`;
const frontendOrigin = isLocal
  ? `http://localhost:8080,http://${domain}`
  : `${scheme}://${domain}`;

// Backend kjører med hot reload lokalt og som bygget artefakt i produksjon.
const backendTarget = isLocal ? "dev" : "production";

const existing = force ? {} : readEnvFile(envPath);
const preserved = (key, fallback, isValid = (value) => value !== "") => {
  const value = existing[key];
  return value === undefined || !isValid(value) ? fallback : value;
};

// IP-en kundene peker sitt eget domene mot med en A-record, og som DNS-fanen i
// dashboardet viser fram. Kan settes med SNOAT_SERVER_IP=… foran kommandoen;
// ellers beholdes verdien som allerede står i .env. Lokalt gir loopback det
// riktige svaret: da er det maskinen din Caddy kjører på.
const serverIp = (
  process.env.SNOAT_SERVER_IP ??
  preserved("SNOAT_SERVER_IP", isLocal ? "127.0.0.1" : "38.87.117.167")
).trim();

// Realtime bruker DB_ENC_KEY som AES-128-nøkkel og krever nøyaktig 16 byte.
// 32 hex-tegn gir «Erlang error: {:badarg, 'Bad key size'}» i en restart-loop.
// 12 tilfeldige byte blir 16 base64url-tegn.
const isEncKey = (value) => value.length === 16;

// Hemmeligheter genereres kun når de mangler. Bytter vi dem på en initialisert
// database, slutter Postgres-rollene og alle utstedte tokens å virke.
const jwtSecret = preserved("JWT_SECRET", randomBytes(48).toString("base64url"));
const postgresPassword = preserved("POSTGRES_PASSWORD", randomBytes(24).toString("base64url"));

const issuedAt = Math.floor(Date.now() / 1000);
const expiresAt = issuedAt + 60 * 60 * 24 * 365 * 10; // 10 år – service-nøkler, ikke brukersesjoner
const anonKey = preserved(
  "ANON_KEY",
  signJwt({ role: "anon", iss: "supabase", iat: issuedAt, exp: expiresAt }, jwtSecret),
);
const serviceRoleKey = preserved(
  "SERVICE_ROLE_KEY",
  signJwt({ role: "service_role", iss: "supabase", iat: issuedAt, exp: expiresAt }, jwtSecret),
);

const env = `# ---------------------------------------------------------------------------
# Snoat – miljøvariabler for ${domain}
# Autogenerert av scripts/bootstrap-env.mjs. IKKE sjekk denne filen inn i git,
# og IKKE kopier den mellom maskiner – hemmelighetene hører til databasen som
# står på den maskinen.
# ---------------------------------------------------------------------------

COMPOSE_PROJECT_NAME=snoat

# Utviklerverktøyene (studio + meta) ligger bak «studio»-profilen og starter kun
# når denne er satt. Tom i produksjon med vilje – de bruker ~250 MB som en liten
# boks heller bør gi til byggejobber. Sett COMPOSE_PROFILES=studio lokalt.
COMPOSE_PROFILES=${preserved("COMPOSE_PROFILES", "")}

# --- Arbeidsområde for builds -----------------------------------------------
# MÅ være en absolutt sti som er identisk på host og inne i backend-containeren.
# Nixpacks kaller Docker-daemonen på hosten, så daemonen må kunne se den samme
# stien som backend-prosessen sender med som build-context.
SNOAT_WORKSPACE_DIR=${path.join(rootDir, ".snoat/workspaces")}

# --- Docker ------------------------------------------------------------------
# Host-stien til Docker-socketen (autodetektert fra 'docker context').
DOCKER_SOCKET_PATH=${detectDockerSocket()}
BACKEND_BUILD_TARGET=${backendTarget}

# --- Domener ----------------------------------------------------------------
SNOAT_DOMAIN=${domain}
SNOAT_ROOT_DOMAIN=${domain}
SNOAT_APP_DOMAIN_SUFFIX=.${domain}
# A-record-målet kundene peker sine egne domener mot (vises i DNS-fanen).
SNOAT_SERVER_IP=${serverIp}

# --- Postgres ---------------------------------------------------------------
POSTGRES_HOST=db
POSTGRES_PORT=5432
POSTGRES_DB=${preserved("POSTGRES_DB", "postgres")}
POSTGRES_PASSWORD=${postgresPassword}

# --- Supabase-nøkler --------------------------------------------------------
JWT_SECRET=${jwtSecret}
JWT_EXPIRY=${preserved("JWT_EXPIRY", "3600")}
ANON_KEY=${anonKey}
SERVICE_ROLE_KEY=${serviceRoleKey}

# --- Supabase URL-er --------------------------------------------------------
# api.<domene> er felles inngang: Caddy sender /auth, /rest, /realtime og
# /storage til Kong, og alt annet til Snoat-backend.
SITE_URL=${siteUrl}
ADDITIONAL_REDIRECT_URLS=${redirectUrls}
API_EXTERNAL_URL=${apiUrl}
SUPABASE_PUBLIC_URL=${apiUrl}

# --- GoTrue (auth) ----------------------------------------------------------
DISABLE_SIGNUP=${preserved("DISABLE_SIGNUP", "false")}
ENABLE_EMAIL_SIGNUP=${preserved("ENABLE_EMAIL_SIGNUP", "true")}
# Skal stå false. Autoconfirm markerer e-poster som bekreftet uten at noen
# beviser eierskap, og åpner en account takeover-vektor – se 08_security_model.md.
ENABLE_EMAIL_AUTOCONFIRM=${preserved("ENABLE_EMAIL_AUTOCONFIRM", "false")}
ENABLE_ANONYMOUS_USERS=${preserved("ENABLE_ANONYMOUS_USERS", "false")}

# --- E-post (Resend) --------------------------------------------------------
# GoTrue sender bekreftelse- og gjenopprettingse-post over SMTP. Brukernavnet er
# alltid literalen "resend"; passordet er API-nøkkelen. Avsenderdomenet må være
# verifisert på https://resend.com/domains.
SMTP_HOST=${preserved("SMTP_HOST", "smtp.resend.com")}
SMTP_PORT=${preserved("SMTP_PORT", "587")}
SMTP_USER=${preserved("SMTP_USER", "resend")}
RESEND_API_KEY=${preserved("RESEND_API_KEY", "")}
SMTP_ADMIN_EMAIL=${preserved("SMTP_ADMIN_EMAIL", "")}
SMTP_SENDER_NAME=${preserved("SMTP_SENDER_NAME", "Snoat")}
SMTP_MAX_FREQUENCY=${preserved("SMTP_MAX_FREQUENCY", "60s")}

# Interne varsler til drift (ny app live på plattformen). Bruker samme
# RESEND_API_KEY som SMTP over, men Resend sitt HTTP-API i stedet for SMTP.
# Står SNOAT_NOTIFY_TO tom, sendes ingenting – varselet blir en linje i loggen.
SNOAT_NOTIFY_FROM=${preserved("SNOAT_NOTIFY_FROM", `Snoat <varsel@${domain}>`)}
SNOAT_NOTIFY_TO=${preserved("SNOAT_NOTIFY_TO", "")}

# GitHub OAuth – fyll inn fra https://github.com/settings/developers
# Homepage URL:               ${siteUrl}
# Authorization callback URL: ${apiUrl}/auth/v1/callback
GITHUB_OAUTH_ENABLED=${preserved("GITHUB_OAUTH_ENABLED", "false")}
GITHUB_CLIENT_ID=${preserved("GITHUB_CLIENT_ID", "")}
GITHUB_CLIENT_SECRET=${preserved("GITHUB_CLIENT_SECRET", "")}

# --- GitHub App (repo-velger + private repoer) ------------------------------
# Egen App fra https://github.com/settings/apps – ikke det samme som OAuth-appen
# over. Registrer med:
#   Callback URL:            ${siteUrl}/auth/callback
#   Setup URL:               ${apiUrl}/github/setup   (huk av «Redirect on update»)
#   Webhook URL:             ${apiUrl}/api/webhooks/github   (event: Push)
#   Permissions:             Repository → Contents: Read-only, Metadata: Read-only
# Den private nøkkelen må base64-kodes, siden en PEM har linjeskift:
#   base64 -i snoat.private-key.pem
GITHUB_APP_ID=${preserved("GITHUB_APP_ID", "")}
GITHUB_APP_SLUG=${preserved("GITHUB_APP_SLUG", "")}
GITHUB_APP_PRIVATE_KEY=${preserved("GITHUB_APP_PRIVATE_KEY", "")}
GITHUB_APP_STATE_SECRET=${preserved("GITHUB_APP_STATE_SECRET", randomBytes(32).toString("base64url"))}
# Automatisk deploy ved push. Dette er den eneste hemmeligheten her som *deles*
# med GitHub – den må være identisk med «Webhook secret» på App-en, så den kan
# ikke genereres her. Generer én med \`openssl rand -hex 32\`, lim den inn begge
# steder. Står den tom, tas webhooks imot uten signaturkontroll, og hvem som helst
# kan starte builds: se CONTEXT_FOR_AI/08_security_model.md.
GITHUB_WEBHOOK_SECRET=${preserved("GITHUB_WEBHOOK_SECRET", "")}

# --- Realtime ---------------------------------------------------------------
REALTIME_ENC_KEY=${preserved("REALTIME_ENC_KEY", randomBytes(12).toString("base64url"), isEncKey)}
REALTIME_SECRET_KEY_BASE=${preserved("REALTIME_SECRET_KEY_BASE", randomBytes(32).toString("hex"))}

# --- Snoat backend ----------------------------------------------------------
BACKEND_PORT=${preserved("BACKEND_PORT", "3100")}
CADDY_ADMIN_URL=${preserved("CADDY_ADMIN_URL", "http://caddy:2019")}
SNOAT_APPS_NETWORK=${preserved("SNOAT_APPS_NETWORK", "snoat_apps")}
SNOAT_FRONTEND_ORIGIN=${frontendOrigin}
LOG_LEVEL=${preserved("LOG_LEVEL", "info")}

# --- Frontend (Vite baker disse inn ved build) ------------------------------
VITE_SUPABASE_URL=${apiUrl}
VITE_SUPABASE_ANON_KEY=${anonKey}
VITE_SNOAT_API_URL=${apiUrl}
VITE_SNOAT_APP_DOMAIN_SUFFIX=.${domain}
VITE_SNOAT_SERVER_IP=${serverIp}

# --- Ressurstak per deployet applikasjon ------------------------------------
# Porten brukerapper må lytte på (injiseres som PORT i containeren).
SNOAT_APP_PORT=${preserved("SNOAT_APP_PORT", "3000")}
SNOAT_APP_MEMORY_MB=${preserved("SNOAT_APP_MEMORY_MB", "512")}
SNOAT_APP_CPUS=${preserved("SNOAT_APP_CPUS", "1")}
SNOAT_BUILD_TIMEOUT_MS=${preserved("SNOAT_BUILD_TIMEOUT_MS", "1800000")}
# Hvor lenge en ny container må ha kjørt sammenhengende før trafikken flyttes
# til den, og taket på ventingen. Se assertStillRunning() i containers.ts.
SNOAT_STABLE_FOR_MS=${preserved("SNOAT_STABLE_FOR_MS", "15000")}
SNOAT_STABLE_TIMEOUT_MS=${preserved("SNOAT_STABLE_TIMEOUT_MS", "90000")}
# Node-versjonen brukerprosjekter bygges med når repoet ikke oppgir en selv.
SNOAT_DEFAULT_NODE_VERSION=${preserved("SNOAT_DEFAULT_NODE_VERSION", "22")}
# Samtidige builds på hele verten, og heap-tak per build (MB).
SNOAT_MAX_CONCURRENT_BUILDS=${preserved("SNOAT_MAX_CONCURRENT_BUILDS", "1")}
SNOAT_BUILD_NODE_MEMORY_MB=${preserved("SNOAT_BUILD_NODE_MEMORY_MB", "8192")}
# Statiske sider serveres fra disk uten container (03_deployment_flow.md).
SNOAT_SITES_DIR=${preserved("SNOAT_SITES_DIR", "/srv/sites")}
# --- Stripe: abonnement og betaling ------------------------------------------
STRIPE_SECRET_KEY=${preserved("STRIPE_SECRET_KEY", "")}
STRIPE_WEBHOOK_SECRET=${preserved("STRIPE_WEBHOOK_SECRET", "")}
STRIPE_PRICE_PRO=${preserved("STRIPE_PRICE_PRO", "")}
STRIPE_PRICE_BUSINESS=${preserved("STRIPE_PRICE_BUSINESS", "")}
STRIPE_AUTOMATIC_TAX=${preserved("STRIPE_AUTOMATIC_TAX", "true")}
`;

writeFileSync(envPath, env, { mode: 0o600 });
console.log(`Skrev ${envPath} (domene: ${domain})`);

// Filen bygges fra malen over. Nøkler som fantes fra før, men som malen ikke
// kjenner til, forsvinner dermed stille – og det er nettopp variabler noen har
// lagt inn for hånd på serveren som er verdt å ikke miste. Vi sletter dem
// fortsatt (malen er fasit), men aldri uten å si fra.
const dropped = Object.keys(existing).filter((key) => !new RegExp(`^${key}=`, "m").test(env));

if (dropped.length > 0) {
  console.warn("\nADVARSEL: disse nøklene lå i .env, men finnes ikke i malen og er nå fjernet:");
  for (const key of dropped) console.warn(`  - ${key}`);
  console.warn("Legg dem inn i scripts/bootstrap-env.mjs hvis de skal overleve neste deploy.");
}

// Vite dev-serveren leser frontend/.env direkte. I Docker sendes de samme
// verdiene inn som build-args fra docker-compose, siden Vite baker VITE_-
// variabler inn i bundlen ved build – ikke ved oppstart.
writeFileSync(
  frontendEnvPath,
  `# Autogenerert av scripts/bootstrap-env.mjs – ikke rediger for hånd.
# Anon-nøkkelen er ment å være offentlig; RLS er det som beskytter dataene.
VITE_SUPABASE_URL=${apiUrl}
VITE_SUPABASE_ANON_KEY=${anonKey}
VITE_SNOAT_API_URL=${apiUrl}
VITE_SNOAT_APP_DOMAIN_SUFFIX=.${domain}
VITE_SNOAT_SERVER_IP=${serverIp}
`,
  { mode: 0o600 },
);
console.log(`Skrev ${frontendEnvPath}`);

if (force) {
  console.log("\n--force: nye JWT- og databasehemmeligheter er generert.");
  console.log("Kjør 'docker compose down -v' – rollepassordene settes kun ved initdb.");
}
