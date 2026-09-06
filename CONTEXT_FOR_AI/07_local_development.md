# Lokalt utviklingsmiljø

## Oppsett

```bash
node scripts/bootstrap-env.mjs   # genererer .env og frontend/.env
docker compose up -d --build     # Supabase, Caddy, backend
cd frontend && npm install && npm run dev
```

Første oppstart laster ned Supabase-imagene og bygger backend-imaget (med
nixpacks og Docker CLI), så det tar noen minutter.

| URL | Hva |
| --- | --- |
| http://localhost:8080 | Dashboardet (Vite dev-server) |
| http://api.snoat.localhost | Snoat backend-API **og** Supabase-gatewayen |
| http://studio.snoat.localhost | Supabase Studio |
| http://\<prosjekt\>.snoat.localhost | Deployede brukerapplikasjoner |

`api.<domene>` er én felles inngang i begge miljøer: Caddy sender `/auth/v1/*`,
`/rest/v1/*`, `/realtime/v1/*` og `/storage/v1/*` til Kong, og alt annet til
Snoat-backend. Dev og prod har dermed samme form, bare ulikt domene – det var
divergensen mellom de to som tidligere sendte produksjonsbundlen til
`supabase.snoat.localhost`.

`*.localhost` løses automatisk til 127.0.0.1 i moderne nettlesere – ingen
`/etc/hosts`-oppføringer trengs. For `curl` må du sette Host-headeren selv:
`curl -H "Host: api.snoat.localhost" http://127.0.0.1/health`.

## Hemmeligheter

`scripts/bootstrap-env.mjs` genererer et unikt `JWT_SECRET` og signerer
`ANON_KEY` og `SERVICE_ROLE_KEY` med det. Vi bruker bevisst **ikke** Supabase
sine publiserte demo-nøkler, slik at ingen installasjon deler hemmeligheter med
noen andre.

Scriptet skriver to filer:

- `.env` – hele plattform-stacken
- `frontend/.env` – `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`,
  `VITE_SNOAT_API_URL`, `VITE_SNOAT_APP_DOMAIN_SUFFIX`, `VITE_SNOAT_SERVER_IP`

De skrives fra samme kjøring, slik at anon-nøkkelen aldri divergerer fra det
Supabase faktisk kjører med. Begge er gitignorert, og begge er ekskludert fra
`rsync` i `scripts/deploy.sh` – hemmelighetene hører til databasen på den
enkelte maskinen.

Scriptet er idempotent: kjøres det på nytt, beholdes eksisterende hemmeligheter
og innstillinger, mens domene, Docker-socket og build-target regnes ut på nytt.
Domenet styres av `SNOAT_DOMAIN` (default `snoat.localhost`).

Kjører du `--force` etter at databasen er initialisert, må du også kjøre
`docker compose down -v` – rollepassordene og `JWT_SECRET` settes kun ved
initdb.

## To variabler som må stemme

**`SNOAT_WORKSPACE_DIR`** monteres på *samme absolutte sti* på host og i
backend-containeren. Nixpacks kjører `docker build` mot host-daemonen og sender
med stien til build-contexten; daemonen løser den i sitt eget filsystem. Ulike
stier på hver side gir «context not found».

**`DOCKER_SOCKET_PATH`** autodetekteres fra `docker context`. Docker Desktop på
macOS legger socketen i `~/.docker/run/docker.sock` med mindre «Allow the
default Docker socket to be used» er slått på i innstillingene.

## GitHub OAuth

Registrer en OAuth-app på https://github.com/settings/developers:

- Homepage URL: `http://localhost:8080`
- Authorization callback URL: `http://api.snoat.localhost/auth/v1/callback`

Produksjon bruker en egen OAuth-app med `https://api.snoat.com/auth/v1/callback`
– se `09_production_deployment.md`.

Sett så `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` og
`GITHUB_OAUTH_ENABLED=true` i `.env`, og `docker compose up -d auth`.

## GitHub App (repo-velgeren)

Dette er en *annen* registrering enn OAuth-appen over. OAuth-appen gjør
innlogging; GitHub App-en henter repo-listen. En OAuth App har client secret og
ingen private key – trenger du en `.pem`, står du på feil side hos GitHub.

Lokalt deler vi produksjonens App (`snoatauth`, App ID 4426927). Det er nok til
at `isConfigured()` blir sann og velgeren erstatter det manuelle URL-feltet.

Men **installasjonsflyten kan ikke deles.** Setup URL er ett enkelt felt på
App-en og peker på produksjon, så trykker du «koble til» lokalt, havner
installasjonsraden i produksjonsdatabasen – ikke i din lokale. Lokalt blir
`connected` stående false.

To veier ut:

