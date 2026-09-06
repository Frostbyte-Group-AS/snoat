# Overordnet Systemarkitektur

Prosjektet er bygget som et monorepo delt i to hovedkomponenter: `/frontend` og `/backend`. For å opprettholde kravet om datasuverenitet kjøres ingen eksterne skytjenester for kjernefunksjonalitet; alt er selvhostet på en felles 16 GB / 4 vCPU produksjonsserver (IP: `38.87.117.167`) som også drifter Supabase, Caddy, Coolify og brukerapplikasjonene.

## Teknologistakk

- **Frontend:** TanStack Start (React 19, Vite, TypeScript, Tailwind CSS v4). Håndterer landingssiden, brukerautentisering og applikasjonens dashboard ("Mine Prosjekter"). Rutene er filbaserte under `frontend/src/routes/`, og sesjonen håndteres klient-side av `@supabase/supabase-js` (PKCE-flyt mot GitHub OAuth).
- **Backend:** Node.js med TypeScript og Hono. Fungerer som selve bygge-motoren og API-laget for plattformen. Holder ingen egen database – all tilstand ligger i Supabase.
- **Database og Autentisering:** Selvhostet Supabase. Kjøres lokalt via Docker Compose i utviklingsmiljøet, og sikrer at all auth (GitHub OAuth) og relasjonsdata holdes internt.
- **Trafikkanalyse:** Førsteparts og logg-basert. Caddy eier proxy-laget for alle kundedomener, så hver forespørsel til hver app passerer oss allerede. Access-loggen strømmes over docker-nettet til backend, som beriker den, kaster IP-en og skriver ferdige aggregater til `analytics`-skjemaet i Supabase Postgres. Ingen sporingskode injiseres i kundens prosjekt, og ingen tredjepartstjeneste er involvert. Dashboardet har en «Statistikk»-fane med nøkkeltall, graf, toppsider, trafikkilder – og fordi kilden er en serverlogg: responstid, feilrate og båndbredde.

## Backend-moduler og Infrastruktur

- **Build Engine:** Nixpacks CLI (via child processes). Analyserer kildekode automatisk, detekterer rammeverk (Next.js, Vite, Python, etc.) og bygger optimaliserte OCI/Docker-bilder uten at brukeren trenger en Dockerfile.
- **Container Lifecycle:** dockerode (Node.js SDK for Docker). Brukes for å programmatisk starte, stoppe og overvåke containere.
- **Routing / Reverse Proxy:** Caddy. Håndterer dynamisk ruting av trafikk (f.eks. `*.snoat.localhost` i dev, eller `*.snoat.com` i prod). Backend kommuniserer direkte med Caddys REST API for å opprette nye ruter umiddelbart etter en vellykket build.

## Kjøretidstopologi

```
Nettleser ──▶ Caddy :80 ──┬──▶ backend :3000        (api.snoat.localhost)
                          ├──▶ Kong :8000           (supabase.snoat.localhost)
                          │      └─▶ GoTrue / PostgREST / Realtime
                          ├──▶ Studio :3000         (studio.snoat.localhost, kun dev)
                          └──▶ brukerapp-containere  (*.snoat.localhost)

GoTrue ──────▶ mail-templates :80  (henter e-postmaler over HTTP, internt)
       ──────▶ smtp.resend.com     (bekreftelse- og gjenopprettingse-post)

GitHub ──────▶ Caddy :80 ───▶ backend  (POST /api/webhooks/github ved push)
Stripe ──────▶ Caddy :80 ───▶ backend  (POST /api/webhooks/stripe ved abonnementsendring)

backend ──▶ Docker-daemon   (nixpacks build, dockerode run)
        ──▶ Caddy admin-API (ruter opprettes etter vellykket build)
        ──▶ Supabase        (prosjekter, deployments, logger)
        ──▶ api.github.com  (installasjonstokens, repo-listing)
```

Merk at GitHub er den eneste kilden til innkommende trafikk som **ikke** er en
nettleser med en Supabase-sesjon. Det er derfor webhook-ruten har sin egen
tillitsmekanisme (HMAC) og ligger utenfor `requireAuth`.

Docker-nettverkene er delt i to:

- **`snoat`** – plattformtjenestene (Supabase, Caddy, backend, mail-templates).
- **`snoat_apps`** – deployede brukerapplikasjoner. Caddy ligger på begge, slik
  at den kan proxie inn til brukerapper som ikke publiserer noen port på verten.

## Kodekart

### `backend/src/`

