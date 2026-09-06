# Backend API

Implementert med Hono i `backend/src/routes/api.ts`. Tilgjengelig på
`http://api.snoat.localhost` (i compose) eller `http://127.0.0.1:3100` direkte.

## Autentisering

Alt under `/api` krever brukerens Supabase access-token:

```
Authorization: Bearer <supabase access_token>
```

Tokenet valideres av GoTrue via `supabase.auth.getUser(token)` – ikke ved at vi
verifiserer signaturen selv. Da fanger vi også opp tokens som er trukket
tilbake, ikke bare utløpte.

Frontend henter tokenet fra sesjonen i `frontend/src/lib/api.ts`.

### API-nøkler (maskin-til-maskin)

Integrasjoner sender en langlevd nøkkel i **samme header**:

```
Authorization: Bearer snoat_ak_<64 hex>
```

`requireAuth` skiller de to på `snoat_ak_`-prefikset. Rekkefølgen er ikke
tilfeldig: et ugyldig JWT ville ellers kostet et rundturs-kall til GoTrue før vi
i det hele tatt vurderte at det kunne være en nøkkel.

**En API-nøkkel *er* brukeren sin.** `userId` settes til eieren, og alt nedenfor
– `loadOwnedProject`, plangrensene, eierskapssjekkene – oppfører seg som om
vedkommende var innlogget. Det er hele poenget med byrå-modellen: en partner som
LeadLab er én konto hos oss, ikke et unntak spredt utover tilgangskoden.
`c.get("authKind")` er `"session"` eller `"api_key"` for de endepunktene som
trenger å vite forskjellen.

Nøkkelen lagres kun som sha256-hash (`public.api_keys`, migrasjon 0010). Den kan
derfor ikke vises igjen etter utstedelsen – mistes den, trekkes den tilbake og en
ny utstedes. Ingen salt eller bcrypt: inndata er 256 bits fra `randomBytes`, ikke
et passord, og verken saltet eller kostnaden har noe å bidra med da.

**Det finnes ingen HTTP-rute for å utstede nøkler**, og det er med vilje – et
endepunkt som utsteder legitimasjon må selv beskyttes av legitimasjon, og den
første nøkkelen har ingen å bli beskyttet av. Utstedelse skjer på serveren:

```bash
docker compose exec backend node dist/scripts/issue-api-key.js \
  --email partner@example.no --name leadlab-produksjon --plan agency
```

**To unntak:** `POST /api/webhooks/github` og `POST /api/webhooks/stripe` ligger
under `/api`, men utenfor `requireAuth` – hverken GitHub eller Stripe har en
Supabase-sesjon. Begge er signaturverifisert i stedet, og monteres før `api` i
`index.ts` for å komme foran middlewaren. Er du i tvil om en rute er beskyttet,
er registreringsrekkefølgen i `index.ts` svaret.

**CORS:** kun `SNOAT_FRONTEND_ORIGIN` slipper til (kommaseparert liste støttes).
Webhooken bryr seg ikke – GitHub sender ingen `Origin`-header, og CORS er en
nettleser-mekanisme.

## Endepunkter

### `GET /health`

Åpent. Sjekker de fire avhengighetene bygge-motoren trenger.

```json
{
  "status": "ok",
  "checks": {
    "docker":   { "ok": true },
    "caddy":    { "ok": true },
    "supabase": { "ok": true },
    "nixpacks": { "ok": true, "detail": "nixpacks 1.41.0" }
  }
}
```

Svarer `503` med `"status": "degraded"` og en `error`-streng per avhengighet som
er nede. Dette er førstevalget når noe ikke virker lokalt.

### `POST /api/projects`

Oppretter et prosjekt. **Dashboardet bruker ikke dette** – det skriver raden rett
i Supabase med sin egen sesjon og RLS. Endepunktet finnes for integrasjoner, som
ikke har noen sesjon å skrive med.

```json
{
  "name": "kundenavn",
  "repoUrl": "https://github.com/leadlab-sites/kundenavn-a1b2c3",
  "branch": "dev",
  "externalRef": "1f0c…",
  "githubInstallationId": 12345,
  "staticOutputDir": "out",
  "envVars": {}
}
```

`name` er subdomenet og valideres mot samme regex som check-constrainten i
databasen. `githubInstallationId` er det som gjør private repoer klonbare.
`staticOutputDir` gjør prosjektet statisk – ingen container, kun filer.

