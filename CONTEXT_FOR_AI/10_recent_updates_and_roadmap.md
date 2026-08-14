# 10. Nylige Oppdateringer og Vercel-sammenligning (Roadmap)

Denne filen dokumenterer nye funksjonaliteter og forbedringer som er innført i Snoat, samt sammenligningen mot Vercel og planlagte utvidelser.

---

## 1. Byggetidsporing (Build Duration Tracking)

For å gi brukeren full innsikt i hvor lang tid hver deployment tar:

### Backend (`backend/src/services/deploy.ts`)
* Pipelinen beregner varighet fra `started = Date.now()` til bygget enten ferdigstilles eller feiler.
* Skriver en standardisert linje i byggeloggen ved fullført deployment:
  * Suksess: `\nFerdig på X.Ys.`
  * Feilet: `\nFeilet etter X.Ys.`

### Frontend (`frontend/src/routes/projects.$projectId.tsx`)
* **Realtids-timer (`useBuildDuration`):** Mens en deployment har status `queued` eller `building`, teller en intervall-hook opp sekunder og minutter live i grensesnittet (e.g. `Bygger: 14s` / `Bygger: 1m 05s`).
* **Varighet for historiske bygginger (`getDeploymentDuration`):** Parser loggen for ferdigstilte/feilede deployments og viser eksakt byggetid i:
  * **Seneste Deployment-kortet**
  * **Build Stage-kortet**
  * **Deployment History-tabellen**

---

## 2. Eksplisitte Avslutningsindikatører i Terminalen

For at brukeren enkelt skal se når byggeloggen ikke lenger aktivt kjører:

### Eksplisitte bannere i Byggeloggen (`deploy.ts`)
Ved fullført eller feilet deployment skrives et tydelig avslutningsbanner i `deployments.logs`:
```text
====================================================================
[SNOAT] ✓ BYGGING FULLFØRT (12.4s) — Prossessen er avsluttet.
====================================================================
```
eller
```text
====================================================================
[SNOAT] ✗ BYGGING FEILET (nixpacks etter 8.2s) — Prossessen er avsluttet.
====================================================================
```

### UI Terminalindikatorer (`TerminalTab.tsx` & `DeploymentLogsDialog.tsx`)
* **Header-statustagg:** Viser status i sanntid:
  * `🟢 Bygger nå…` (blå pulserende)
  * `✓ Prosess avsluttet (Suksess)` (grønn)
  * `✗ Prosess avsluttet (Feilet)` (rød)
* **Bunnlinje i terminalvisningen:** Viser `Process finished with exit code 0` / `Process terminated with error code 1` sammen med teksten `Terminaløkt avsluttet`.

---

## 3. Global Språkveksler (`<LanguageSwitcher />`)

* `LanguageSwitcher`-komponenten er integrert i `DashboardNav.tsx` og toppmenyen på prosjektsiden `projects.$projectId.tsx`.
* Språkveksleren (Norsk/Engelsk) er dermed tilgjengelig kontinuerlig på tvers av hele plattformen (Landingsside, Login/Auth, Dashboard og Prosjektdetaljer).

---

## 4. Automatisk Deployment ved Push (GitHub Webhooks)

Deployments utløses ikke lenger bare av «Deploy»-knappen. Ved en push til
hovedgrenen bygger og ruller Snoat ut den nye versjonen selv – samme løfte som
Vercel gir, uten at koden forlater norsk infrastruktur.

### Backend (`backend/src/routes/webhooks.ts`)
* **Nytt offentlig endepunkt:** `POST /api/webhooks/github`. Ligger under `/api`,
  men utenfor `requireAuth` – GitHub har ingen Supabase-sesjon. Monteres derfor
  **før** `/api` i `index.ts`, siden Hono matcher handlere i
  registreringsrekkefølge.
* **Signaturverifisering:** `x-hub-signature-256` sjekkes mot
  `GITHUB_WEBHOOK_SECRET` med HMAC-sha256 over råkroppen og `timingSafeEqual`.
  Er secreten ikke satt, tas webhooken imot uverifisert med en `warn` i loggen –
  en bevisst, dokumentert åpning (`08_security_model.md`).
