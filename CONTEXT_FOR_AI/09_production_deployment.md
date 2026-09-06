# Produksjon og Deployment (Snoat VPS)

Snoat er deployert til en dedikert VPS-server som driftes på IP-adressen `38.87.117.167`.

Dette dokumentet beskriver produksjonsarkitekturen, rutingen og gir AI-assistenter direkte fullmakt til å utføre SSH-operasjoner mot produksjonsserveren.

## 1. AI Fullmakt & SSH-tilgang
AI-assistenter knyttet til dette prosjektet har **fullmakt til å logge inn på produksjonsserveren via SSH** for å diagnostisere problemer, lese logger, verifisere database-tilstand, eller utføre deployment.

**Kommando for innlogging:**
```bash
ssh root@38.87.117.167
```
Siden Mac-ens offentlige SSH-nøkkel (`~/.ssh/id_rsa.pub`) allerede er lagt inn i `~/.ssh/authorized_keys` på serveren (og passord-autentisering/root login er aktivert), skal SSH-kommandoer fungere sømløst uten manuelle passord-prompts. Bruk `run_command` over SSH ved behov (f.eks. `ssh root@38.87.117.167 'docker compose -f /opt/snoat/docker-compose.yml ps'`).

## 2. Domener og Caddy Reverse Proxy
Caddy håndterer all innkommende trafikk på port 80 (HTTP) og 443 (HTTPS), og utsteder automatisk Let's Encrypt-sertifikater for domenene nedenfor, forutsatt at DNS (A-records) peker til `38.87.117.167`.

| Domene | Rutes til container | Beskrivelse |
| --- | --- | --- |
| `snoat.com` | `frontend:3000` | Hovednettsiden, landingssiden og bruker-dashboardet (TanStack Start). |
| `api.snoat.com` | `kong:8000` & `backend:3000` | **Felles API**. Ruter Supabase-trafikk (`/auth/*`, `/rest/*`, `/realtime/*`, `/storage/*`) til Kong, og alt annet til Snoat Backend API. |
| `studio.snoat.com` | `studio:3000` | Supabase Studio GUI. |
| `*.snoat.com` | Caddy dynamisk subruting | Brukerapplikasjoner som deployes og kjøres av Snoat-plattformen. |

### Sertifikater for kundedomener: on-demand TLS

Caddys automatiske HTTPS finner domener ved å lese `host`-matchere i serverens
**toppnivåruter**. Den stiger ikke ned i `subroute`-handlere. Siden alle
applikasjonsruter legges inne i `snoat_apps` (`lib/caddy.ts`), ble kundedomenene
aldri oppdaget: `<slug>.snoat.com` svarte på port 80, mens 443 avbrøt handshaken
med `tlsv1 alert internal error` fordi Caddy ikke hadde noe sertifikat å vise.
Plattformdomenene virket hele tiden, nettopp fordi de *er* toppnivåruter.

Løsningen er on-demand TLS: Caddy henter sertifikatet under første handshake for
et navn den ikke kjenner. `apps.tls.automation` har derfor to policyer, og
rekkefølgen betyr noe:

1. plattformdomenene listet eksplisitt under `subjects` – de beholder vanlig
   proaktiv administrasjon, og skal *ikke* bli on-demand
2. `{ "on_demand": true }` som catch-all for alt annet

Uten sperre kunne hvem som helst pekt DNS mot oss og fått oss til å be om
sertifikater. `on_demand.permission` spør derfor `backend:3000/internal/tls-ask`
(`routes/tls.ts`) før hver utstedelse, og Caddy utsteder kun ved 2xx. Endepunktet
slår slugen opp i `projects` og feiler lukket: databasefeil gir 503, ikke 200.

> **Kvotetaket består.** Let's Encrypt tillater 50 sertifikater per registrert
> domene per uke, og hvert `<slug>.snoat.com` teller. On-demand utsteder bare
> senere, ikke sjeldnere. Skal plattformen skalere forbi det, må `*.snoat.com`
> dekkes av ett wildcard-sertifikat via DNS-01 – det krever et Caddy-image bygget
> med DNS-plugin og et API-token hos DNS-leverandøren.