| Fil | Ansvar |
| --- | --- |
| `config.ts` | Miljøvariabler, validert med zod. Kaster ved oppstart hvis noe mangler. |
| `index.ts` | Hono-server, CORS, `/health`, feilhåndterer, reconcile ved oppstart. |
| `types.ts` | Typer for Supabase-skjemaet + `DeployError`. |
| `middleware/auth.ts` | Verifiserer Supabase-token og eierskap til prosjektet. |
| `routes/api.ts` | `/api`-endepunktene. Se `06_backend_api.md`. |
| `services/deploy.ts` | Orkestrerer pipelinen, inkl. rullerende utrulling og rollback. Reconcile av Caddy-ruter. |
| `services/git.ts` | Kloning + validering av repo-URL. |
| `services/nixpacks.ts` | Bygger image-et. |
| `services/runtime-versions.ts` | Avgjør språkversjon for et klonet repo: leser `engines.node`/`.nvmrc`, og setter Snoat-standarden bare når repoet ikke sier noe selv. |
| `services/build-diagnosis.ts` | Kjenner igjen kjente byggefeil i loggen og oversetter dem til en forklaring med råd. Treffer ingen signatur, brukes den generelle meldingen. |
| `routes/tls.ts` | Caddys tillatelsessjekk for on-demand TLS. Svarer 2xx kun for domener som tilhører et eksisterende prosjekt, og feiler lukket. Se `09_production_deployment.md`. |
| `services/static-site.ts` | Henter byggeresultatet ut av image-et og legger det på det delte volumet Caddy serverer fra. Prosjekter med `static_output_dir` kjører ingen container. |
| `services/containers.ts` | Oppretter, helsesjekker og pensjonerer applikasjonscontainere. Én container per deployment, funnet via labels. |
| `services/log-stream.ts` | Buffrer byggelogg og skyller til `deployments.logs`. |
| `lib/caddy.ts` | Admin-API-klient: opprett, bytt (atomisk PATCH), les og fjern ruter. |
| `lib/github.ts` | GitHub App: App-JWT, installasjonstokens, repo-listing, webhook-signatur og repo-normalisering. |
| `lib/redact.ts` | Fjerner credentials fra alt som havner i byggeloggen. |
| `routes/github.ts` | Repo-velgeren + installasjonsflyten. |
| `routes/webhooks.ts` | Webhook-mottak fra GitHub: deploy ved push. Offentlig, signaturverifisert. |
| `routes/stripe.ts` | Webhook-mottak fra Stripe: abonnement opprettet, fornyet, feilet, avsluttet. Offentlig, signaturverifisert. Avviser alt uten secret. |
| `routes/billing.ts` | Plan, forbruk, Checkout og kundeportal for dashboardet. |
| `services/plans.ts` | `PLAN_LIMITS` – den eneste definisjonen av hva en plan gir. Regner ut rettigheter, forbruk og sperren `assertCanDeploy()`. |
| `services/billing.ts` | Skriver abonnementstilstand fra Stripe-objekter. Idempotenslåsen for webhooks. |
| `services/suspension.ts` | Timesveip som stopper apper over gratisgrensen når nådefristen er ute. Av som standard. |
| `services/helse.ts` | Periodisk sveip (standard 2 min) som sammenligner det basen påstår kjører mot det Docker faktisk har, og retter `projects.container_died_at` ved avvik. Se `03_deployment_flow.md`. |
| `services/notify.ts` | Utgående drifts-e-post over Resend: første deployment live, container nede/tilbake. |
| `lib/stripe.ts` | Lat Stripe-klient, plangjenkjenning og signaturverifisering. |
| `lib/docker.ts` | Delt Dockerode-klient + apps-nettverket. |
| `lib/supabase.ts` | service-role-klient. |
| `lib/logger.ts` | pino. |

### `frontend/src/`

| Fil | Ansvar |
| --- | --- |
| `routes/index.tsx` | Landingssiden. |
| `routes/login.tsx` | GitHub OAuth + e-post/passord. Mapper GoTrue-feilkoder til norsk tekst, og bytter til innloggingsmodus når adressen er tatt. |
| `routes/auth.callback.tsx` | OAuth-landingspunkt. |
| `routes/forgot-password.tsx` | Ber om gjenopprettingslenke. Viser samme kvittering uansett om adressen finnes. |
| `routes/reset-password.tsx` | Setter nytt passord fra lenken i e-posten. Håndterer både `?code=` (PKCE) og `#access_token` (implicit). |
| `routes/dashboard.tsx` | «Mine prosjekter», deploy-trigger, nytt prosjekt. |
| `routes/projects.$projectId.tsx` | Prosjektvisningen med fanene Deployments, Terminal, DNS, Miljøvariabler og Innstillinger. |
| `routes/settings.billing.tsx` | Abonnement: plan, forbruksmålere, kjøp og kundeportal. Se `12_billing_and_plans.md`. |
| `components/DeploymentLogsDialog.tsx` | Live byggelogg over Realtime. |
| `components/DeploymentStatusBadge.tsx` | Statusprikk (Live / Bygger / Feilet …). |
| `components/DnsSettingsTab.tsx` | DNS-fanen: records, kopiknapper og leverandørveiledning. |
| `components/DashboardNav.tsx` | Navbar med heksagon-logo og bruker. |
| `hooks/useDeploymentsRealtime.ts` | Holder prosjektlisten synkron under bygging. |
| `lib/api.ts` | Kall mot backend, med access-token. |
| `lib/auth.tsx` | `<AuthProvider>` + `useAuth()`. |
| `lib/platform.ts` | Domenesuffiks, server-IP og `<slug>`-URL-er, lest fra `VITE_`-variablene. |
| `lib/supabase.ts` | `getSupabase()` – lat, kun i nettleseren. |