`branch` er grenen som skal bygges og deployes. **Utelates den – eller sendes den
som `null` eller tom streng – brukes repoets default branch**, som er standarden
og det plattformen alltid har gjort. Feltet styrer samtidig hvilke push-events
auto-deploy reagerer på; de to kan ikke settes hver for seg, fordi et prosjekt som
bygger `dev` men lytter på `main` ville rullet ut kode ingen ba om. Verdien
valideres mot samme regel som `assertSafeBranch()` i `services/git.ts` – den blir
et argument til `git clone`, så et navn som starter med bindestrek avvises med
400 (`--upload-pack=…` er kommandokjøring på byggeverten).

**`externalRef` gjør kallet idempotent.** Kalleren legger sin egen ID der, og et
gjentatt POST svarer `200` med `created: false` og den eksisterende raden i
stedet for å lage et nytt prosjekt. Uten det ville et nettverksbrudd etter at
raden ble skrevet, men før svaret kom fram, gitt kunden to prosjekter ved neste
forsøk. Unikheten er `(user_id, external_ref)`, så to partnere kan bruke samme
interne ID-er uten å kollidere.

| Kode | Betydning |
| --- | --- |
| 201 | Opprettet (`created: true`) |
| 200 | Fantes allerede, funnet via `externalRef` (`created: false`) |
| 400 | Ugyldig `name`, `repoUrl` eller `branch` |
| 409 | Navnet er i bruk av et annet prosjekt på samme konto |

⚠️ **Plangrensene håndheves ikke her**, like lite som for dashboardet. Et prosjekt
uten deployment koster ingenting; det er `startDeployment()` som sperrer.

### `PATCH /api/projects/:projectId`

Endrer konfigurasjon på et prosjekt som finnes. Alle feltene er valgfrie, og
**bare de som er med i kroppen røres** – `undefined` betyr «la stå», ikke «sett
til null».

```json
{
  "branch": "dev",
  "buildCommand": "npm run build",
  "envVars": { "DATABASE_URL": "…" },
  "staticOutputDir": "dist",
  "staticSpaFallback": true,
  "githubInstallationId": 12345
}
```

`branch: null` (eller `""`) setter prosjektet tilbake til repoets default branch.
At grenen kan endres i det hele tatt er poenget: en kunde som flytter
produksjonen fra `main` til `dev` skal ikke måtte opprette prosjektet på nytt og
miste subdomene, historikk og miljøvariabler. Endringen får effekt ved neste
deployment – og fra samme øyeblikk er det den nye grenen webhooken lytter på.

`envVars` **erstatter hele settet**. Hent prosjektet først og send med alle
nøklene som skal bestå.

### `DELETE /api/projects/:projectId`

Sletter prosjektet **og rydder opp etter det**: containere og Caddy-rute først,
raden etterpå.

Rekkefølgen er poenget. Frontend har historisk slettet raden direkte via
Supabase, og da blir containerne og ruten stående igjen – uten raden finnes ikke
lenger prosjekt-ID-en `no.snoat.project-id`-labelen peker på, så de må ryddes for
hånd av noen som først må finne ut at de er der. Feiler nedrivingen, beholdes
raden: et prosjekt vi fortsatt kan finne igjen er bedre enn en foreldreløs
container.

| Kode | Betydning |
| --- | --- |
| 200 | `{ "deleted": true }` |
| 409 | Et bygg pågår – vent til det er ferdig |
| 404 | Finnes ikke, eller tilhører noen andre |

### `POST /api/projects/:projectId/deploy`

Starter en deployment. Svarer **202** så snart raden finnes – byggingen kjører
videre i bakgrunnen, og klienten følger den via Supabase Realtime.

```json
{ "deployment": { "id": "…", "project_id": "…", "status": "queued", … } }
```

| Kode | Betydning |
| --- | --- |
| 202 | Deployment opprettet og startet |
| 401 | Mangler eller ugyldig token |
| **402** | **En plangrense er nådd** – for mange apper i drift, eller byggeminuttene er brukt opp |
| 404 | Prosjektet finnes ikke, eller tilhører noen andre |
| 409 | Prosjektet bygges allerede |

402 og 409 er bevisst forskjellige: 409 sier «prøv igjen om litt», 402 sier «dette
koster penger». Dashboardet skiller på koden for å vise oppgraderingsknappen.
Grensene håndheves i `startDeployment()` slik at også auto-deploy fra webhooken
går gjennom dem – se `12_billing_and_plans.md`.

### `POST /api/projects/:projectId/stop`