**Endring uten nedetid.** TLS-appen kan legges inn med `PUT /config/apps/tls` mot
admin-API-et i stedet for å restarte Caddy. Da røres ikke `http`-appen, og
apprutene som bare finnes i minnet overlever. Husk `Origin`-header med skjema
(`http://localhost:2019`) – Caddy svarer 403 på skrivende kall uten den.

### HTTP→HTTPS: ruten `snoat_https_redirect`

Caddy lager **ikke** redirect-ruter av seg selv her. Den hopper over det når en
server er eksplisitt satt opp til å lytte på `:80`, siden den da antar at du vil
servere vanlig HTTP der. Resultatet var at ingenting omdirigerte – verken
plattform- eller kundedomener.

Første rute i `snoat`-serveren er derfor en egen 308-redirect, matchet på
`protocol: http`. Den ligger først med vilje, slik at den dekker alle domener.

> ⚠️ **ACME-stien er unntatt med en `not`-matcher.** On-demand-utstedelse løser
> HTTP-01-utfordringen på port 80. Omdirigerer man `/.well-known/acme-challenge/*`
> til HTTPS, kan ingen nye sertifikater utstedes – og siden HTTPS krever
> sertifikatet som utfordringen skulle skaffe, låser det seg selv. Verifiser
> alltid etter endringer at stien svarer noe annet enn 308:
>
> ```bash
> curl -sS -o /dev/null -w "%{http_code}\n" \
>   http://<slug>.snoat.com/.well-known/acme-challenge/testtoken   # skal IKKE vaere 308
> ```

**Caddy avviser ukjente felter i JSON.** Et `_comment`-felt gir
`unknown field "_comment"` og hele konfigurasjonen nektes lastet. Forklaringer
hører hjemme her i dokumentasjonen, ikke i `config.json`. Kjør
`docker exec snoat-caddy-1 caddy validate --config /etc/caddy/config.json` etter
endringer – en fil som ikke laster tar ned all ruting ved neste restart.

**Innsetting uten å røre apprutene:** `PUT` mot en array-indeks *setter inn* i
stedet for å erstatte, så

```bash
curl -X PUT -H "Origin: http://localhost:2019" -d @rute.json \
  http://localhost:2019/config/apps/http/servers/snoat/routes/0
```

legger ruten først uten å skrive over `snoat_apps` og rutene som bare finnes i
Caddys minne.

### Brukerrutene lever kun i Caddys minne

Caddy startes med `--config` og `persist: false`, så rutene for `*.snoat.com`
forsvinner ved hver `docker compose up -d caddy`. Backend bygger dem opp igjen fra
Supabase ved oppstart (`reconcileRoutes()`), men **rekkefølgen betyr noe under en
plattform-deployment**: restartes Caddy uten at backend restartes etterpå, står
brukerappene uten rute til noen trigger en reconcile. `docker compose up -d` tar
begge når begge har endringer; gjør du noe manuelt med Caddy alene, restart
backend etterpå.

### Kapasitet under utrulling

En deployment kjører den nye containeren *ved siden av* den gamle før trafikken
flyttes over (`03_deployment_flow.md`). Et prosjekt som ruller ut holder derfor
kortvarig dobbelt minne- og CPU-tak. På en VPS med mange prosjekter er det
samtidige utrullinger – ikke prosjekter i ro – som setter grensen. `inFlight`
låser per prosjekt, ikke globalt, så to brukere kan rulle ut samtidig.

Disk er den andre siden av dette. Hver build overskriver taggen `snoat/<slug>`, og
forrige image mister navnet sitt uten å bli slettet – det holdes i live av
containeren som fortsatt kjører fra det. Etter utrullingen ligger det igjen som et
dangling image. Ingenting rydder dem automatisk i dag:

```bash
docker image prune -f            # dangling images uten container
docker system df                 # hva som faktisk spiser disken
```

Kjør `prune` **etter** at utrullingen er ferdig, aldri midt i en – et image som
holdes av en kjørende container røres ikke, men det er en unødvendig risiko å ta
mens en deployment pågår.

