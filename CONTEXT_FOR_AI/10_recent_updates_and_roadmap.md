# 10. Nylige Oppdateringer og Vercel-sammenligning (Roadmap)

Denne filen dokumenterer nye funksjonaliteter og forbedringer som er innført i Snoat, samt sammenligningen mot Vercel og planlagte utvidelser.

---

## 0f. Containerhelse: en app som er død skal ikke stå som Live

`eierfullstack` sto som `success`/Live i produksjon i dagevis mens containeren
var borte fra Docker – `docker stats` viste `0B / 0B`, Caddy hadde fortsatt
ruten, siden svarte 502. Ingenting oppdaget det: `assertStillRunning()` sjekker
bare sekundene rundt en utrulling, og `reconcileRoutes()` kjører kun ved
backend-oppstart.

**Sveipet.** `services/helse.ts` sammenligner hvert `SNOAT_HEALTH_CHECK_INTERVAL_MS`
(standard 2 min) det databasen påstår kjører mot `containers.runningProjectIds()`
– ett Docker-kall for hele verten. Finner det et avvik, settes
`projects.container_died_at` (migrasjon 0015, additiv): basens tilstand
*rettes*, ikke bare logges. En ny vellykket deployment eller at containeren er
tilbake ved neste sveip nullstiller feltet igjen.

**Grensesnittet.** `DeploymentStatusBadge` får en ny etikett, «Nede» (rødt,
samme alvor som «Feilet»), i stedet for å fortsette å vise «Live» for en app som
ikke svarer. Lenker til appen skjules samtidig, som de allerede gjorde for et
stoppet prosjekt.

**Restart-regelen.** Applikasjonscontainere gikk fra `RestartPolicy:
unless-stopped` (restarter en krasjende app i det uendelige, i stillhet) til
`on-failure:N` (`SNOAT_APP_RESTART_MAX_RETRIES`, standard 5): en forbigående
krasj (OOM) rettes automatisk, en krasj-loop gir opp etter N forsøk og blir
stående – synlig for sveipet over, i stedet for å restarte for alltid uten at
noen får vite det.

**Varsel.** Én e-post ved overgangen til nede og én ved gjenoppretting, over den
samme Resend-infrastrukturen som `notifyFirstDeploymentLive` (`SNOAT_NOTIFY_TO`)
– ingen ny utsendingsvei.

**Bevisst utenfor omfang:** sveipet rører ikke Docker eller Caddy. Det
restarter ingenting, sletter ingenting, og flytter ikke ruten bort fra en død
container – se `03_deployment_flow.md` for resonnementet. Se også
`08_security_model.md` og `07_local_development.md`, som begge nevner den nye
restart-regelen der de før beskrev `unless-stopped`.

## 0e. Dev-grener som virket, og som er til å finne

Tre ting: en feil som gjorde dev-sider ubrukelige, en adresse som sier hva den
er, og en flytting av selve funksjonen dit man jobber.

### Feilen: hver dev-deployment feilet på siste steg

`routeUpstream()` og `routeRoot()` i `lib/caddy.ts` leste bare `handle[0]` for å
finne ut hva en Caddy-rute pekte på. På en passordbeskyttet app står
`authentication`-vakten først i kjeden, så begge svarte `null` på en rute som var
riktig skrevet. Steg 7 i pipelinen leser ruten tilbake etter byttet, fant
«ingenting», og rullet tilbake en container som kjørte og svarte. Hver dev-side
er beskyttet fra fødselen av, så *alle* dev-deployments feilet – etter at loggen
hadde skrevet «Successfully Built!» og «Containeren står stabilt».

Bekreftet mot drift 6. sep 2026: `eierfullstack-dev` og `osia-dev` endte begge
på `Caddy peker på ingenting etter byttet`, og `osia-dev.snoat.com` svarte
samtidig 401 – altså fantes ruten, med vakten først, nøyaktig som beskrevet.

Samme blindsone gjorde at «fjern passord» aldri nådde Caddy: `refreshRoute()`
fant verken upstream eller root og tok ingen av grenene. Appen ble stående låst
mens dashboardet sa at den var åpen.

Begge leserne går nå gjennom hele handler-kjeden, også inn i `subroute`.

### Adressen: `<gren>.<prosjekt>.snoat.com`

Dev-siden svarer nå også på `dev.eierfullstack.snoat.com`, i tillegg til
`eierfullstack-dev.snoat.com`. Se `03_deployment_flow.md` for hvorfor det er et
alias og ikke en omdøping, og hva `tls-ask` og analytics-hostmapet måtte lære.
Adressen står ved lenken i dev-gren-lista, klar til å kopieres.