* **Eventfiltrering:** `ping` svarer `pong`; kun `push` behandles. Tags, slettede
  grener og alle andre grener enn repoets `default_branch` kvitteres og ignoreres.
* **Prosjektoppslag:** `repository.full_name` og `projects.repo_url` normaliseres
  begge til `owner/repo` i små bokstaver (`repoIdentity()` i `lib/github.ts`), slik
  at `.git`-suffiks, skråstrek til slutt og vilkårlig case likevel treffer. Flere
  prosjekter kan peke på samme repo – alle bygges.
* **Trigger:** `startDeployment(project)` per treff, som gir nøyaktig samme
  rullerende utrulling som en manuell deploy.

### Robusthet
* Ingenting i mottaket kaster videre – alt logges med `pino`, beriket med
  `x-github-delivery` for å kunne krysspeiles mot GitHubs leveringslogg.
* Body-tak på 5 MB, siden ruten er åpen.
* `startDeployment()` fanger nå avvisninger fra bakgrunnspipelinen eksplisitt. En
  unhandled rejection avslutter Node-prosessen, og med builds som starter av seg
  selv skal ikke én rar deployment kunne velte backend for alle brukere.

### Gjenstår
* **Deploy-preview per gren/PR.** Kun hovedgrenen bygges; ingen midlertidig URL
  per pull request. Dette er den største gjenværende forskjellen mot Vercel på
  dette området.
* **`installation`-eventet.** Avinstallasjon av App-en oppdages fortsatt først
  ved neste repo-listing.
* **Trigger-kilden vises ikke i UI.** `deployments` har ingen kolonne som skiller
  en webhook-build fra en manuell.
* **Rate limiting.** Låsen er per prosjekt; ingenting begrenser totalen.

---

## 5. E-post, passordgjenoppretting og byggemiljø (29.–30. juli 2026)

### E-post via Resend

GoTrue sender nå bekreftelse- og gjenopprettingse-post over SMTP mot Resend, med
norske maler og norske emnefelt. `ENABLE_EMAIL_AUTOCONFIRM` er skrudd av i både
dev og produksjon.

Malene serveres av en ny container, `mail-templates`, fordi
`GOTRUE_MAILER_TEMPLATES_*` tar en URL og ikke en filsti. Detaljer i
`07_local_development.md`, sikkerhetsbegrunnelsen i `08_security_model.md`.

### Passordgjenoppretting

To nye ruter: `/forgot-password` og `/reset-password`. Flyten er verifisert
ende-til-ende i produksjon, inkludert på en konto opprettet via GitHub SSO **uten
passord** – gjenopprettingslenken er den eneste trygge veien til å legge passord
på en OAuth-konto, fordi innboksen er beviset på eierskap.

`/forgot-password` gir samme kvittering uansett om adressen finnes, slik at
skjemaet ikke blir et oppslagsverk over registrerte brukere.

### Byggemiljø

`backend/Dockerfile` installerer nå `docker-buildx` som CLI-plugin. Uten den
feilet **hver** deploy, fordi Docker CLI 27 har BuildKit på som standard og den
statiske docker-tarballen ikke inneholder plugins. Se `03_deployment_flow.md`.

### Deploy-verifisering

`scripts/deploy.sh` har fått en preflight for manglende hemmeligheter og en reell
konfigurasjonsverifisering. Tidligere rapporterte deployen suksess på en no-op.
Bakgrunnen og `preserved()`-fellen står i `09_production_deployment.md`.

### Kapasitet

`studio` og `meta` er flyttet bak compose-profilen `studio` og kjører ikke i
produksjon – de brukte 250 MB på en boks med 1 kjerne og 1,9 GB RAM. VPS-en er
underdimensjonert for å bygge og drifte samtidig; målinger og anbefalinger i
`09_production_deployment.md`.

### Gjenstår