**DNS-fanen er ren veiledning.** Den forteller kunden hvilke records som må inn
hos registraren, men lagrer ingenting og oppretter ingen Caddy-rute – `upsertAppRoute`
registrerer i dag kun `<slug><SNOAT_APP_DOMAIN_SUFFIX>`. Se `11_custom_domains_and_dns.md`.

**GoTrue-feil klassifiseres på `code`, ikke på meldingstekst.** `AuthApiError`
bærer en stabil `code` (`user_already_exists`, `invalid_credentials`,
`email_not_confirmed` …), mens `message` er fri tekst som endrer seg mellom
versjoner. Å matche på tekst ga «Det skjedde en uventet feil» på en helt kjent
tilstand, fordi koden lette etter «User already exists» mens GoTrue sendte «User
already registered».

**Registrering navigerer ikke til dashbordet.** Uten autoconfirm returnerer
`signUp` ingen sesjon, så `signUpWithPassword` melder tilbake
`{ needsEmailConfirmation }` og UI-et viser «sjekk innboksen» i stedet. Navigerte
vi videre, ville brukeren landet på en side som spratt rett tilbake.

## Arkitekturvalg verdt å kjenne til

**Backend har ingen egen database.** Dokploy, som vi henter mønstre fra, bruker
Drizzle mot sin egen Postgres. Vi lagrer alt i Supabase via service-role-nøkkelen
i stedet, slik at datasuvereniteten holdes i ett system og frontend kan lese
samme data direkte med RLS.

**Vanlige containere, ikke Swarm.** Dokploy oppretter Swarm-*services*. Vi kjører
mot én daemon med `createContainer`, som er enklere og holder deployment-flyten
lesbar. Rullerende utrulling – som Swarm ville gitt oss gratis – gjør vi selv, med
én container per deployment og et atomisk rutebytte i Caddy. Se
`03_deployment_flow.md`.

**Containere identifiseres på label, ikke navn.** Navnet inneholder
deployment-id-en, siden to versjoner må kunne kjøre samtidig under en utrulling.
Labelen `no.snoat.project-id` er derfor det stabile båndet mellom en container og
prosjektet den tilhører, og det `containers.ts` slår opp på.

**Caddy REST-API, ikke filer.** Dokploy skriver Traefik-config som YAML på disk.
Caddys admin-API lar oss legge til og fjerne ruter uten filskriving eller reload.
`PATCH /id/<rute>` bytter i tillegg en rute atomisk i minnet, som er det som gjør
utrulling uten nedetid mulig.

**Klient-rendret dashboard.** Sesjonen lever i nettleseren. `getSupabase()` er
lat fordi `createClient` konstruerer Realtime-klienten umiddelbart, og den
kaster under SSR på Node < 22. Se `07_local_development.md`.

**Rekkefølgen rutene monteres i er semantikk, ikke stil.** Hono matcher handlere
i **registreringsrekkefølge**, og den første som svarer stopper kjeden. `api`
legger `requireAuth` på `/api/*`, så et offentlig endepunkt under `/api` må
registreres *før* `app.route("/api", api)` for å slippe unna auth – det er slik
`/api/webhooks/github`, `/api/webhooks/stripe` og `/api/pricing` fungerer. Konsekvensen er at en tilsynelatende uskyldig
ombytting av to `app.route()`-linjer i `index.ts` gjør webhooken utilgjengelig
(401) eller, i motsatt retning, kan eksponere et endepunkt som skulle vært
beskyttet. Begge sider er kommentert i koden.

Alternativet – å la `requireAuth` hoppe over enkelte stier – ble vurdert og
forkastet: da flytter man tilgangskontrollen inn i en betingelse i middlewaren,
der den er lettere å lese feil enn to linjer med kommentar i `index.ts`.