### Synlighet: gren på hvert bygg, dev-grener der man jobber

- `deployments.branch` (migrasjon 0014) lagrer grenen bygget faktisk kom fra.
  Den vises som merkelapp i prosjektoverskriften, på hvert bygg i historikken,
  i «Seneste deployment» og i terminalens topprad – gul mens det bygges. Før
  sto svaret bare som «Gren: …» inne i loggteksten, og produksjons- og
  dev-bygget så helt like ut.
- Historikkraden teller nå sekunder mens bygget pågår. Den leste tidligere
  varigheten ut av «Ferdig på …» i loggen, som først finnes når bygget er ferdig
  – lista viste altså ingenting i det eneste tidsrommet man ser på den.
- Dev-gren-kortet er flyttet fra Innstillinger til Deployments-fanen, og
  skjemaet er foldet bort til man trykker «Ny dev-gren», slik at lista og
  adressene er det man ser først.
- Dashboardet henter nå dev-sidene også, og viser dem som klikkbare
  grenmerkelapper på prosjektkortet. Spørringen filtrerte dem bort før, og da
  fantes de ingen steder i oversikten.

---

## 0d. Mykere strek, terminal som følger systemet, og bevegelse overalt

Fire ting etter at «Ink & Sun» hadde stått en stund og blitt brukt.

* **Streken er myknet fra `#000000` til `#242424`.** Ett kort med ren svart
  ramme ser knivskarpt ut; et prosjektpanel som viser tjue av dem samtidig
  skjærer i kanten. Nytt token `--color-line` bærer *alle* rammer, mens
  `--color-ink` fortsatt er ren svart for tekst og fylte flater. Alle 43
  `border-ink` i kodebasen ble byttet til `border-line`. Kontrasten er
  fortsatt 7,9:1 mot papir. Unntaket er `.btn-ink` sin egen ramme, som må være
  lik fyllet — en svart knapp med lysere kant får en glorie rundt seg.
* **Prosjektsidens topprad hadde feil farge.** Den lå på `bg-ink/40`: en
  halvgjennomsiktig svart flate som ble grå over innholdet og skiftet farge
  etter hva som rullet under den. Den er nå papir med strek under, altså samme
  topprad som `DashboardNav` bruker i dashboardet.
* **Byggeloggen følger `prefers-color-scheme`.** Den var hardkodet til
  `#070a12` med grønn tekst — en farge som ikke fantes noe annet sted i
  paletten, og en kullsvart boks midt i et lyst dashboard. Nå leser den
  systemets innstilling: lyst system gir papirterminal, mørkt gir mørk. Se
  tokentabellen i `05_design_system.md`. **Resten av appen er fortsatt lys** —
  dette er ikke et mørkt tema, men én flate som leses som en terminal.
* **Bevegelse gjennom hele appen.** Ett sett med `@keyframes` og utilities
  (`anim-rise`, `stagger`, `lift`, `size-morph`, `collapse-grid`, `skeleton`,
  `anim-grow`), én kurve, tre varigheter — brukt på lister, kort, faner, søyler
  i statistikken, dialoger og alt som endrer høyde. `<Reveal>` toner inn
  landingssidens seksjoner ved rulling, med en `<noscript>`-regel som gjør alt
  synlig uten JavaScript. `prefers-reduced-motion` nuller varighetene.
  Dashboardets lastetilstand er skjelettkort i rutenettets egen form i stedet
  for teksten «Laster …», så layouten ikke hopper når prosjektene kommer inn.

Fire etterslep fra redesignet ble ryddet i samme slengen: `.secondary-btn`,
`text-on-primary`, `text-on-secondary` og `bg-mutedest` fantes ikke lenger i
paletten, så «Kontakt oss»-lenken sto uten flate, to «Aktiv»-merker sto svart
på svart, og verktøytipset i grafen ble tegnet uten bakgrunn rett oppå søylene.
`BuildStageCard` kalte dessuten `useBuildDuration()` etter en tidlig `return`,
altså en hook som endret rekkefølge mellom to renders av samme komponent.

---

## 0c. Velg hvilken gren som deployes