## 3. Lokal Deployment Flow
All deployment skjer via et lokalt script (`scripts/deploy.sh`) kjørt fra utviklerens Mac.

1. Scriptet synkroniserer kode med `rsync` til `/opt/snoat` på serveren.
2. Scriptet kjører over SSH:
   ```bash
   cd /opt/snoat
   SNOAT_DOMAIN=snoat.com node scripts/bootstrap-env.mjs
   docker compose build frontend backend
   docker compose up -d --remove-orphans
   ```
3. Siden Supabase-volumene opprettholdes på serveren, forblir databasetilstanden persistert mellom hver deployment. Ved nyoppsett kjøres Supabase-migrasjonene fra bunnen av (`db-migrate` containeren).

### `.env` synkroniseres aldri

`.env` og `frontend/.env` er **ekskludert fra rsync**. De inneholder `JWT_SECRET`
og `POSTGRES_PASSWORD`, som hører til databasen på den enkelte maskinen –
kopierer man Mac-versjonen over, peker produksjon plutselig på
`*.snoat.localhost` og mister tilgangen til sin egen database. Dette var
årsaken til at innlogging var nede: bundlen på snoat.com var bygget med
`VITE_SUPABASE_URL=http://supabase.snoat.localhost`.

`bootstrap-env.mjs` er derfor idempotent. Kjøres den på en maskin som allerede
har `.env`, beholder den alle hemmeligheter og operatør-innstillinger, men
regner ut på nytt:

- alle domeneavledede URL-er (av `SNOAT_DOMAIN`)
- `DOCKER_SOCKET_PATH` (av `docker context` på den maskinen)
- `SNOAT_WORKSPACE_DIR` (av repo-roten)
- `BACKEND_BUILD_TARGET` (`dev` lokalt, `production` på VPS)

Kun `--force` bytter hemmeligheter, og da må `docker compose down -v` kjøres.

### ⚠️ `preserved()`-fellen: nye variabler får aldri defaultverdien sin

Dette er den viktigste operative fellen i deploymentflyten, og den har bitt oss.

`bootstrap-env.mjs` bygger `.env` av `preserved(KEY, fallback)`, som returnerer
**eksisterende verdi hvis den finnes og ikke er tom**. Fallbacken brukes bare når
nøkkelen mangler helt. Konsekvensen:

- **Endrer du en default i scriptet, endres ingenting i produksjon.** VPS-ens
  gamle verdi overlever. Da vi satte `ENABLE_EMAIL_AUTOCONFIRM` fra `true` til
  `false`, fortsatte produksjon å kjøre `true` gjennom flere deployer.
- **Legger du til en ny hemmelighet, blir den tom i produksjon.** Den har aldri
  eksistert der, så `preserved` gir fallbacken – typisk `""`. `RESEND_API_KEY` og
  `SMTP_ADMIN_EMAIL` sto tomme til de ble satt manuelt.

Nye eller endrede verdier må derfor settes **på serveren**, én gang:

```bash
ssh root@38.87.117.167
cd /opt/snoat && cp .env ".env.bak.$(date +%Y%m%d-%H%M%S)" && nano .env
docker compose up -d <tjenesten som leser variabelen>
```

Rekkefølgen kan være kritisk. Setter du `ENABLE_EMAIL_AUTOCONFIRM=false` før
`RESEND_API_KEY` finnes, kan GoTrue ikke sende bekreftelsesmail – og da kan
*ingen* registrere seg. Sett avhengige variabler i samme redigering.

### Stille feilkonfigurasjon er hovedfienden

Tre funksjoner har vært deployet og tilsynelatende friske, men gjort ingenting,
fordi konfigurasjonen manglet uten at noe feilet høylytt:

| Funksjon | Symptom | Årsak |
| --- | --- | --- |
| E-postmaler | Post kom fram, men på engelsk standardmal | `GOTRUE_MAILER_TEMPLATES_*` tar en URL; en filsti feiler stille |
| E-postbekreftelse | Deploy sa «ferdig», sårbarheten sto åpen | `preserved()` beholdt `autoconfirm=true` |
| Repo-velgeren | Manuelt URL-felt i stedet for repo-liste | `GITHUB_APP_PRIVATE_KEY` tom, så `isConfigured()` ble false |