Fjerner Caddy-ruten og stopper **alle** containere prosjektet har, og setter
`projects.stopped_at`. Prosjektet og historikken beholdes.

```json
{ "stopped": true }
```

`stopped_at` er ikke en detalj: den er det eneste dashboardet kan se. Statusen
der utledes ellers av `deployments.status`, og et stopp rører ingen deployment –
uten kolonnen sto siden igjen og sa «Live» om en app som var borte. Den skrives
**etter** at containeren faktisk er fjernet, og en feilet skriving logges uten å
velte svaret: appen *er* nede, det er bare dashboardet som ikke fikk vite det.

Neste `POST /deploy` nullstiller feltet, og frigjør samtidig plassen appen la
beslag på i plangrensen – en Free-bruker som stopper én app kan altså starte en
annen med en gang (`12_billing_and_plans.md`).

Flertallsformen er ikke pedanteri: siden utrullingen er rullerende, kan et
prosjekt ha mer enn én container samtidig – normalt i noen sekunder midt i en
deployment, og varig hvis backend ble drept før oppryddingen. `teardownProject()`
slår derfor opp på labelen `no.snoat.project-id` og tar alt den finner, ikke bare
containeren som svarer til det gamle navnet `snoat-app-<slug>`.

Svarer 409 hvis en build pågår. Låsen er viktigere nå enn før: et `/stop` midt i
en deployment kunne ellers fjernet ruten pipelinen er i ferd med å bytte.

### `GET /api/deployments/:deploymentId`

Status og logger for én deployment.

```json
{ "deployment": { "id": "…", "status": "building", "logs": "…", … } }
```

Finnes for skript og feilsøking. **Dashboardet bruker Realtime i stedet** – ikke
poll dette endepunktet i UI-kode.

### `GET /api/projects/:projectId/analytics`

Hele statistikkfanen i ett kall.

Spørreparametere: `from` og `to` i millisekunder, og `unit` (`hour` | `day` |
`month`). Alle er valgfrie og **klamres i backend** – et omvendt intervall
snus, en NaN får en standardverdi, og vinduet kappes til 400 dager. Uten det
kunne en bruker be om ti år i timesoppløsning og legge ned databasen
plattformen deler med alt annet.

```json
{
  "totals": { "pageviews": 1240, "visits": 380, "requests": 9800,
              "bytes_out": 41203441, "errors_4xx": 12, "errors_5xx": 0,
              "bot_requests": 210, "avg_duration_ms": 34 },
  "visitors": 352,
  "series": [{ "t": "2026-08-06T22:00:00+00:00", "pageviews": 84,
               "visits": 31, "requests": 640, "errors": 0 }],
  "dims": { "path": [{ "value": "/", "hits": 512 }], "referrer": [ … ] },
  "unit": "day"
}
```

Tallene kommer fra Caddys access-logg, ikke fra et sporingsskript – se
`services/analytics-ingest.ts`. Det finnes derfor **ingen** endepunkter for å
registrere et prosjekt for måling eller hente en sporingskode; det er ingenting
å sette opp.

`series` har en bøtte per intervall også der det ikke var trafikk, slik at en
stille uke ikke tegnes som en tettpakket uke med lave tall. `dims` inneholder
alle dimensjonene samtidig, så fanebytte i UI-et koster ingen nettverkstrafikk.

Feiler databasen, svarer endepunktet **200 med nullverdier**, ikke 5xx.
Statistikk er dashboardets minst kritiske fane og skal ikke gi kunden en
feilside.

### `GET /api/github/status`

Hva dashboardet trenger for å tegne repo-velgeren i «Nytt prosjekt».

```json
{
  "configured": true,
  "connected": true,
  "installations": [{ "installationId": 12345, "accountLogin": "frostbyte", "accountType": "Organization" }],
  "installUrl": "https://github.com/apps/snoat/installations/new?state=…"
}
```

`configured: false` betyr at GitHub App-en ikke er satt opp på denne
installasjonen. Dashboardet skjuler da velgeren og viser kun URL-feltet.

### `GET /api/github/repos`

Repoene brukeren har gitt Snoat tilgang til, på tvers av installasjoner, sortert
med sist oppdaterte først.

```json
{ "repos": [{ "id": 1, "fullName": "frostbyte/api", "private": true, "cloneUrl": "…", "installationId": 12345 }] }
```

Er en installasjon fjernet på GitHub-siden, svarer GitHub 404. Da slettes den
foreldede raden vår og listen bygges videre fra de øvrige installasjonene –
én død kobling skal ikke ta ned hele velgeren.