Snoat kunne én gren per repo: den GitHub hadde pekt ut som default branch.
`git clone --depth 1` uten `--branch` henter den, og webhooken bygget kun ved push
til `default_branch`. For alle som holder `main` produksjonsklar er det riktig –
men ikke for dem som gjør det motsatte, og de er ikke få: et repo der `main` er
kundens egen kode og `dev` er det som skal stå på nett, en kunde som vil se neste
versjon på et eget subdomene før den slås sammen, et repo Snoat deler med en
annen plattform som eier `main`.

Å bytte default branch på GitHub var ingen vei rundt: den styrer pull requests,
beskyttelsesregler og klonestandarden for alle som jobber i repoet – langt mer enn
hva Snoat skal bygge.

* **`projects.branch` (migrasjon 0012).** Nullable, og **NULL betyr «bruk repoets
  default branch»**. Det er ikke latskap: hadde migrasjonen backfill-et `'main'`,
  ville hvert eksisterende prosjekt med en annen hovedgren (`master`, `trunk`)
  sluttet å deploye i samme øyeblikk den kjørte. NULL bevarer dagens oppførsel for
  hver rad som finnes, uten backfill.
* **Kloningen.** `services/git.ts` legger til `--single-branch --branch <gren>`
  når feltet er satt. Grenen skrives til byggeloggen – også når den ikke er valgt,
  for da er det GitHub som bestemte, og «hvilken gren ble egentlig bygget?» er
  spørsmålet som kommer hver gang en endring ikke er med. En gren som ikke finnes
  får sin egen feilmelding; før sa loggen «Er repoet offentlig?» om et repo som var
  både offentlig og klonbart.
* **Webhooken avgjør per prosjekt.** Grensjekken lå før prosjektoppslaget og
  sammenlignet mot `default_branch`. Nå ligger den etter, fordi kriteriet er
  prosjektets valgte gren – og flere prosjekter kan peke på samme repo med *ulike*
  grener. En push til `dev` starter dem som deployer fra `dev` og lar de andre
  stå. Logglinjene sier nå «ingen av prosjektene deployer fra denne grenen», ikke
  «ikke hovedgrenen», siden det ikke lenger er kriteriet.
* **Sikkerhet: samme port som for `repo_url`.** Verdien blir et
  `git clone`-argument, så et navn som starter med bindestrek avvises – git leser
  `--upload-pack=…` som en opsjon, og det er vilkårlig kommandokjøring på
  byggeverten. Reglene er git sine egne fra `git check-ref-format` i konservativ
  form, håndhevet både av check-constrainten `projects_branch_check` (som
  dashboardet møter, siden det skriver raden selv) og av `assertSafeBranch()` (som
  backend møter, siden service-role-nøkkelen omgår constrainten).
* **API og MCP.** `POST /api/projects` og `PATCH /api/projects/:id` tar imot og
  returnerer `branch`; `null` eller tom streng betyr standardgrenen.
  `snoat_create_project` og `snoat_update_project` har feltet, så en byrå-integrasjon
  eller Claude kan sette grenen uten å gå via dashboardet.
* **`GET /api/github/branches?repo=…`** lister grenene i et repo, med
  `defaultBranch`. Installasjonen slås opp fra kontoens egne koblinger og tas
  aldri fra forespørselen – en `installation_id` er ingen hemmelighet, og
  endepunktet skal ikke kunne lese grenlisten i andres private repoer.
* **Frontend: `components/BranchPicker.tsx`.** Grenen velges fra en liste når
  Snoat rekker repoet, og skrives i et validert tekstfelt ellers (URL limt inn for
  hånd). Uttrykket følger `RepoPicker`: innrammet liste, gult fyll på valgt rad,
  ingen ikoner. Første rad er «Repoets standardgren (main)» – tomt valg, med
  navnet på grenen det faktisk betyr. Feltet ligger i «Nytt prosjekt» og øverst
  under Innstillinger, ikke i trekkspillet for avanserte byggeinnstillinger:
  grenen avgjør hvilken kode som står på nett.

**Dette er ikke deploy-previews.** Et prosjekt bygger én gren, valgt på forhånd.
En push til en vilkårlig feature-gren gir fortsatt ingen midlertidig URL, og en
pull request får ingen egen adresse. Vil man se `dev` på nett, opprettes `dev` som
et eget prosjekt med sitt eget subdomene – manuelt, én gang.

---

## 0b. MCP som custom connector, og kontoinnstillinger bak profilbildet

* **Den lokale stdio-serveren er slettet.** `mcp-server/` (npm-pakken
  `@snoat/mcp-server`) var den forrige veien inn og krevde installasjon og en
  `snoat_ak_…`-nøkkel i en JSON-fil. Pakken ble aldri publisert, så oppsettet
  dashboardet delte ut kunne uansett ikke virke. Den hostede connectoren på
  `/api/mcp` er nå den eneste veien inn.