Fellestrekket: **tjenesten svarer 200, men gjør ikke det du tror.** Derfor holder
det ikke å sjekke at noe *kjører* – deploy må lese tilbake den faktiske
konfigurasjonen og sammenligne med intensjonen.

`scripts/deploy.sh` har nå to steg for dette:

- **Steg 2b** stopper før tjenestene røres hvis `RESEND_API_KEY` eller
  `SMTP_ADMIN_EMAIL` mangler på VPS-en.
- **Steg 6** feiler deployen hvis `/auth/v1/settings` melder
  `mailer_autoconfirm: true`.

Legger du til nye kritiske variabler, utvid disse to stegene. Et statuskall som
ikke kan feile er verre enn ingen verifisering – det gir falsk trygghet.

## Serverkapasitet

Snoat kjører nå på en **konsolidert VPS med 16 GB RAM, 4 vCPU og 100 GB SSD**. 
Denne serveren håndterer både selve Snoat-plattformen, deployede brukerapplikasjoner og andre tjenester (inkludert Coolify og Caddy). 
Den tidligere begrensningen med manglende minne under Nixpacks-bygg er løst av denne oppgraderingen, og builds fullføres normalt svært raskt uten at plattformen går ned.

Kø-mekanismen for builds (`SNOAT_MAX_CONCURRENT_BUILDS=1`) er fremdeles i bruk for å holde ytelsen forutsigbar og unngå kapasitetsproblemer under massive byggejobber, men maskinen har nå rikelig med kapasitet til å drifte alt.

### Førstehjelp når serveren er tung

```bash
ssh -i ~/.ssh/id_rsa root@38.87.117.167 \
  'uptime; free -m; dmesg -T | grep -i "out of memory" | tail'
```

`dmesg`-linja svarer ja eller nei på OOM uten tolkning. `-i ~/.ssh/id_rsa` er
ikke pynt: uten `IdentitiesOnly` tilbyr ssh alle nøkler i agenten, og du kan ende
på passordprompt selv om riktig nøkkel ligger i `authorized_keys`.

### Utviklerverktøy kjører ikke i produksjon

`studio` og `meta` ligger bak compose-profilen `studio` og starter derfor **ikke**
av et rent `docker compose up -d`. De brukte 170 MB og 80 MB – den største
enkeltposten i stacken – for et verktøy ingen produksjonsbruker ser.

`meta` (postgres-meta) finnes utelukkende for å betjene Studio; ingen annen
tjeneste kaller den. Den er eksponert via Kong på `meta-route`, men Kong resolver
upstream lazily, så Kong forblir healthy uten den. Verifisert i produksjon.

Skal du bruke Studio, kjør `docker compose --profile studio up -d studio`, eller
sett `COMPOSE_PROFILES=studio` i `.env` (gjøres lokalt, ikke i produksjon).

Databasearbeid i produksjon gjøres over SSH i stedet:

```bash
# ad hoc
ssh root@38.87.117.167 "cd /opt/snoat && docker compose exec -T db psql -U postgres -c '<sql>'"

# nye migrasjonsfiler i supabase/migrations/ – rsync dem, så:
ssh root@38.87.117.167 "cd /opt/snoat && docker compose up db-migrate"
```

### Domeneavledning

Ett domene styrer alt. `api.<domene>` er felles inngang for både Supabase og
backend, slik Caddy allerede ruter:

| Variabel | `snoat.localhost` (dev) | `snoat.com` (prod) |
| --- | --- | --- |
| `SITE_URL` | `http://localhost:8080` | `https://snoat.com` |
| `API_EXTERNAL_URL` | `http://api.snoat.localhost` | `https://api.snoat.com` |
| `VITE_SUPABASE_URL` | `http://api.snoat.localhost` | `https://api.snoat.com` |
| `SNOAT_FRONTEND_ORIGIN` | `http://localhost:8080,…` | `https://snoat.com` |
| `BACKEND_BUILD_TARGET` | `dev` | `production` |
| `SNOAT_SERVER_IP` | `127.0.0.1` | `38.87.117.167` |