1. **Egen App for localhost.** Registrer en ny på
   https://github.com/settings/apps med Setup URL
   `http://api.snoat.localhost/github/setup`, og bytt ut `GITHUB_APP_*` i `.env`.
   Riktigst, men du må vedlikeholde to apper.
2. **Så inn raden manuelt** etter at App-en er installert i produksjon. Hent
   `installation_id` derfra og legg den inn lokalt:

   ```bash
   docker compose exec db psql -U postgres -c \
     "insert into github_installations (user_id, installation_id, account_login, account_type)
      values ('<din-lokale-user-id>', <installation_id>, '<github-brukernavn>', 'User');"
   ```

## Webhooks (deploy ved push)

Samme problem som installasjonsflyten, bare verre: Webhook URL er *ett* felt på
App-en, og `http://api.snoat.localhost` finnes ikke fra GitHubs side. Push-events
til den lokale backenden kommer altså aldri av seg selv.

Sett `GITHUB_WEBHOOK_SECRET` i `.env` til samme verdi som på App-en, og test
mottaket lokalt ved å signere en payload selv:

```bash
SECRET=$(grep '^GITHUB_WEBHOOK_SECRET=' .env | cut -d= -f2-)
BODY='{"ref":"refs/heads/main","after":"deadbeef","repository":{"full_name":"<eier>/<repo>","default_branch":"main"}}'

curl -sS -X POST http://127.0.0.1:3100/api/webhooks/github \
  -H 'Content-Type: application/json' \
  -H 'X-GitHub-Event: push' \
  -H "X-Hub-Signature-256: sha256=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$SECRET" | awk '{print $2}')" \
  -d "$BODY"
```

`<eier>/<repo>` må matche `repo_url` på et prosjekt i din lokale database, ellers
svarer endepunktet 200 med «Ingen Snoat-prosjekter bruker …» – som også er en fin
måte å bekrefte at signaturen gikk gjennom. Feil signatur gir 401.

Vil du ha ekte events lokalt, må backend nås utenfra – `cloudflared tunnel` eller
`ngrok` mot `127.0.0.1:3100`, med den URL-en som Webhook URL på en egen App for
localhost.

### Å kjøre en rute uten at stacken er oppe

Backend har ingen testrammeverk, men Hono-appene er vanlige objekter med en
`.request()`-metode, og det er nok til å drive en rute i prosessen – uten Docker,
Caddy eller Supabase:

```ts
process.env.SUPABASE_URL = "http://127.0.0.1:1";   // config krever at de finnes
process.env.SUPABASE_SERVICE_ROLE_KEY = "k";
process.env.SUPABASE_ANON_KEY = "k";
process.env.SNOAT_WORKSPACE_DIR = "/tmp/x";
process.env.GITHUB_WEBHOOK_SECRET = "test";
process.env.NODE_ENV = "test";                     // hopper over pino-pretty

const { githubWebhooks } = await import("./src/routes/webhooks.ts");
const res = await githubWebhooks.request("/github", { method: "POST", headers, body });
```

Miljøvariablene må settes **før** `config.ts` importeres – den valideres på
modulnivå og kaster ellers. Trenger ruten databasen, kan `SUPABASE_URL` peke på en
`http.createServer` som svarer med den JSON-en PostgREST ville sendt; det er slik
webhook-oppslaget ble verifisert (`ilike`-spørringen mot `projects` og innsettingen
i `deployments`) uten at en build faktisk startet. Kjøres med
`npx tsx <fil>` fra `backend/`.

## E-post (Resend)

GoTrue sender bekreftelse- og gjenopprettingse-post via Resend over SMTP.
Brukernavnet er alltid literalen `resend`; passordet er `RESEND_API_KEY`.

Avsenderdomenet i `SMTP_ADMIN_EMAIL` må være verifisert på
https://resend.com/domains. Er det ikke verifisert, kan Resend kun sende til
adressen Resend-kontoen selv er registrert med – noe som holder for lokal
testing, men betyr at registrering med andre adresser stille feiler.

**E-postmalene serveres over HTTP, ikke fra disk.** `GOTRUE_MAILER_TEMPLATES_*`
tar en URL. Gir du den en filsti, limer GoTrue stien bak `SITE_URL`, får
connection refused, logger `templatemailer_template_body_http_error` – og sender
e-posten med sin egen standardmal likevel. Feilen er stille: brukeren får post,
bare feil post. Derfor ligger malene bak `mail-templates`-containeren
(`http://mail-templates/<navn>.html`), kun på det interne nettverket.

Endrer du en mal, hold emnefeltet i `GOTRUE_MAILER_SUBJECTS_*` i synk – emnet
arves ikke fra malen.

Verifiser at malen faktisk brukes etter en endring:

```bash
docker compose logs auth | grep templatemailer   # skal være tomt
```

`ENABLE_EMAIL_AUTOCONFIRM` skal stå `false`. Det er fristende å skru den på
lokalt for å slippe e-post, men den åpner en account takeover-vektor og bør
ikke stå ulikt mellom dev og produksjon – se `08_security_model.md`. Trenger du
en bruker uten å vente på innboksen, bekreft den heller direkte i databasen:

```bash
docker compose exec db psql -U postgres -c \
  "update auth.users set email_confirmed_at = now() where email = 'deg@example.com';"
```

## Verifisere utrulling uten nedetid

Påstanden i `03_deployment_flow.md` er målbar, og bør måles på nytt hvis noen
rører rekkefølgen i `runPipeline()`. Hamre på appen fra ett vindu mens du
deployer fra dashboardet i et annet:

```bash
while :; do
  curl -s -o /dev/null -w '%{http_code} ' -H "Host: minapp.snoat.localhost" http://127.0.0.1/
  sleep 0.1
done
```

Strømmen skal være uavbrutt `200`. En `404` betyr at Caddy sto uten rute for
subdomenet, en `502` at ruten pekte på en container som ikke svarte – begge er
nedetid, og begge er feil rekkefølge i pipelinen. Følg med på at det finnes to
containere en liten stund:

```bash
watch -n0.5 'docker ps --filter label=no.snoat.managed=true --format "{{.Names}} {{.Status}}"'
```

`SNOAT_APP_STOP_TIMEOUT_S` (standard 10) er fristen den gamle containeren får til
å fullføre forespørsler før den drepes. Setter du den til 0, kuttes langtkjørende
svar tvert i det utrullingen fullføres.

### Mekanismen alene, uten en ekte app

Samme prinsipp som «å kjøre en rute uten at stacken er oppe» over:
`services/containers.ts` og `lib/caddy.ts` importerer ikke Supabase, så de kan
drives direkte med `npx tsx` fra `backend/` mot en egen Caddy og et eget
nettverk – uten å røre den kjørende stacken. Oppskriften:

1. Eget nettverk (`SNOAT_APPS_NETWORK=snoat_zdt_apps`) og en Caddy på egne porter
   (`127.0.0.1:12019` admin, `:18080` http), med samme struktur som
   `caddy/config.json`: en tom `subroute` med `@id: "snoat_apps"`. Admin-origin må
   matche `CADDY_ADMIN_URL`, ellers avvises kallene med 403.
2. Tre bittesmå images fra `caddy:2-alpine` – to som svarer `v1`/`v2` med
   `caddy respond --listen :$PORT`, og ett som skriver til stderr og avslutter
   med kode 1, for å teste krasj-stien.
3. `LogStream` kan erstattes med `{ write, step }` castet til typen; den er det
   eneste `containers.ts` trenger av Supabase-verdenen.

Målt på den måten: **0 av 254 forespørsler feilet** gjennom et PATCH-bytte, mot
**17 av 18** når byttet gjøres som DELETE + POST. Krasj-stien bekreftet at
`RestartCount` fanger krasj-loopen, at ruten blir stående på forrige versjon, og
at staging-containeren ryddes.

## Feilsøking

**Start med `/health`.** Den sier hvilken av de fire avhengighetene som mangler:

```bash
curl -s http://api.snoat.localhost/health | jq
```

**«Node.js 20 detected without native WebSocket support».** `createClient`
konstruerer Realtime-klienten umiddelbart, og den kaster på Node < 22.
Håndtert to steder:

- *Frontend:* `getSupabase()` er lat og kaster tydelig hvis den kalles under SSR.
  Alle Supabase-kall må derfor skje i effekter eller i react-query-spørringer med
  en `enabled`-guard.
- *Backend:* sender inn `ws` som transport når `globalThis.WebSocket` mangler.
  I containeren (Node 22) brukes den innebygde.

**Deployment feiler i `run`-steget.** Containeren kom ikke frisk gjennom
helsesjekkens tre sekunder. Loggvinduet viser de siste 50 linjene fra
applikasjonen. To varianter av samme feil:

- *«Containeren stoppet rett etter oppstart (exit code N)»* – prosessen døde og
  ble ikke startet på nytt.
- *«Containeren krasjet og ble startet på nytt N gang(er)»* – appen er i
  krasj-loop. `RestartPolicy: on-failure:N` (`SNOAT_APP_RESTART_MAX_RETRIES`,
  standard 5) starter den igjen flere ganger før Docker gir opp, så
  `docker ps` kan vise den som `Up` i det du ser etter. `docker inspect` sitt
  `RestartCount` er det som avslører den. Gir Docker opp for godt, oppdager
  `services/helse.ts` det på sitt neste sveip.