* **Metadata-dokumentet svarer på to stier.** I tillegg til
  `/.well-known/oauth-authorization-server` svarer vi nå på
  `/.well-known/oauth-authorization-server/api/mcp`. Vår `issuer` har ingen sti,
  så den korte formen er den RFC 8414 krever – men flere klienter bygger
  oppslaget av *ressursens* sti, og en klient som får 404 på første forsøk gir
  gjerne opp med «could not connect» før den prøver den korte. Samme grep som
  `/.well-known/oauth-protected-resource/api/mcp` allerede hadde.
* **Connectoren er per bruker, og siden sier det nå.** URL-en er lik for alle,
  men tilgangen oppstår først ved godkjenning og tokenet er bundet til brukeren.
  Én konto kan ha flere connectorer samtidig, én per klient, og hver kan kobles
  fra for seg.
* **Kontoinnstillingene ligger bak profilbildet.** `AI-tilkobling` og
  `Abonnement` lå som løse lenker i toppraden, ved siden av dashboardets egen
  navigasjon – to nivåer i samme rad. Nå: `components/UserMenu.tsx` (avatar →
  nedtrekk) og en felles ramme i `routes/settings.tsx` med sidemeny,
  overskrift og innloggingssjekk ett sted. `/settings` omdirigerer til
  `/settings/mcp`.

---

## 0. Totalredesign: «Ink & Sun» (august 2026)

Hele frontenden er tegnet på nytt fra bunnen av mot Figma-fila
[Website Hosting Landing Page (Community)](https://www.figma.com/design/m3BEhOsDc9QQoKLFAllvHt/Website-Hosting-Landing-Page--Community-),
node `0:1683`, hentet med Figma MCP. Detaljene står i `05_design_system.md`;
her er hva som faktisk endret seg:

* **Fra mørkt til lyst.** `oklch`-paletten, isblå primærfarge og alle skygger er
  fjernet. Nå: hvitt papir, svart strek, `#FFED88` som eneste aksent.
* **Ramme erstatter skygge.** `.floating-card` er borte; `.ink-card` /
  `.ink-card-lg` / `.ink-card-xl` har 2–2,6 px svart ramme og ingen `box-shadow`.
  Den gamle regelen «ingen borders, kun skygge» er altså snudd på hodet.
* **Firkantede knapper og felt, rundede kort.** `.btn-ink`, `.btn-outline`,
  `.btn-sun`, `.btn-quiet` og `.field-ink` har radius 0.
* **Alle ikoner er fjernet.** Material Symbols-stilarket er ute av `__root.tsx`,
  og de 53 ikonbrukene i app-koden er byttet mot typografi: den gule håndstreken,
  `<Mark />` (`✓`/`✕` i en skive), tilstandsruter, `+`/`–` og `←`.
  `lucide-react` brukes nå bare av ubrukte shadcn-komponenter.
* **Ny typografi.** Helvetica/Arial gjennomgående, Clash Display i footeren.
  Space Grotesk og DM Sans er ute.
* **Landingssiden er bygget om seksjon for seksjon** mot malen, med
  skalafaktoren 1440/937 = 1,5368 på hver eneste px-verdi.
* **Prisekortene leser reelle grenser** fra `PlanOption.limits` i stedet for
  håndskrevne funksjonslister, slik at prissiden ikke kan komme i utakt med
  `PLAN_LIMITS`.
* **`/login` godtar `?email=`,** slik at CTA-feltet nederst på landingssiden
  kan bære adressen inn i registreringen.

Kjent avvik fra malen, med vilje: malens kundesitat er byttet mot etterprøvbare
fakta om plattformen. Vi publiserer ikke en oppdiktet anmeldelse.

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
* **Eventfiltrering:** `ping` svarer `pong`; kun `push` behandles. Tags og
  slettede grener kvitteres og ignoreres. Grensjekken var opprinnelig et treff mot
  repoets `default_branch`; den avgjøres nå per prosjekt mot `projects.branch` –
  se 0c.
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
* **Deploy-preview per gren/PR.** Prosjektet bygger den grenen det har valgt (se
  0c) – men bare den. En push til en vilkårlig feature-gren gir ingen midlertidig
  URL, og en pull request får ingen egen adresse. Dette er den største
  gjenværende forskjellen mot Vercel på dette området.
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