`SNOAT_SERVER_IP` er A-record-målet DNS-fanen i prosjektvisningen viser fram, og
speiles til frontend som `VITE_SNOAT_SERVER_IP`. Den utledes ikke av domenet –
`bootstrap-env.mjs` beholder verdien som allerede står i `.env`, og du overstyrer
den ved å sette den foran kommandoen:

```bash
SNOAT_DOMAIN=snoat.com SNOAT_SERVER_IP=38.87.117.167 node scripts/bootstrap-env.mjs
```

Bytter serveren IP, må frontend bygges på nytt – Vite baker verdien inn i
bundlen, akkurat som de andre `VITE_`-variablene.

**Dev-sidene bruker to etiketter under samme suffiks:**
`dev.eierfullstack.snoat.com` i tillegg til `eierfullstack-dev.snoat.com`. Det
krever ingen ny DNS-record. `*.snoat.com` dekker alle navn under seg som ikke
har en nærmere node i sonen (RFC 4592) – ikke bare én etikett – og sertifikatet
hentes on-demand per navn, som for alle andre appdomener. Legger noen inn en
eksplisitt A-record for `eierfullstack.snoat.com` i sonen, slutter wildcarden å
dekke navnene under den, og dev-adressene under det prosjektet slutter å
resolve. Ikke gjør det.

### Frontend bygges med build-args, ikke runtime-env

Vite baker `VITE_`-variabler inn i bundlen under `npm run build`. Å sette dem
som `environment:` i compose gjør ingenting – de må inn som `build.args`, slik
`docker-compose.yml` og `frontend/Dockerfile` nå gjør. Dockerfile-en feiler
builden hvis `VITE_SUPABASE_URL` eller `VITE_SUPABASE_ANON_KEY` mangler, slik at
feilkonfigurasjon oppdages i byggesteget og ikke i nettleseren til brukeren.

### GitHub OAuth i produksjon

Sett i `/opt/snoat/.env` på serveren og kjør `docker compose up -d auth`:

```
GITHUB_OAUTH_ENABLED=true
GITHUB_CLIENT_ID=…
GITHUB_CLIENT_SECRET=…
```

OAuth-appen på GitHub må ha:

- Homepage URL: `https://snoat.com`
- Authorization callback URL: `https://api.snoat.com/auth/v1/callback`

Merk `api.snoat.com` – ikke `supabase.snoat.com`. Det er `api`-verten Caddy
ruter `/auth/v1/*` fra til Kong. Verifiser med:

```bash
curl -s https://api.snoat.com/auth/v1/settings | jq .external.github   # skal være true
```

### GitHub App (repo-velger og private repoer)

En **egen** app fra https://github.com/settings/apps – ikke den samme som
OAuth-appen over. OAuth-appen logger folk inn; App-en gir tilgang til kode.

| Felt | Verdi |
| --- | --- |
| Homepage URL | `https://snoat.com` |
| Callback URL | **Tom.** Vi bruker ikke App-ens brukerautorisering – installasjonen identifiseres av signert `state`. |
| Request user authorization (OAuth) during installation | Av |
| Setup URL | `https://api.snoat.com/github/setup` |
| Redirect on update | På – da kommer brukeren innom `/github/setup` også når repoer legges til eller fjernes |
| Webhook → Active | **På** – dette er auto-deploy ved push |
| Webhook URL | `https://api.snoat.com/api/webhooks/github` |
| Webhook secret | Samme verdi som `GITHUB_WEBHOOK_SECRET` i `/opt/snoat/.env` |
| Repository permissions | `Contents: Read-only` (`Metadata: Read-only` følger automatisk) |
| Organization / Account permissions | Ingen |
| Subscribe to events | `Push` |
| Where can this be installed | Any account |

App-navnet bestemmer slug-en: «Snoat» gir `github.com/apps/snoat`. Det er den
slug-en som må inn i `GITHUB_APP_SLUG`.