Svarer `503` når App-en ikke er konfigurert.

### `GET /api/github/branches?repo=…`

Grenene i ett repo, til grenvelgeren i dashboardet. `repo` kan være en klone-URL
eller `owner/repo`; begge normaliseres av `repoIdentity()`, av samme grunn som i
webhooken – `projects.repo_url` finnes i alle varianter, og velgeren skal virke
uansett hvilken som er lagret.

```json
{ "repo": "frostbyte/api", "installationId": 12345, "defaultBranch": "main", "branches": ["main", "dev"] }
```

`defaultBranch` er med fordi det er den grenen «ingen gren valgt» *betyr*. Uten
navnet kunne dashboardet bare skrive «standardgren», og brukeren måtte gjette
hvilken.

⚠️ **Installasjonen kommer aldri fra klienten.** Endepunktet går gjennom kontoens
egne koblinger og bruker den første som faktisk rekker repoet. Tok det imot en
`installationId` fra forespørselen, ville det vært en vei til å lese grenlisten i
andres private repoer med et gjettet tall – `installation_id` er ingen
hemmelighet.

| Kode | Betydning |
| --- | --- |
| 200 | Grenene, med `defaultBranch` |
| 400 | `repo` mangler, eller er ikke et repository vi kjenner igjen |
| 404 | Ingen av kontoens GitHub-koblinger rekker repoet |
| 503 | App-en er ikke konfigurert |

404 er bevisst ikke en tom liste: en tom liste leses som «repoet har ingen
grener», og dashboardet skal da falle tilbake til et validert tekstfelt – ikke
vise en nedtrekksliste som lyver.

### `GET /api/pricing?market=no|eu`

**Offentlig – utenfor `requireAuth`.** Plankatalogen landingssiden viser til folk
uten konto. Samme katalogfunksjon som `/api/billing`, slik at prissiden og
dashboardet ikke kan komme i utakt.

⚠️ Montert **før** `app.route("/api", api)` i `index.ts`, av samme grunn som
webhookene. Flyttes linjen ned, får landingssiden 401.

```json
{
  "market": { "id": "eu", "currency": "eur", "locale": "en-IE", "displayVatRate": null, "invoiceChannel": "email" },
  "plans": [{ "id": "pro", "price": 1900, "priceIncludingVat": null, "currency": "eur", "purchasable": true, "limits": {} }]
}
```

### `GET /api/billing?market=no|eu`

Alt betalingssiden trenger: gjeldende plan, status, grenser, forbruk og
plankatalogen med priser. Katalogen kommer fra backend fordi det er backend som
håndhever grensene – står de to stedene, sier prissiden og virkeligheten før
eller siden ulike ting.

```json
{
  "plan": "pro",
  "billedPlan": "pro",
  "status": "active",
  "downgraded": false,
  "graceEndsAt": null,
  "currentPeriodEnd": "2026-09-01T00:00:00.000Z",
  "limits": { "maxRunningProjects": 10, "memoryMb": 1024, "cpus": 1, "buildMinutesPerMonth": 500, "queuePriority": 10 },
  "usage": { "runningProjects": 2, "totalProjects": 4, "staticProjects": 1, "buildMinutesUsed": 37 },
  "plans": [{ "id": "pro", "price": 19900, "priceIncludingVat": 24875, "currency": "nok", "purchasable": true, "limits": {} }],
  "market": { "id": "no", "currency": "nok", "locale": "nb-NO", "displayVatRate": 0.25, "invoiceChannel": "ehf" },
  "marketLocked": true,
  "billingCountry": "NO",
  "stripeConfigured": true,
  "portalAvailable": true
}
```

`plan` er den **effektive** planen (den grensene regnes ut fra), `billedPlan` er
den kunden betaler for. De er ulike bare når en betaling har feilet og
nådefristen er utløpt.

⚠️ `market`-parameteren er et **ønske**, ikke en beslutning. Har kunden et
abonnement, er valutaen låst hos Stripe, og svaret kommer i den valutaen med
`marketLocked: true` – uansett hva klienten ba om. `price` er i **minste enhet**
av `currency` (øre eller cent), og `priceIncludingVat` er null når satsen
avhenger av kundeland. Se `12_billing_and_plans.md`.

### `POST /api/billing/checkout`

Oppretter en Stripe Checkout-sesjon. Body:
`{ "plan": "pro" | "business", "market": "no" | "eu", "projectId"?: string }`.
Svarer `{ "url": "https://checkout.stripe.com/…" }`.