- ~~Swap på VPS-en~~ – 4 GB swap opprettet 30. juli 2026, se seksjon 7.
- ~~Heve `SNOAT_BUILD_TIMEOUT_MS`~~ – standard er nå 30 min.
- Oppgradere VPS-en. Dette er den reelle fiksen for byggetid.
- Installere GitHub App-en `snoatauth` (0 installasjoner), og bekrefte at Setup
  URL peker på `https://api.snoat.com/github/setup`.

## 6. Node-versjon for brukerprosjekter (30. juli 2026)

Nixpacks faller tilbake på **Node 18** når et repo ikke oppgir noen versjon.
Node 18 er ute av vedlikehold, og Next.js 15+, Vite 6+ og
`@supabase/supabase-js` avviser den. Et prosjekt uten `engines`-felt døde derfor
på `npm run build` med `You are using Node.js 18.20.5. For Next.js, Node.js
version ">=20.9.0" is required.` – uten at brukeren hadde gjort noe galt. Dette
traff alle nye prosjekter, ikke enkelttilfeller.

`backend/src/services/runtime-versions.ts` leser nå det klonede repoet før
byggekommandoen settes sammen, og sender `NIXPACKS_NODE_VERSION` **kun** når
repoet ikke bestemmer selv (`engines.node`, `.nvmrc`, `.node-version` eller en
`nixpacks.toml`). Standarden styres av `SNOAT_DEFAULT_NODE_VERSION` (`22`), og en
`NIXPACKS_NODE_VERSION` satt under Miljøvariabler vinner over alt. Valget logges
i byggeloggen. Tabellen og presedensrekkefølgen står i `03_deployment_flow.md`
steg 4.

Modulen er en tabell over kjøretider, så samme mønster kan brukes den dagen
Nixpacks-standarden for Python eller Go blir for gammel.

---

## 7. Minnehendelsen 30. juli 2026 og vernene som kom av den

**Hva skjedde.** Den gamle VPS-en gikk tom for minne under et
Next.js-bygg. `kswapd0` låste seg på 97 % system-CPU i et forsøk på å frigjøre
minne som ikke fantes, SSH-tilkoblinger timet ut med «Broken pipe», og
**snoat.com sluttet å svare i det hele tatt** – Postgres og Caddy står på samme
boks som byggingen. Dashboardet ble stående på «Bygger: 55m 06s» på en
byggeprosess som var død for lenge siden.

**Hvorfor timeouten ikke reddet oss.** `SNOAT_BUILD_TIMEOUT_MS` håndheves av
`execa` inne i backend-prosessen – som satt på den samme utsultede verten. Node
fikk ikke kjørt timeren sin. En vakt som deler skjebne med det den skal vokte er
ingen vakt; det er kapasitetsgrensene under som faktisk hindrer situasjonen.

**Tiltak på serveren.** 4 GB swap opprettet og lagt i `/etc/fstab`:

```bash
fallocate -l 4G /swapfile && chmod 600 /swapfile
mkswap /swapfile && swapon /swapfile
echo '/swapfile none swap sw 0 0' >> /etc/fstab
```

`swapon` virker umiddelbart – reboot er ikke nødvendig for at swappen skal gjelde.

**Tiltak i koden.**

- **Global byggekø.** `SNOAT_MAX_CONCURRENT_BUILDS` (standard 1). `inFlight` låste
  kun per prosjekt, så to kunder kunne bygge samtidig på en boks som knapt tåler
  én. Ventende deployments ligger i `queued` med en kølinje i byggeloggen.
- **Rydding av foreldreløse deployments.** `failOrphanedDeployments()` kjøres ved
  oppstart og merker alt som står i `queued`/`building` som `failed` med en
  forklaring. Det var dette som manglet da panelet sto på «Bygger: 55m».
- **Minnetak per build.** `SNOAT_BUILD_NODE_MEMORY_MB` (standard 1536) injiseres
  som `NODE_OPTIONS`. Et bygg som spiser for mye feiler nå for seg selv i stedet
  for å ta ned plattformen. `containers.ts` overstyrer taket ved kjøring, slik at
  build-verdien ikke lekker inn i en container med 512 MB.
- **`SNOAT_BUILD_TIMEOUT_MS` hevet til 30 min**, som `03_deployment_flow.md` har
  anbefalt siden den kalde nix-builden ble målt.