Generer en privat nøkkel, og legg i `/opt/snoat/.env`:

```
GITHUB_APP_ID=<App ID fra siden>
GITHUB_APP_SLUG=<slug-en i github.com/apps/<slug>>
GITHUB_APP_PRIVATE_KEY=<base64 -i snoat.<dato>.private-key.pem>
```

`GITHUB_APP_STATE_SECRET` genereres av `bootstrap-env.mjs`. Kjør
`docker compose up -d backend` etterpå, og verifiser:

```bash
curl -s https://api.snoat.com/api/github/status -H "Authorization: Bearer <token>" | jq .configured
```

Integrasjonen er **valgfri**. Uten disse variablene svarer `/api/github/*` 503,
og dashboardet viser kun URL-feltet slik det gjorde før – ingenting knekker.

Den private nøkkelen er base64-kodet fordi en PEM inneholder linjeskift som
verken `.env` eller docker-compose håndterer pent.

### Webhook-secret (auto-deploy ved push)

`GITHUB_WEBHOOK_SECRET` er den eneste hemmeligheten her som **deles med GitHub**,
og derfor den eneste `bootstrap-env.mjs` ikke kan generere: den må være identisk
på begge sider. Generer én, og lim den inn både i `/opt/snoat/.env` og i
«Webhook secret» på App-en:

```bash
openssl rand -hex 32
```

```
GITHUB_WEBHOOK_SECRET=<verdien>
```

`docker compose up -d backend` etterpå. Verifiser med **Redeliver** på en
`ping`-levering under App-ens «Advanced»-fane – svaret skal være
`200 {"received":true,"message":"pong"}`. Får du `401`, er secreten ulik på de to
sidene.

**Står variabelen tom, tas webhooks imot uten signaturkontroll**, og hvem som
helst kan starte builds. Backend logger en `warn` per forespørsel så lenge den er
tom, så dette synes i `docker compose logs backend`. Se `08_security_model.md`.

Rekkefølgen ved førstegangsoppsett har én felle: skrur du på webhooken på GitHub
før secreten står i `.env`, blir alle leveringer tatt imot uverifisert i
mellomtiden – ikke avvist. Sett `.env` først.

**Caddy trenger ingen ny regel.** `api.snoat.com` sender alt som ikke matcher
Supabase-stiene (`/auth/v1/*`, `/rest/v1/*`, `/realtime/v1/*`, `/storage/v1/*`,
`/graphql/v1/*`, `/pg/v1/*`) videre til `backend:3000` via fallback-ruten i
`caddy/config.json`. `/api/webhooks/github` treffer altså backend som den er.

## 4. Viktig: Mappen `supabase/` i Kodebasen
Selv om Supabase nå kjører live på serveren via Docker, er den lokale mappen `supabase/` i repoet helt essensiell. Denne mappen inneholder infrastruktur-som-kode for databasen vår:
- **`supabase/migrations/`**: Inneholder alle databaseskjemaer (`0001_snoat_schema.sql` osv.). Utan disse kan ikke `db-migrate` oppdatere produksjonsdatabasen.
- **`supabase/kong/`**: Konfigurasjon for API-gatewayen vår.
- **`supabase/db/init/`**: Inneholder `zzz-01-snoat-roles.sql` som sørger for at passord og rettigheter settes opp riktig på produksjonsdatabasen.

**ADVARSEL:** Denne mappen **må ikke slettes**. Deploy-scriptet (`rsync`) kopierer denne mappen til serveren, og Docker Compose på VPS-en leser direkte fra disse filene for å konfigurere databasen og API-ene. Uten denne mappen vil serveren krasje neste gang den starter opp.

## 5. Viktig: Frontend (TanStack Start)
For at SSR (Server-Side Rendering) skal fungere i Docker-containeren, bygges frontend med Nitro-preset satt til `node-server` i `vite.config.ts`. Dette gjør at bygg-steget (`npm run build`) produserer en kjørbar Node.js-tjener i `.output/server/index.mjs` i stedet for en Cloudflare worker. Dette er grunnen til at frontend kan kjøre autonomt på VPS-en vår via Caddy.