Planen settes **ikke** her – kun av webhooken når betalingen er bekreftet. Ellers
ville en kunde som lukket fanen i kassen fått Pro gratis.

| Kode | Betydning |
| --- | --- |
| 200 | Sesjon opprettet |
| 400 | Ukjent plan |
| 503 | Stripe eller price-ID-en er ikke konfigurert |
| 502 | Stripe svarte med en feil |

### `POST /api/billing/portal`

Lenke til Stripes kundeportal, der kunden bytter kort, laster ned kvitteringer og
sier opp selv. Svarer `{ "url": … }`, eller 404 hvis kunden ikke finnes i Stripe.

### `POST /api/webhooks/stripe`

**Utenfor `requireAuth`, selv om den ligger under `/api`** – samme mekanikk som
GitHub-webhooken, og montert før `/api` i `index.ts` av samme grunn.

⚠️ **Forskjellen fra GitHub-webhooken:** er `STRIPE_WEBHOOK_SECRET` tom, avvises
alt med **503**. GitHub-varianten tar imot uverifisert med en advarsel, fordi det
verste som skjer er et uønsket bygg. Her er det verste at hvem som helst kan
POST-e seg til Business-planen.

| Kode | Betydning |
| --- | --- |
| 200 | Behandlet, ignorert, eller en duplikatlevering |
| 401 | Signaturen stemmer ikke, eller mangler |
| 413 | Body over 1 MB |
| 500 | Kunne ikke lagre – Stripe prøver igjen (låsen frigis først) |
| 503 | Stripe er ikke konfigurert på denne installasjonen |

### `POST /api/webhooks/github`

**Utenfor `requireAuth`, selv om den ligger under `/api`.** GitHub kaller denne
ved push, og har ingen Supabase-sesjon å sende med. Tilliten hviler på
HMAC-signaturen i `x-hub-signature-256`, verifisert mot `GITHUB_WEBHOOK_SECRET`.
Ruten monteres derfor **før** `/api` i `index.ts` – se `03_deployment_flow.md`.

Starter en deployment av hvert prosjekt hvis `repo_url` peker på repoet i
payloaden **og prosjektet deployer fra grenen som ble pushet** – altså
`projects.branch`, eller repoets `default_branch` når feltet er NULL. Vurderingen
er per prosjekt: to prosjekter på samme repo med ulike grener får hver sin
avgjørelse av samme push.

```json
{
  "received": true,
  "repository": "frostbyte/api",
  "branch": "main",
  "message": "frostbyte/api@main: 1 deployment startet",
  "results": [{ "projectId": "…", "project": "api", "status": "deploying", "deploymentId": "…" }]
}
```

| Kode | Betydning |
| --- | --- |
| 200 | Mottatt, men ingenting å gjøre (`ping`, annet event, tag, ukjent repo, eller ingen prosjekter som deployer fra den pushede grenen) |
| 202 | Minst ett prosjekt matchet. `results[]` sier `deploying` eller `already_building` per prosjekt |
| 400 | Payloaden kunne ikke tolkes, eller mangler `repository.full_name` |
| 401 | Ugyldig eller manglende signatur |
| 413 | Body over 5 MB |
| 500 | Databasen svarte ikke – bruk «Redeliver» hos GitHub |

Merk at et prosjekt som allerede bygges gir **202**, ikke 409: en push under en
pågående build er forventet, og skal ikke se ut som en leveringsfeil hos GitHub.

Er `GITHUB_WEBHOOK_SECRET` tom, tas forespørselen imot **uten** signaturkontroll,
med en advarsel i loggen. Se `08_security_model.md`.

### `POST /api/github/installations`

`/github/setup` uten nettleseren. Registrerer en installasjon på den som kaller:
`{ "installationId": 12345 }` → `201` med kontoen.

Setup-ruten får ID-en som en query-parameter i en redirect og verifiserer
avsenderen med en HMAC-signert `state` – en mekanikk som forutsetter at det
finnes en nettleser å redirecte. En integrasjon kjører installasjonsflyten i sitt
eget UI og sitter igjen med ID-en; da mangler den bare et sted å levere den.
Tilliten hviler her på API-nøkkelen i stedet for på `state`, men vi spør fortsatt
GitHub om installasjonen finnes før vi lagrer – ID-en kommer utenfra.

Svarer `404` hvis GitHub ikke kjenner installasjonen, og `503` hvis App-en ikke
er konfigurert.