**Cache-invalidering er verdt å huske.** Endringen til Node 22 (seksjon 6) ga et
nytt nixpkgs-sett og dermed en ny BuildKit-lagnøkkel. Første bygg etterpå betalte
full nix-provisjonering på nytt – 8–15 min med nesten ingen logg. Det er ventet,
men det ser identisk ut med en hengt build, og det var den byggingen som veltet
maskinen. Enhver endring i pakkesettet bør derfor varmes opp bevisst.

**`scripts/deploy.sh`.** Bruker nå `-i $SSH_KEY -o IdentitiesOnly=yes`, fordi ssh
ellers tilbyr alle nøkler i agenten og havner på passordprompt før den riktige er
prøvd. Måladressen kan overstyres med `SNOAT_VPS_IP` og skrives ut ved oppstart –
det finnes en annen server på `38.87.117.167` (Coolify/mittvel.no) som ikke har
noe med dette scriptet å gjøre.

---

## 8. Statiske sider uten container (30. juli 2026)

**Problemet.** Alle prosjekter kjørte som container, også de som bare produserer
filer. En Astro- eller Vite-side fikk et image, en container 24/7, et minnetak på
512 MB og en `reverse_proxy`-rute – full dynamisk pris for noe som er HTML på en
disk. Det er den enkeltposten som avgjør hvor mange brukere plattformen tåler:
300 statiske sider som containere er titalls GB RAM, som filer er de ~0.

**Løsningen.** `projects.static_output_dir` peker på katalogen i byggeresultatet.
Er den satt, kjører `services/static-site.ts` `docker create` (image-et startes
aldri), kopierer ut katalogen med `docker cp`, og Caddy får en `file_server`-rute
i stedet for `reverse_proxy`. Ingen container, null RAM når ingen besøker siden.
Sidene blir samtidig raskere – filer fra disk slår en Node-prosess som svarer på
vegne av de samme filene.

`static_spa_fallback` avgjør om en URL uten treff gir 404 (riktig for Astro og
Hugo) eller `index.html` (nødvendig for SPA-er med klientruting). Detaljene og
presedensen står i `03_deployment_flow.md` steg 4b.

**Vi gjetter ikke.** Feltet settes av brukeren. En automatisk deteksjon som tar
feil på en vanlig Next.js-app gir en side som ser levende ut helt til noe
server-side kalles, og det er verre enn å kjøre en container for mye. Vercel
gjør det samme – deres «Output Directory» er en innstilling med
framework-baserte standardverdier, ikke magi.

**Bieffekt: tilbakerulling for statiske sider er nesten gratis.**
`SNOAT_STATIC_KEEP_VERSIONS` (standard 3) beholder tidligere versjoner på disk,
så «rull tilbake» blir et rutebytte i stedet for en ny build. For containere står
det fortsatt som ikke implementert.

**Verifisert mot ekte Caddy 2.11.4**, samme versjon som produksjon: begge
rutevariantene, atomisk PATCH ved redeploy, tilbakelesing av `root` fra begge
formene, og rollback fra statisk til container og tilbake. Uthentingen er testet
mot et ekte image, inkludert feil katalog, tom katalog, manglende `index.html` og
stier som forsøker `..`, absolutt sti og skall-metategn.

**Gjenstår**

- Dvale for *dynamiske* apper. Statiske sider koster nå ingenting, men en
  alltid-på container gjør det fortsatt. Krever en «waker» foran Caddy.
- Per-bruker-tak i byggekøen. Køen er FIFO med én plass: en bruker med ti
  prosjekter som pusher samtidig sulter ut alle andre.
- Trafikk- og diskkvoter per prosjekt. Ingen i dag.
- Automatisk `docker image prune` etter utrulling.

---

## 9. Innebygd Statistikk (Analytics)

Snoat inkluderer nå en dedikert `AnalyticsTab` for hvert prosjekt. Denne funksjonen tilbyr besøksstatistikk og ytelsesdata til brukeren, lik Vercel Web Analytics, men bygget med en personvernsfokusert, script-fri tilnærming.