Vanligste årsak for begge: appen lytter på en hardkodet port i stedet for `$PORT`,
eller mangler en miljøvariabel den krever ved oppstart.

Uansett variant er den forrige versjonen urørt og fortsetter å svare på
subdomenet – se `03_deployment_flow.md`. Feiler *første* deployment, finnes det
ingen forrige, og subdomenet svarer 404 fra Caddys catch-all.

**En container heter ikke `snoat-app-<slug>` lenger.** Navnet har et
deployment-suffiks (`snoat-app-minapp-4f2a1c9b`), så `docker logs
snoat-app-minapp` gir «No such container». Slå opp på label i stedet:

```bash
docker ps --filter label=no.snoat.project-id=<project-id>
docker logs -f "$(docker ps -q --filter label=no.snoat.project-id=<project-id> | head -1)"
```

**Flere containere for samme prosjekt.** Normalt i noen sekunder under en
utrulling. Blir de stående, ble backend drept mellom helsesjekken og
oppryddingen. `reconcileRoutes()` logger en `warn` om det ved oppstart, ruter til
den containeren databasen sier er live, og lar restene stå. Neste deployment
rydder dem – eller gjør det for hånd:

```bash
# Hvilken container Caddy faktisk peker på:
curl -s -H "Origin: http://127.0.0.1:2019" \
  http://127.0.0.1:2019/id/snoat_app_<slug> | jq '.handle[0].upstreams'

# Alt Snoat eier, gruppert etter prosjekt:
docker ps --filter label=no.snoat.managed=true \
  --format '{{.Label "no.snoat.project-id"}}  {{.Names}}  {{.Status}}' | sort
```

Fjern kun containere som *ikke* står i upstream-listen over.

**Deployment feiler i `clone`-steget.** Repoer valgt gjennom repo-velgeren
klones med et installasjonstoken og kan være private. En URL limt inn for hånd
klones uten autentisering, og må da være offentlig. Feilmeldingen skiller mellom
de to tilfellene.

**`realtime` restarter i loop.** Tre miljøkrav som alle gir krasj i boot, ikke
en feilmelding du kan lese rett ut av API-et:

- `METRICS_JWT_SECRET` må være satt – v2.121.1 kaller `System.fetch_env!/1`.
- `DB_ENC_KEY` må være **nøyaktig 16 tegn** (AES-128). Er den lengre, får du
  `Erlang error: {:badarg, 'Bad key size'}`.
- `SECRET_KEY_BASE` må være minst 64 tegn.

`bootstrap-env.mjs` genererer og validerer alle tre. Har du en gammel `.env`
med en 32-tegns `DB_ENC_KEY`, byttes den ut ved neste kjøring.

**Backend når ikke Caddy admin-API-et (403).** «client is not allowed to access
from origin ''». Admin-API-et lytter på `0.0.0.0:2019` fordi backend står i en
egen container, og da håndhever Caddy `admin.origins`. `fetch` uten
`Origin`-header avvises (curl slipper gjennom, som gjør feilen forvirrende å
teste). Backend setter headeren eksplisitt i `lib/caddy.ts`.

**Ruter forsvant etter `docker compose restart caddy`.** Forventet – Caddy
startes fra en statisk config-fil. Restart backend, så bygger den rutene opp
igjen fra Supabase (`reconcileRoutes()`).

**Databasen har feil passord/nøkler.** `docker compose down -v` og opp igjen.
Init-scriptene kjører kun på en tom datakatalog.

## Nyttige kommandoer

```bash
docker compose logs -f backend      # følg bygge-motoren
docker compose ps                   # status på alle tjenester
docker ps --filter label=no.snoat.managed=true   # deployede brukerapper
curl -s http://127.0.0.1:2019/config/apps/http/servers/snoat/routes | jq  # Caddy-ruter
docker compose down                 # stopp
docker compose down -v              # stopp og slett databasen
./scripts/vendor-sync.sh            # hent referansekode på nytt
```

## Kvalitetssjekker

```bash
cd backend  && npx tsc --noEmit
cd frontend && npx tsc --noEmit && npx eslint src && npm run build
```

`tsc` i frontend rapporterer én kjent feil om at `vite-config.js` mangler typer.
Den er forhåndseksisterende og ikke knyttet til plattformkoden.

## Utelatt fra MVP-stacken

Supabase self-host består av flere tjenester enn vi kjører. Disse er bevisst
utelatt: Storage, imgproxy, Analytics (Logflare), Edge Functions og Supavisor.
Kong kjører uten `key-auth`-plugin – GoTrue og PostgREST validerer JWT-en selv,
så gatewayen gjør kun ruting og CORS.