### `GET /github/setup`

**Utenfor `/api`, og uten `requireAuth`.** GitHub sender nettleseren hit etter
en installasjon, uten Authorization-header. Tilliten hviler på `state`, som er
HMAC-signert av oss og inneholder bruker-ID-en, og på at vi spør GitHub om
installasjonen faktisk finnes før koblingen lagres.

Svarer alltid med en redirect til dashboardet: `?github=connected` eller
`?github=error&reason=…`.

## Feilformat

Alle feil svarer med samme form:

```json
{ "error": "Prosjektet bygges allerede. Vent til den kjørende buildet er ferdig." }
```

Meldingene er på **norsk og ment for loggen**, ikke for et flerspråklig
dashboard. Feil som skal vises til kunden bærer i tillegg en maskinlesbar kode:

```json
{
  "error": "Du har brukt 100 av 100 byggeminutter denne måneden. …",
  "code": "plan.build_minutes_exhausted",
  "params": { "used": 100, "limit": 100 }
}
```

Frontend slår opp `code` i `errors`-seksjonen av oversettelsene og interpolerer
`params`. Grunnen til at backend ikke skriver ferdig kundetekst er at den **ikke
kjenner visningsspråket** – en auto-deploy fra en GitHub-push har ingen bruker i
den andre enden i det hele tatt.

**Bare feil som er ment for kunden har kode.** En byggefeil fra Nixpacks er
diagnostikk blandet med verktøy-output, og frontend faller da tilbake på
`error`-teksten. Kodene som finnes står i `12_billing_and_plans.md`.

## Ikke implementert

- **`installation`-eventet.** Webhook-mottaket håndterer kun `push`. Blir App-en
  avinstallert, oppdager vi det fortsatt ikke før neste gang repo-listen hentes
  og GitHub svarer 404 (`08_security_model.md`).
- **Rate limiting.** Ingenting hindrer en bruker i å trigge mange builds på rad
  utover `409`-låsen per prosjekt. Med API-nøkler er dette mer relevant enn før:
  en integrasjon i en løkke har ingen menneskelig hånd som stopper den. Foreløpig
  er `buildMinutesPerMonth` på byråplanen det eneste taket.
- **Rettighetsskille for API-nøkler.** `authKind` finnes, men ingen endepunkter
  leser den ennå: en nøkkel kan i dag også kalle `/api/billing/checkout`. Det er
  ufarlig (en Stripe-kasse må fullføres i en nettleser), men skillet bør bli
  ekte før nøkler deles ut til flere partnere.
- **`DELETE /api/projects/:id` finnes nå**, men frontend bruker den ikke – den
  sletter fortsatt raden direkte via Supabase, med de foreldreløse containerne
  det gir. Ruten er der; kallstedet mangler.

## Dev-sider og passordbeskyttelse (migrasjon 0013)

| Metode | Sti | Gjør |
| --- | --- | --- |
| `POST` | `/api/projects/:id/dev-sites` | Oppretter en dev-side. Kropp: `{ branch, password }`. Svarer 201 med den nye prosjektraden. Bygger **ikke**. |
| `GET` | `/api/projects/:id/dev-sites` | Dev-sidene som hører til prosjektet. |
| `PATCH` | `/api/projects/:id/access` | Setter passordet foran appen. `{ password: null }` fjerner det. Caddy-ruten skrives om umiddelbart. |

`POST` svarer **409** og ikke 400 på det kunden kan rette: grenen har allerede en
dev-side (`dev_site.already_exists`), eller raden er selv en dev-side
(`dev_site.parent_is_dev_site`). Forespørselen er velformet – det er tilstanden
som ikke tillater den.

Bygget startes ikke av `POST`. Opprettelse og utrulling er to beslutninger, samme
skille som `POST /api/projects` har. Dashboardet kaller `deployProject()` selv rett
etter, fordi ingen lager en dev-side for å la den stå tom – men et maskin-API skal
kunne opprette miljøet uten å betale for et bygg.

`PATCH /access` gjelder alle prosjekter, ikke bare dev-sider: «legg et passord
foran denne appen» er like nyttig for en kundedemo eller en app som ikke er klar.

### Statistikk krever betalt plan

`GET /api/projects/:id/analytics` svarer **402** med koden
`plan.analytics_requires_paid` på gratisplanen. Sperren står i endepunktet og ikke
bare i dashboardet fordi `snoat_get_analytics` over MCP treffer det samme
endepunktet – en skjult fane er ingen grense.