**Teknisk implementasjon:**
- Data hentes direkte fra Caddys access-logger på proxy-nivået, ikke via et JavaScript-sporingsscript injisert i kundens frontend.
- Siden vi opererer på nettverkslaget kan plattformen måle **nøyaktig responstid, serverfeil (5xx) og faktisk båndbreddeforbruk** – tall et klient-script aldri vil se.
- Ingen cookies settes, noe som gjør løsningen 100 % GDPR-kompatibel ut av boksen uten krav til samtykkebannere.
- Fanen viser KPIs (unike besøkende, totalt antall klikk, båndbredde, feilrate, gjennomsnittlig svartid) og distribusjonsdata (mest besøkte stier, trafikkilder, nettlesere, enheter og land).

---

## 10. Oppgradert Faktureringsgrensesnitt

Abonnementshåndteringen er nå trukket direkte inn i det enkelte prosjekt. 
- En ny `ProjectPlanCard`-komponent (skjult i en accordion under prosjektinnstillinger) lar kunden se og oppgradere sin egen plan direkte fra prosjektet.
- Dette erstatter den tidligere globale innstillingssiden for fakturering, og gjør at grensene (Free, Pro, Business) presenteres der brukeren faktisk føler på kapasitetsbehovene.

---

## 11. Sammenligning mot Vercel & Roadmap

### Hovedforskjeller mellom Vercel og Snoat
1. **Edge Network & CDN:** Vercel har 300+ edge-lokasjoner globalt. Snoat har sitt fokus på **norsk datasuverenitet** på lokal norsk infrastruktur (Frostbyte Group AS).
2. **Serverless vs Containere:** Vercel kjører lambda/edge functions (skalerer til 0). Snoat kjører dedikerte, persisterte OCI/Docker-containere (Nixpacks + Dockerode).
3. **Zero-downtime & Webhooks:** Snoat har i sin nåværende arkitektur rullerende oppdateringer via Caddy, og støtter manuell samt webhook-trigget bygging.
4. **Custom Domains & DNS:** Snoat ruter internt via Caddy. En egen enkel DNS-fane i dashboardet gir brukeren mulighet til å skrive inn sitt domene, hvorpå DNS-oppføringene (A og CNAME) genereres dynamisk i en ren vertikal liste med kopieringsknapper for hver verdi. Fanen er foreløpig **kun veiledning** – selve rutingen og sertifikatet for et eget domene er ikke implementert. Detaljene og det som gjenstår ligger i `11_custom_domains_and_dns.md`.
5. **Byggetid:** Vercel bruker ferdigbakte byggeimages og bygger for de fleste rammeverk *ikke* et container-image – bygget kjører på en dedikert maskin og pakkes som statiske filer pluss functions. Snoat provisjonerer verktøykjeden med Nix under bygget og committer fulle OCI-lag, på én delt CPU-kjerne. Nix-steget caches per nixpkgs-revisjon, så det er første build som er dyr – men maskinvaren er den dominerende forskjellen. Se `03_deployment_flow.md` og `09_production_deployment.md`.

---

## 10. Trafikkanalytikk og Besøksstatistikk (7. august 2026)

Snoat måler trafikk **fra Caddys access-logg**, ikke fra et sporingsskript.

### Hvorfor loggen og ikke JavaScript

Første forsøk var Umami i egen container, med automatisk injisering av
`<script>`-taggen i kundens kildekode før bygg. Den ble forkastet før den nådde
produksjon, av fire grunner som alle er strukturelle:

1. **Den samlet aldri data.** Den globale CORS-middlewaren låste origin til
   dashboardet, så nettleserens preflight mot `/api/send` feilet for hvert
   eneste treff fra en kundeapp.
2. **Injeksjonen dekket bare halve økosystemet.** `index.html` og `layout.tsx`
   traff Vite og Next.js, men ikke Remix, Astro, Nuxt eller noe som ikke er
   JavaScript – og en `String.replace("</head>")` kan treffe en streng eller en
   kommentar og gjøre kundens bygg til en syntaksfeil i kode de ikke har skrevet.
3. **Sprengradius.** Umami-containeren holdt superbruker-credentials til hele
   Supabase-databasen og tok samtidig imot ubetrodde payloads fra åpent
   internett.
4. **Feil lag.** En PaaS eier proxyen for alle kundedomener. Det er et
   strukturelt fortrinn ingen frittstående analyseleverandør har, og det er
   grunnen til at Netlify Analytics og Cloudflare Web Analytics er bygget på
   samme måte.

### Arkitektur

Caddy strømmer access-loggen som JSON-linjer over docker-nettet til
`backend:3100`. En `filter`-encoder sletter `Cookie` og `Authorization` før noe
forlater Caddy, og loggen skrives aldri til disk.

`services/analytics-ingest.ts` slår opp vertsnavn → prosjekt, hasher IP-en bort
med et dagsroterende salt som kun finnes i minnet, tolker user-agent, slår opp
land lokalt, og aggregerer i fem sekunder før den skriver. En app med 300 000
treff i timen blir én rad, ikke 300 000.

### Datamodell (`analytics`-skjemaet, migrasjon 0008)

| Tabell | Innhold | Levetid |
|---|---|---|
| `rollup_hourly` | Sidevisninger, besøk, forespørsler, bytes, 4xx/5xx, responstid, bot-treff | 400 dager |
| `visitors_daily` | Anonymiserte besøkende-hasher | 90 dager |
| `rollup_dim` | Toppsider, henvisere, nettlesere, OS, enheter, land | 400 dager |

Rå treff lagres ikke. `analytics_prune()` kutter i tillegg halen i `rollup_dim`
til topp 200 per dag, slik at en portscannet app ikke kan blåse opp tabellen.

### Funksjonalitet
* **Null oppsett.** Ingen kode i kundens prosjekt, ingen `website_id`, ingen
  redeploy. Apper som allerede kjører får statistikk umiddelbart.
* **Virker overalt.** Alle rammeverk og språk, inkludert rene API-er og
  statiske sider. Kan ikke blokkeres av adblockere, og IP-en kan ikke forfalskes
  med en header fordi den kommer fra TCP-koblingen på kanten.
* **Statistikk-fane (`<AnalyticsTab />`)** – ett API-kall dekker hele fanen:
  * Nøkkeltall: unike besøkende, sidevisninger, visninger per besøk, responstid.
  * Driftstall loggen gir gratis: forespørsler, båndbredde, 5xx-rate, robottrafikk.
  * Tidsfilter 24t / 7d / 30d / hittil i år / alt, med oppløsning utledet av
    vinduets lengde. «Alt» starter på prosjektets `created_at`.
  * Graf over sidevisninger og besøk, med tomme bøtter fylt inn.
  * Dimensjoner: toppsider, trafikkilder, nettlesere, enheter og land. Alle
    kommer i samme svar, så fanebytte koster ingen nettverkstrafikk.

### Kjent begrensning

Klientruting i en SPA gir **én loggført sidevisning per økt** – Caddy ser ikke
`pushState`. Loggen kan heller ikke måle tid på siden eller bounce. Skal det
gapet lukkes, er neste steg et førsteparts endepunkt montert på kundens eget
domene (`/_snoat/*` via Caddy-ruten), slik at sporingen blir same-origin uten
CORS. Det er bevisst ikke bygget ennå.

---

## August 2026: GitHub Webhook & Auto-Deploy Aktivert (SnoatAuth)

* **Status:** Verifisert & Operativ.
* **GitHub App:** `SnoatAuth` (`app_id: 4426927`, installasjon `150187645`).
* **Webhook Endpoint:** `https://api.snoat.com/api/webhooks/github` (JSON payload, verifisert med `GITHUB_WEBHOOK_SECRET` HMAC-SHA256 signatur).
* **Abonnerte eventer:** `push` (aktivert under GitHub App settings `Permissions & events -> Subscribe to events`).
* **Verifisering:** `git push` til `main` på `DSandleman/mittvel` trigget automatisk bygg (Node 22), helsesjekk og Caddy-rutebytte med 0s nedetid.

