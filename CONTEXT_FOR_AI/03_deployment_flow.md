# Livssyklusen til en Deployment

Fra en deployment utløses til applikasjonen er live på et subdomene.
Implementert i `backend/src/services/deploy.ts`, som orkestrerer de øvrige
tjenestene i `backend/src/services/`.

**To ting kan utløse en deployment:** brukeren trykker «Deploy» i dashboardet,
eller det kommer en push til prosjektets gren på GitHub. Begge veier ender i
`startDeployment()`, og resten av flyten er identisk.

**Hvilken gren?** Den prosjektet har valgt (`projects.branch`), eller repoets
default branch hvis feltet er NULL – som det er for de aller fleste. Valget
gjelder begge veier: det er grenen som klones, og den eneste grenen en push
utløser en deployment fra.

## Oversikt

```
Dashboard ──POST /api/projects/:id/deploy──▶ backend
GitHub ────POST /api/webhooks/github ──────▶ backend   (push til prosjektets gren)
                                              │
                                              ├─ 1. Insert deployments (queued) ──▶ Supabase
                                              │    svarer 202 med én gang
                                              │
                                              ├─ 2. git clone --depth 1 [--branch]
                                              ├─ 3. nixpacks build   ──▶ Docker-daemon
                                              ├─ 4. dockerode run    ──▶ snoat_apps-nettverket
                                              │       ny container *ved siden av* den gamle
                                              ├─ 5. helsesjekk på den nye containeren
                                              ├─ 6. PATCH /id/snoat_app_<slug> ──▶ Caddy admin-API
                                              │       trafikken bytter upstream atomisk
                                              ├─ 7. stopp + fjern forrige container
                                              └─ 8. Update status=success, url
                                                   │
Dashboard ◀──Supabase Realtime på deployments──────┘
```

Rekkefølgen i steg 4–7 er hele poenget: den gamle containeren serverer trafikk
helt til den nye er bekreftet oppe og Caddy er byttet over. En deployment koster
derfor **ingen nedetid**, og en deployment som feiler lar den kjørende versjonen
stå urørt.

## Stegene

**1. Trigger.** Dashboardet kaller `POST /api/projects/:projectId/deploy` med
brukerens Supabase access-token. Backend verifiserer tokenet mot GoTrue og at
prosjektet tilhører brukeren (`backend/src/middleware/auth.ts`).

Alternativt kommer triggeren fra GitHub, som `POST /api/webhooks/github` ved en
push. Der finnes ingen innlogget bruker, så eierskapet slås opp fra repoet i
stedet – se «Automatisk deploy ved push» under.

**2. Kvittering.** Backend oppretter en rad i `deployments` med status `queued`
og svarer **202 med én gang**. Selve byggingen fortsetter i bakgrunnen.
Dashboardet poller ikke – det abonnerer på `deployments` via Supabase Realtime.
En prosess-lokal lås (`inFlight`) hindrer to samtidige builds av samme prosjekt.
Containernavnene kolliderer ikke lenger – de er unike per deployment – men de to
buildene ville kjempet om det samme image-navnet, og om Caddy-ruten: den tregeste
kunne rukket å bytte den tilbake til sin egen container etter at den raskeste var
ferdig.

**3. Kloning.** `git clone --depth 1` til
`$SNOAT_WORKSPACE_DIR/<projectId>/<deploymentId>`. Bare arbeidstreet trengs, ikke
historikken. `GIT_TERMINAL_PROMPT=0` gjør at private repoer feiler raskt i stedet
for å henge til build-timeouten. Commit-hashen lagres på deploymenten.

Har prosjektet valgt en gren, legges `--single-branch --branch <gren>` til.
`--depth 1` impliserer allerede én gren, men eksplisitt er bedre enn å hvile på
en implikasjon som kan endre seg mellom git-versjoner. Er `projects.branch` NULL,
sendes ingen `--branch`, og git henter repoets default branch – uendret fra slik
det alltid har vært.

Grenen skrives til byggeloggen (`Gren: dev`, eller `Gren: main (repoets
standardgren – ingen gren er valgt for prosjektet)`, lest tilbake fra
arbeidstreet med `rev-parse --abbrev-ref HEAD`). Spørsmålet «hvilken gren ble
egentlig bygget?» kommer hver gang noen lurer på hvorfor en endring ikke er med,
og svaret skal stå i loggen – også når det var GitHub som bestemte.

En gren som ikke finnes gir sin egen feilmelding, ikke den generelle. Uten det
sa loggen «Kunne ikke klone repositoryet. Er det offentlig?» om et repo som er
både offentlig og klonbart – feilen lå i ett tegn i et innstillingsfelt, og
ingenting pekte dit. `services/git.ts` kjenner igjen `not found in upstream`,
`Could not find remote branch` og `couldn't find remote ref` (tre formuleringer
fordi git har byttet ordlyd mellom versjoner) og svarer med grennavnet og hva som
må gjøres.

**0. Kø.** `startDeployment()` oppretter raden med status `queued` og legger den i
en **global kø** med `SNOAT_MAX_CONCURRENT_BUILDS` plasser (standard 1). `inFlight`
hindrer at samme prosjekt bygges to ganger. Selv om vi nå kjører på en 16 GB VPS,
bidrar køen til å holde ressursbruken stabil under store byggejobber. Ventende
deployments får en linje i loggen om hvor mange som ligger foran.

Køen lever i minnet til backend-prosessen. Derfor rydder `failOrphanedDeployments()`
ved oppstart: alt som står i `queued` eller `building` når prosessen starter, har
mistet prosessen sin og merkes `failed` med en forklaring i loggen. Uten den blir
raden stående for alltid, og dashboardet teller opp på en build som døde. Begge
mekanismene forutsetter **én** backend-instans, akkurat som `inFlight`.

**4. Image build.** `nixpacks build <dir> --name snoat/<slug>` med `--env` per
miljøvariabel og `--build-cmd` hvis prosjektet har en override. Nixpacks
detekterer rammeverket selv – brukeren trenger ingen Dockerfile. `PORT` injiseres
alltid. Stdout og stderr strømmes til `deployments.logs`.

**Språkversjon når repoet ikke oppgir en.** Nixpacks velger Node-versjon i
rekkefølgen `NIXPACKS_NODE_VERSION` → `engines.node` → `.nvmrc` → sin egen
innebygde standard, og den standarden er **Node 18** – ute av vedlikehold siden
april 2025, og for gammel for Next.js 15+, Vite 6+ og `@supabase/supabase-js`.
Et helt vanlig prosjekt uten `engines`-felt feilet derfor på `npm run build` uten
at brukeren hadde gjort noe galt.

`services/runtime-versions.ts` fyller hullet nederst i kjeden. Før kommandoen
settes sammen leses det klonede repoet:

| Repoet inneholder | Snoat gjør |
| --- | --- |
| `nixpacks.toml`/`nixpacks.json` | ingenting – repoet styrer byggeoppsettet selv |
| ingen `package.json` | ingenting – ikke et Node-prosjekt |
| `engines.node`, `.nvmrc` eller `.node-version` | ingenting, men logger hvor versjonen kom fra |
| ingen av delene | sender `--env NIXPACKS_NODE_VERSION=$SNOAT_DEFAULT_NODE_VERSION` (standard `22`) |

Har brukeren selv satt `NIXPACKS_NODE_VERSION` under Miljøvariabler, vinner den:
den ligger allerede i argumentlista, og en ny `--env` med samme nøkkel ville
overstyrt et bevisst valg. Valget skrives til byggeloggen (`Node-versjon: 22
(Snoat-standard, repoet oppgir ingen)`), slik at det er etterprøvbart når et
bygg ryker.

**Kun major-nummeret teller.** Nixpacks slår majoren opp i sin egen tabell over
nixpkgs-pins (`AVAILABLE_NODE_VERSIONS`: 14, 16, 18, 20, 22, 24 – lista endrer
seg mellom Nixpacks-versjoner) og bygger med `nodejs_<major>`. Minor og patch
kastes bort: `22.13` gir nøyaktig samme Node som `22`, nemlig den 22.x den
pinnede nixpkgs-en inneholder. Serveren kjører i dag Nixpacks 1.41.0 og lander på
**Node 22.11.0**.

Det har en praktisk konsekvens: pakker som krever `^22.13.0` gir `EBADENGINE`, og
det kan ikke løses ved å skrive en mer presis versjon noe sted. Eneste vei til en
nyere 22.x er å oppgradere Nixpacks selv.

> ⚠️ En major Nixpacks *ikke* kjenner gir ingen feilmelding. `version_number_to_pkg()`
> faller stille tilbake til `nodejs_18` – det stikk motsatte av hensikten med
> `SNOAT_DEFAULT_NODE_VERSION`. Hever du standarden, verifiser mot den installerte
> Nixpacks-versjonen og bekreft i byggeloggen at `setup`-raden faktisk viser den
> majoren du ba om.

**Minnetak under bygging.** `NODE_OPTIONS=--max-old-space-size=$SNOAT_BUILD_NODE_MEMORY_MB`
injiseres når prosjektet ikke setter `NODE_OPTIONS` selv. `next build` tar så mye
heap den får lov til; uten taket er det verten som setter grensen, og da er det
for sent. Med taket feiler bygget med «JavaScript heap out of memory» – en feil
som rammer én kunde og står forklart i loggen.

Taket bakes inn i image-et av nixpacks, og et build-tak er altfor høyt for en
container begrenset til `SNOAT_APP_MEMORY_MB`. Tror V8 den har mer heap enn den
har, GC-er den for lat og Docker OOM-dreper appen. `containers.ts` overstyrer
derfor `NODE_OPTIONS` ved kjøring til 75 % av containerens minnetak.

Modulen er en tabell over kjøretider, ikke en Node-spesialtilfelle: når
Nixpacks-standarden for Python eller Go eldes på samme måte, er det én rad som
skal legges til. Verdien må være et major-nummer Nixpacks kjenner (18, 20, 22,
23) – en ukjent verdi ignoreres, og da er vi tilbake til Nixpacks sin egen
standard.

**Buildx er ikke valgfritt.** Nixpacks shell-er ut til `docker build`, og Docker
CLI 27 har BuildKit på som standard – der BuildKit i praksis *er* buildx-plugin.
Den statiske `docker`-tarballen fra download.docker.com inneholder kun klienten,
ingen CLI-plugins, så `backend/Dockerfile` laster ned `docker-buildx` separat til
`/usr/local/lib/docker/cli-plugins/`. Mangler den, dør hver enkelt build på:

```
ERROR: BuildKit is enabled but the buildx component is missing or broken.
```

Å sette `DOCKER_BUILDKIT=0` er ingen vei rundt: nixpacks genererer
`RUN --mount=type=cache,...` for npm-cachen og byggecachen, og den gamle
byggeren forstår ikke den syntaksen. BuildKit er et krav, ikke en preferanse.

Host-daemonen må også støtte BuildKit (Docker 23+). Buildx bruker da
`docker`-driveren mot daemonens innebygde BuildKit, så ingen egen
buildkit-container trengs.

**Første build er dyr, resten er billige.** Steg 4 i den genererte Dockerfilen er
`RUN nix-env -if .nixpacks/nixpkgs-<hash>.nix`, som laster ned og materialiserer
hele nix-pakkesettet. Tidligere kunne dette ta 8–15 minutter, men på 16 GB-serveren
går det betydelig raskere. Det logger nesten ingenting mens det pågår – stillhet
betyr ikke at noe henger. Laget caches av
BuildKit og deles av alle prosjekter med samme nixpkgs-revisjon og pakkesett, så
kostnaden betales én gang, ikke per deploy.

Dette er også hovedgrunnen til at Snoat bygger tregere enn Vercel: Vercel bruker
ferdigbakte byggeimages der Node allerede ligger inne, og bygger for de fleste
rammeverk *ikke* et container-image i det hele tatt – de kjører bygget på en
forberedt maskin og pakker resultatet som statiske filer pluss functions. Vi
betaler både nix-provisjonering og fulle OCI-lag-commits.

**3b. Kjøremodus sjekkes mot koden – før bygget.**
`assertKjoremodusStemmer()` i `services/deploy.ts` leser rammeverkets egen
konfigurasjon rett etter klonen. Erklærer den at bygget bare produserer filer,
men prosjektet står uten `static_output_dir`, feiler deploymenten *før*
`buildImage()` med koden `deploy.static_declaration_mismatch`.

I dag dekker det Next.js med `output: "export"`, se
`services/static-declaration.ts`. Grunnen til at det er en hard feil og ikke en
advarsel: `next start` avviser en export-build eksplisitt og avslutter med kode
1. Kombinasjonen har ikke et utfall der den virker, så sjekken kan ikke ta feil.
Og grunnen til at den ligger før bygget: bygget som avdekket dette tok 549
sekunder, og ni minutter er lang tid å vente på en beskjed vi kan gi etter tolv.

Dette bryter ikke med regelen i `static-site.ts` om at Snoat aldri gjetter på om
et prosjekt er statisk. Å se en `dist/`-katalog og konkludere er et gjett;
`output: "export"` i appens egen konfigurasjon er en erklæring. Vi bytter
uansett ikke modus selv – vi nekter å bygge noe som ikke kan kjøre, og sier
hvilken innstilling som må endres.

**4b. Statiske sider hopper over hele resten.** Har prosjektet
`static_output_dir` satt, startes ingen container. `services/static-site.ts`
kjører `docker create` på image-et (den startes aldri – bare filsystemet
materialiseres), kopierer ut katalogen med `docker cp`, og fjerner den
midlertidige containeren igjen. Filene legges i
`$SNOAT_SITES_DIR/<projectId>/<deploymentId>/`, og Caddy får en `file_server`-rute
dit i stedet for `reverse_proxy`.

Dette er den største kostnadsbesparelsen i plattformen. En container koster minne
24/7 uansett om noen besøker siden; filer på disk koster ingenting når ingen er
der. Hundrevis av statiske sider går fra titalls GB RAM til tilnærmet null.

Vi **gjetter aldri** på om et prosjekt er statisk. Feltet settes av brukeren under
Innstillinger, fordi et feilgjett gir en side som ser levende ut helt til noe
server-side kalles – en verre feil enn å kjøre en container for mye. UI-et
foreslår `dist` for Vite/Astro og `out` for Next.js med `output: 'export'`.

`static_spa_fallback` styrer hva som skjer med en URL uten treff:

| Innstilling | Oppførsel | Riktig for |
| --- | --- | --- |
| Av (standard) | 404 | Astro, Hugo, Eleventy – de har egen `404.html` |
| På | `index.html` serveres | SPA-er med klientruting (React Router, TanStack Router) |

Rekkefølgen er den samme som for containere: filene legges ved siden av forrige
versjon, og ruten byttes først når de ligger der. Feiler noe, settes den forrige
ruten tilbake – uansett om den pekte på en katalog eller en container.
`SNOAT_STATIC_KEEP_VERSIONS` (standard 3) beholder tidligere versjoner på disk,
så tilbakerulling for statiske sider er et rutebytte, ikke en ny build.

Verdien går inn i et `docker cp`-argument og en filsti. Den valideres derfor både
av en check-constraint i databasen og av `assertSafeOutputDir()` – service-role-
nøkkelen omgår ikke bare RLS, den omgår også constrainten.

**5. Container.** Kun for prosjekter *uten* `static_output_dir`.
`dockerode.createContainer` med image-et, brukerens
miljøvariabler, ressurstak (`Memory`, `NanoCpus`) og `RestartPolicy:
on-failure:N` (`SNOAT_APP_RESTART_MAX_RETRIES`, standard 5 – se
`containers.ts` og `10_recent_updates_and_roadmap.md` for hvorfor det ikke
lenger er `unless-stopped`). Containeren kobles til nettverket `snoat_apps` og
**publiserer ingen port på verten** – Caddy når den på containernavnet over
det interne nettverket.

Navnet er `snoat-app-<slug>-<deployment-id-prefiks>`, altså **unikt per
deployment**. Det er mekanismen som gjør rullerende utrulling mulig: den nye
containeren starter ved siden av den som kjører, uten å kollidere med navnet
dens. Uuid-en kortes til åtte tegn fordi navnet også er DNS-navnet på
apps-nettverket, og en DNS-label tåler maks 63 tegn. Båndet mellom container og
prosjekt er ikke navnet, men labelen `no.snoat.project-id` – den er det
`containers.ts` slår opp på.

I tillegg får containeren nettverksaliaset `<slug>`, som er stabilt på tvers av
deployments slik at apper kan nå hverandre på prosjektnavnet. I sekundene der to
versjoner kjører samtidig peker aliaset på begge (round-robin). Caddy dial-er
containernavnet, som alltid er entydig.

**Helsesjekk.** `assertStillRunning()` poller containeren og krever at den har
kjørt **sammenhengende** i `SNOAT_STABLE_FOR_MS` (15 s som standard) siden
`State.StartedAt`, med `RestartCount` 0 og `State.Restarting` falsk. Nås
`SNOAT_STABLE_TIMEOUT_MS` (90 s) uten at den blir stabil, feiler deploymenten
framfor å henge. Feiler sjekken, hentes de siste 50 linjene fra applikasjonens
egen logg inn i byggeloggen.

Ett enkelt øyeblikksbilde er ikke nok – `RestartPolicy: on-failure:N` starter en
krasjende app på nytt flere ganger, og `State.Running` er sann i glimtene
mellom omstartene. En app i krasj-loop ville ellers sluppet gjennom som «Live»
*og* fått en fungerende versjon revet ned under seg.

Kriteriet var tidligere et FAST vindu på tre sekunder, og det slapp gjennom en
app som beviselig ikke virket: `eierfullstack` med `output: "export"` deployet som
container. `next start` avviser en export-build, men containeren har 256 MB og
0,5 CPU, og `npm run start` → npm → `next start` rakk ikke gjennom oppstarten før
vinduet lukket. Sjekken så `Running=true, RestartCount=0` – en oppstart
*underveis* – og skrev «Containeren står stabilt». Krasjet kom etterpå, og siden
svarte 502 på hver rute mens loggen sa «Live på …». Med oppetid som kriterium
nullstilles klokka av at `StartedAt` flyttes fram ved en omstart.

**Hva helsesjekken fortsatt ikke vet:** om noe LYTTER på porten. En app som
starter fint og binder feil port passerer, og svarer 502 etterpå. Det riktige
signalet er én HTTP-forespørsel mot containeren før byttet, men backend ligger
med vilje utenfor `snoat_apps` – appene skal bare være nåbare gjennom Caddy – så
det krever en egen vei inn: en `HEALTHCHECK` på image-et, eller en kortlevd
container på appnettverket. Til da dekker oppetid klassen «krasjer under eller
rett etter oppstart», som er den vanligste.

**6. Ruting.** `PATCH http://caddy:2019/id/snoat_app_<slug>` med en rute som
matcher `<slug>.snoat.localhost` og proxier til den nye containeren. PATCH
**bytter ruten atomisk** i Caddys minne: forespørsler som er underveis fullføres
mot den gamle upstreamen, og neste forespørsel treffer den nye. Finnes ruten ikke
(første deployment), svarer Caddy `unknown object ID`, og vi faller tilbake til
`POST /id/snoat_apps/handle/0/routes` for å opprette den. `@id` gjør at ruten kan
adresseres direkte i stedet for via en array-indeks som flytter seg.

DELETE etterfulgt av POST – som er det nærmeste Caddy har til en upsert – ville
hatt et vindu der subdomenet ikke matchet noen rute, og brukerne ville fått 404.
Målt i den lokale stacken: 17 av 18 forespørsler feilet gjennom det vinduet, mot
0 av 254 med PATCH.

Etter byttet leses ruten tilbake med `appRouteUpstream()`. Vi river ikke ned noe
før Caddy har bekreftet at den peker der vi tror.

**7. Opprydding.** Først nå – med trafikken trygt over på den nye containeren –
tas den forrige ned. `retirePrevious()` stopper hver gjenværende container for
prosjektet med `SNOAT_APP_STOP_TIMEOUT_S` sekunders frist (SIGTERM → SIGKILL),
slik at forespørsler den holder på får fullføre, og fjerner den så. Feiler
oppryddingen, er deploymenten fortsatt vellykket: trafikken går allerede til den
nye containeren, og den gamle logges som noe som må ryddes manuelt.

**8. Fullført.** Status settes til `success` med `url`. Arbeidsområdet slettes –
image-et er artefakten vi beholder.

## Dev-sider: to grener av samme repo, samtidig

Grenvalget i 0012 byttet *hvilken* gren et prosjekt bygger. En dev-side er å ha
begge samtidig – `main` på domenet kundene ser, og en annen gren på en adresse
bare teamet kommer inn på.

**En dev-side er en ordinær prosjektrad.** `parent_project_id` peker på
prosjektet den er et miljø for, `branch` er grenen den følger, og `name` er
`<prosjekt>-<gren>`, som gir vertsnavnet. Begrunnelsen står i migrasjon 0013:
`tls-ask`, Caddy-rutene, analytics-hostmapet og `assertCanDeploy` slår alle opp
på `projects.name`, og de virker uendret for en rad som ser ut som alle andre.

### To adresser, én rute

Dev-siden svarer på **begge** disse:

- `<prosjekt>-<gren>.snoat.com` — navnet, altså identiteten.
- `<gren>.<prosjekt>.snoat.com` — den vi viser. `dev.eierfullstack.snoat.com`.

Den pene kommer i *tillegg*, ikke i stedet for. `projects.name` er fortsatt det
alt slår opp på, og å bytte den ut ville vært å flytte containernavn,
analytics-hostmapet, plangrensene og `tls-ask` samtidig. I stedet legges begge
vertsnavnene i host-matcheren på samme rute (`caddy.devAliasHostname()` og
`hostsFor()`), og `deployments.url` får den pene – slik at dashboardet lenker
riktig uten å kjenne navnekonvensjonen.

To ting måtte læres opp:

- **`tls-ask`** (`routes/tls.ts`). `slugFromHostname()` godtar med vilje bare én
  etikett, så den pene adressen fikk 404 og dermed aldri et sertifikat.
  `devAliasParts()` snur navnet tilbake til `<prosjekt>` + `<gren>` og slår opp
  raden `<prosjekt>-<gren>` med `parent_project_id` satt.
- **Analytics-hostmapet** (`services/analytics-ingest.ts`). Uten aliaset i kartet
  ble hvert treff på den pene adressen forkastet, og statistikken for dev-siden
  sto tom uansett hvor mye den ble besøkt.

DNS krever ingenting nytt: `*.snoat.com` dekker alle navn under seg som ikke har
en nærmere node i sonen (RFC 4592), ikke bare én etikett. Verifisert mot 1.1.1.1
og 8.8.8.8. Sertifikatet hentes on-demand per navn, som før.

**Push-webhooken trengte ingen endring.** Den henter alle prosjekter på repoet og
spør per rad om grenen stemmer (`isDeployBranch`, `routes/webhooks.ts`). To rader
på samme repo med ulik gren gir dermed riktig oppførsel av seg selv: push til
`dev` bygger bare dev-siden, push til `main` bare hovedsiden.

**Plangrensen håndheves ikke ved opprettelsen**, men i `startDeployment` – som for
alle andre prosjekter. En dev-side som kjører *er* en kjørende app, så en
Free-konto med én app i drift får nei ved bygget. Det er riktig sted: raden
koster ingenting, containeren koster.

**Sletting av forelderen river ned barna først.** `on delete cascade` fjerner
radene, men ingen container og ingen Caddy-rute, så `DELETE /api/projects/:id`
kaller `teardownProject` på hver dev-side før den rører forelderen. Dashboardet
sletter derfor gjennom API-et nå og ikke med `getSupabase().delete()` – den gamle
veien etterlot en app som fortsatt kjørte.

### Av/på på en dev-side

En dev-side skal stå når noen jobber og ligge nede resten av tiden. Prosjektsiden
til en dev-side bytter derfor Stopp/Start-knappene for én bryter (`SiteToggle`),
og hver rad i dev-side-lista har den samme bryteren.

**Av** er `POST /projects/:id/stop`: container fjernet, Caddy-rute slettet,
`stopped_at` satt. En stoppet app teller ikke mot noen grense, så en dev-side som
ligger nede koster ingenting.

Merk hvilken grense en dev-side som *står* teller mot: fra 6. september 2026 er
det `maxRunningDevSites`, ikke `maxRunningProjects`. Se `12_billing_and_plans.md`.

**På** er `POST /projects/:id/deploy`, altså et nytt bygg. Snoat beholder ikke
containeren over et stopp – det er hele hensikten med å stoppe – så veien tilbake
går gjennom pipelinen. En bryter later som det er umiddelbart, og derfor står det
under den at det tar noen minutter.

**Hovedprosjekter beholder Stopp-knappen.** Å ta ned produksjonen skal kreve at
man leser hva knappen heter, ikke bare treffer en bryter.

Deploy-knappen skjules på en avslått dev-side: der ville den hett «Start» og gjort
nøyaktig det bryteren ved siden av gjør.

### Passordet foran appen

`access_protected` på `projects` sier *at* appen er beskyttet. Hashen ligger i
`project_access`, en tabell med RLS på og **ingen** policy: bare service-role ser
den. Delingen er ikke ryddighet – dashboardet leser `projects` direkte fra
Supabase, så en hash på den raden er en hash i nettleseren.

Vakten er Caddys egen `authentication`-handler med `http_basic` og bcrypt, lagt
**først** i handler-kjeden for ruten, slik at en 401 kommer før `reverse_proxy`
har åpnet en forbindelse. `hash_cache` er slått på: bcrypt cost 12 er ~250 ms med
vilje, og uten cachen ville hvert bilde og hver JS-fil på siden betalt den prisen.

> ⚠️ **At vakten står først, veltet i sin tid hver eneste dev-deployment.**
> `routeUpstream()` og `routeRoot()` i `lib/caddy.ts` leste bare `handle[0]` for
> å finne ut hva ruten pekte på. På en beskyttet app *er* `handle[0]`
> `authentication`, så begge svarte `null` på en rute som var helt i orden.
> Steg 7 i pipelinen leser ruten tilbake etter byttet og sammenligner, konkluderte
> med «Caddy peker på ingenting etter byttet», og rullet tilbake en container som
> kjørte og svarte. Siden hver dev-side er beskyttet fra fødselen av, feilet
> *alle* dev-deployments på siste steg – med «Successfully Built!» like over i
> loggen. Samme blindsone gjorde at «fjern passord» aldri nådde Caddy:
> `refreshRoute()` fant verken upstream eller root, og tok ingen av grenene.
>
> Begge leserne går nå gjennom hele handler-kjeden, også inn i `subroute`.

Brukernavnet er alltid `snoat`. Basic auth krever et brukernavn, men det er
*appen* som er beskyttet, ikke en konto – ett fast navn er mer ærlig enn å late
som det betyr noe.

Hashen leses per ruteskriving (`accessHashFor()` i `deploy.ts`), og bare når
`access_protected` er sant. Feiler oppslaget, svarer vi null – en dev-side som er
åpen i noen minutter er dårlig, men en dev-side som ikke kan deployes er verre.
Skal det snus til fail closed, må `runPipeline` også kunne feile på det.

#### Vakten spratt opp en dialog over dashboardet

Én 401 med `WWW-Authenticate: Basic` er nok til at nettleseren tar over: den viser
sin **egen** legitimasjonsdialog, og den navngir *appens* vertsnavn selv om
brukeren står på `snoat.com`. Dashboardet hentet faviconet til hvert prosjektkort
fra appens eget vertsnavn (`<url>/favicon.ico` i `ProjectFavicon`,
`routes/dashboard.tsx`), og på en beskyttet app ble det «Sign in to
eierbolig-admin-dev.snoat.com» rett over «Mine prosjekter», med en tom firkant der
ikonet skulle stått.

Dialogen kommer uansett hva vi ber om ressursen med: `credentials: "omit"`,
`crossOrigin` og en `fetch` i forkant fjerner den ikke. Chrome undertrykker den
bare for delressurser som er *cross-site*, og `snoat.com` og `<app>.snoat.com`
har samme registrerbare domene – de er same-site. Derfor ser man dialogen i
produksjon, men ikke når dashboardet kjøres fra `localhost`.

`ProjectFavicon` ber derfor ikke om faviconet i det hele tatt når
`access_protected` er sant, men går rett til eierens GitHub-avatar. Vakten selv
er urørt: den som går til vertsnavnet direkte får fortsatt 401. Skal en beskyttet
app vise sitt *ekte* favicon i oversikten, må ressursen hentes server-til-server
gjennom vårt eget API – nettleseren kan ikke møte den 401-en.

## Varsel til drift når en app blir live

Etter at ruten er skrevet og statusen satt til `success`, kaller begge
suksess-grenene `notifyFirstDeploymentLive()` i `services/notify.ts`. Den sender
én e-post over Resend sitt HTTP-API – ikke SMTP – med prosjekt, adresse, repo,
gren, type, plan og eierens e-post.

**Bare ved første vellykkede deployment.** «Noen har spunnet opp en webapp» skjer
én gang per prosjekt. Ett varsel per deploy ville betydd én e-post per push for
hver kunde med auto-deploy, og da er det ingen som leser dem – heller ikke den
ene som betydde noe. Vi teller vellykkede rader i `deployments` framfor å
innføre et `notified_at`-felt: databasen kan svare på spørsmålet selv, og en
kolonne til er en kolonne til å holde synkron.

**Opprettelsen av prosjektet kan ikke varsles.** Dashboardet inserter raden
direkte i Supabase gjennom RLS, uten å røre backend. Første vellykkede
deployment er det tidligste tidspunktet backend med sikkerhet vet at appen
finnes – og også det første tidspunktet den faktisk svarer på et vertsnavn.

Kallet er `void`, ikke `await`: et varsel som henger skal ikke holde en
byggeplass okkupert. Ingenting i `notify.ts` kaster – et varsel som feiler er en
tapt e-post, og skal aldri bli en tapt deploy.

**Konfigurasjon.** `RESEND_API_KEY` (samme nøkkel som GoTrue bruker over SMTP),
`SNOAT_NOTIFY_FROM` og `SNOAT_NOTIFY_TO` (komma-separert). Mangler nøkkelen
*eller* mottakerlisten, sendes ingenting og varselet blir en `debug`-linje i
loggen. Begge de nye nøklene ligger i `scripts/bootstrap-env.mjs` – variabler som
ikke står i den malen slettes fra `.env` ved neste deploy.

## Feilhåndtering

Hvert steg kaster `DeployError` med et stegnavn. Pipelinen fanger alt, skriver
feilmeldingen inn i byggeloggen, setter status `failed` og rydder
arbeidsområdet. Brukeren ser hvilket steg som feilet og hvorfor, i loggvinduet.

**Byggefeil oversettes til noe brukeren kan handle på.** Et mislykket
`nixpacks build` etterlater flere hundre linjer BuildKit-output. Nederst står som
regel én linje som forklarer alt, men den drukner i lagnedlastinger og nix-stier.
«Se loggen over for detaljer» er derfor å be kunden lete etter noe de ikke vet
hvordan ser ut.

`services/build-diagnosis.ts` kjenner igjen de feilene som faktisk oppstår, og
sier hva de betyr. `nixpacks.ts` holder de siste 64 000 tegnene av outputen –
feilen står alltid nederst – og sender dem gjennom `describeBuildFailure()` når
bygget gir opp.

| Signatur i loggen | Diagnose |
| --- | --- |
| `JavaScript heap out of memory` | traff minnetaket; hvordan man hever det |
| `Failed to type check` / `Type error:` / `error TS…` | typefeil, med `fil:linje` og meldingen |
| låsefil ute av takt / `EUSAGE` | `npm ci` krever at `package-lock.json` stemmer |
| `npm error code EBADENGINE` | pakken krever en annen Node-versjon |
| `ERESOLVE` | avhengighetskonflikt |
| `npm error 404` | pakken finnes ikke i registeret |
| `Missing script:` | byggekommandoen mangler i `package.json` |
| `Module not found: Can't resolve` | import peker på ingenting – ofte feil bokstavstørrelse |
| `Cannot find module` | pakken mangler i `package.json` |

Signaturene er bevisst konservative og matcher tekst verktøyene skriver ordrett.
Rekkefølgen i tabellen er også prioriteringen: den mest spesifikke først, fordi
et bygg som går tom for minne kan rive med seg moduler på vei ned. Treffer ingen
signatur, faller vi tilbake til den generelle meldingen – **en gjetning som er
feil er verre enn ingen gjetning**.

Merk at diagnosen for typefeil sier eksplisitt at Snoat *ikke* skrur av
typesjekking. Å gjøre det ville byttet en synlig byggefeil mot en usynlig
produksjonsfeil, og kunden ville fått vite om den fra sluttbrukerne sine i stedet
for fra loggen. Skal et prosjekt bygges uten typesjekk, er det kundens eget valg
i deres egen konfigurasjon.

**Samme commit to ganger på rad.** Den vanligste grunnen til at «samme feil kom
igjen» er ikke at rettelsen ikke virket, men at den aldri forlot maskinen. Snoat
kloner standardgrenen fra GitHub, så en fiks som ligger ucommittet – eller
committet uten push – finnes ikke her. Kunden ser da en byggelogg identisk med
forrige, uten noen ledetråd.

`warnOnRepeatedFailedCommit()` i `deploy.ts` slår opp forrige deployment for
prosjektet rett etter kloningen. Er den `failed` og har samme `commit_hash`,
skrives en advarsel før byggesteget. Gikk forrige bygg bra, sies ingenting – å
deploye samme commit på nytt er helt normalt ved omstart eller endret
miljøvariabel. Oppslaget får aldri velte deploymenten; feiler det, bygger vi
videre i stillhet.

**En feilet deployment koster ikke nedetid.** Alt som skjer før steg 6 rører ikke
den kjørende versjonen: klone, build og den nye containeren er nye artefakter ved
siden av den. Feiler noe av det, gjør `rollback()` i `deploy.ts` to ting:

1. peker Caddy-ruten tilbake til upstreamen som serverte trafikk før
   deploymenten – lest før noe ble endret, og bare hvis ruten faktisk ble byttet
2. fjerner deploymentens egen container

Den forrige containeren er da fortsatt der den var, og brukerne merker ingenting
annet enn at den nye versjonen aldri kom. Ingenting i `rollback()` får kaste –
den opprinnelige feilen er den brukeren skal se i loggen.

**Pipelinen kan ikke ta ned backend.** `startDeployment()` starter `runPipeline()`
uten å vente på den, og en avvisning fra en promise ingen venter på er en
*unhandled rejection* – som Node avslutter prosessen på. Pipelinen fanger sine
egne feil, men koden som ligger utenfor try-blokken (oppsettet av `LogStream`, den
første statusoppdateringen) gjør det ikke. Derfor har bakgrunnskallet en egen
`.catch()` som kun logger. Det tålte vi da en build krevde at et menneske trykket
på en knapp; med webhooks starter builds av seg selv, og én rar deployment skal
ikke kunne velte serveren for alle.

## Automatisk deploy ved push (GitHub-webhooks)

Implementert i `backend/src/routes/webhooks.ts`, med primitivene i
`backend/src/lib/github.ts`. GitHub kaller `POST /api/webhooks/github` når noen
pusher, og backend starter en deployment av hvert prosjekt som peker på repoet.

**Endepunktet er offentlig.** Det ligger under `/api`, men *utenfor*
`requireAuth` – GitHub har ingen Supabase-sesjon å sende med. I `index.ts`
monteres det derfor **før** `app.route("/api", api)`: Hono matcher handlere i
registreringsrekkefølge, og en handler som svarer stopper kjeden. Bytter man om
på de to linjene, begynner GitHub å få 401.

### Rekkefølgen i mottaket

1. **Signatur.** Er `GITHUB_WEBHOOK_SECRET` satt, må `x-hub-signature-256`
   stemme med en HMAC-sha256 over **råkroppen** – ikke over noe vi har parset og
   serialisert på nytt, siden `JSON.stringify` ikke gir samme bytes tilbake.
   Sammenligningen er `timingSafeEqual`. Feil eller manglende signatur gir `401`.
   Er secreten *ikke* satt, tas forespørselen imot med en `warn` i loggen. Det er
   en bevisst åpning for å få oppsettet i gang, og en risiko: se
   `08_security_model.md`.
2. **Event.** `x-github-event` styrer resten. `ping` (som GitHub sender når
   webhooken opprettes) svarer `pong`. Alt annet enn `push` kvitteres som
   ignorert – App-en mottar alle eventene installasjonen abonnerer på, og de er
   ikke feil, bare ikke vårt bord.
3. **Ref.** `refs/heads/<gren>` plukkes ut av `ref`. Tags, slettede grener
   (`deleted: true`) og andre refs ignoreres.
4. **Prosjektoppslag.** `repository.full_name` normaliseres til `owner/repo` med
   små bokstaver, og sammenlignes med samme normalform av `projects.repo_url`.
   Dette er nødvendig fordi `repo_url` finnes i alle varianter – med og uten
   `.git`, med skråstrek til slutt, med `/tree/main` hengende på, i vilkårlig
   case. `ilike` finner kandidatene i Postgres; den endelige sammenligningen
   skjer i JS, fordi `%eier/app%` også ville truffet `eier/app-docs`.
   Verten må være `github.com`, ellers kunne en webhook trigget en deployment av
   et likt navngitt repo hos en annen leverandør.
5. **Gren, per prosjekt.** For hvert kandidat-prosjekt: har det valgt en gren
   (`projects.branch`), bygges det kun ved push til nøyaktig den. Er feltet NULL,
   gjelder repoets `default_branch`, med `main`/`master` som fallback for en
   payload som mangler feltet.

   **Rekkefølgen her er byttet med vilje.** Grensjekken lå tidligere før
   oppslaget, som en enkelt sjekk mot `default_branch`. Det kan den ikke gjøre
   lenger: kriteriet er «prosjektets valgte gren», og det finnes ikke før vi vet
   hvilke prosjekter pushen gjelder. Flere prosjekter kan peke på samme repo med
   *ulike* grener – `main` i produksjon og `dev` på et forhåndsvisnings-subdomene
   – og en push til `dev` skal starte det andre og la det første stå urørt.
   Prisen er én databasespørring også for pusher vi ender med å ignorere.
6. **Trigger.** `startDeployment(project)` per treff. Flere prosjekter kan peke
   på samme repo – to kolleger i samme organisasjon, ett repo deployet under to
   slugs, eller `main` og `dev` side om side – og alle som deployer fra den
   pushede grenen bygges.

### Svar til GitHub

| Kode | Når |
| --- | --- |
| 200 | `ping`, ukjent event, tag/slettet gren, ingen prosjekter som bruker repoet, eller ingen av dem som deployer fra den pushede grenen |
| 202 | Minst ett prosjekt matchet. `results[]` sier per prosjekt om det startet (`deploying`) eller ble hoppet over (`already_building`) |
| 400 | Payloaden kunne ikke tolkes, eller mangler `repository.full_name` |
| 401 | Signaturen stemmer ikke (og secret er konfigurert) |
| 413 | Body over 5 MB. Ruten er åpen, så den har et tak |
| 500 | Databasen svarte ikke. «Redeliver» hos GitHub er riktig måte å prøve igjen |

En push som kommer mens prosjektet allerede bygges gir **202, ikke 409**:
`inFlight`-låsen hopper over prosjektet, og en push under en pågående build er en
forventet tilstand – ikke en leveringsfeil GitHub skal farge rød i
leveringsloggen. Endringen fra pushen kommer med i neste deployment.

Ingenting i mottaket kaster videre. Alt som går galt logges med `pino`, beriket
med `x-github-delivery`, som er den samme ID-en GitHub viser i leveringsloggen
sin – limet mellom deres side og våre logger.

### Oppsett

På App-en (https://github.com/settings/apps → Webhook):

- **Webhook URL:** `<API_EXTERNAL_URL>/api/webhooks/github`
- **Webhook secret:** samme verdi som `GITHUB_WEBHOOK_SECRET` i `.env`
- **Subscribe to events:** `Push`

## Reconcile ved oppstart

Caddy startes med `--config /etc/caddy/config.json`, så dynamisk opprettede
ruter forsvinner ved restart. **Supabase er source of truth, ikke proxyens
minne.** Ved oppstart går backend gjennom alle prosjekter med en vellykket
deployment, sjekker om containeren faktisk kjører, og gjenoppretter ruten
(`reconcileRoutes()` i `deploy.ts`).

Hvilken container ruten skal peke på, avgjøres av **databasen**: den nyeste
deploymenten med status `success` gir containernavnet. Bare hvis den containeren
ikke kjører, faller vi tilbake til den nyeste kjørende containeren prosjektet
har. Uten det ville en igjenglemt container fra en avbrutt deployment – backend
drept mellom helsesjekk og opprydding – kunne overta trafikken ved neste omstart
bare fordi den er nyest. Er det flere kjørende containere for samme prosjekt,
logges det som en `warn`; neste deployment rydder dem.

**Dette kjører kun ved oppstart.** Dør containeren en time senere, oppdager
ingenting det – se neste avsnitt for mekanismen som faktisk løser det.

## Containerhelse: en app som er død skal ikke stå som Live

`eierfullstack` sto som `success`/Live i produksjon i dagevis etter at
containeren var borte – `docker stats` viste `0B / 0B`, Caddy hadde fortsatt
ruten, siden svarte 502. To hull i det som fantes fra før gjorde at ingen
merket det: `assertStillRunning()` er ett vindu rett etter utrulling og ser
aldri på appen igjen, og `reconcileRoutes()` over kjører kun ved
backend-oppstart. Et system som lyver om egen tilstand er verre enn ett som
feiler synlig – derfor `services/helse.ts`.

**Sveipet.** Hvert `SNOAT_HEALTH_CHECK_INTERVAL_MS` (standard 2 minutter,
`startHealthSweep()` i `index.ts`): finn hvert prosjekt databasen påstår har en
kjørende container – ikke stoppet, ikke statisk, med minst én vellykket
deployment – og sammenlign mot `containers.runningProjectIds()`, ett samlet
Docker-kall for hele verten.

**Retting, ikke bare logging.** Finner sveipet et avvik, settes
`projects.container_died_at` (migrasjon 0015) til tidspunktet – det er
rettelsen av basens tilstand problemet krevde. Kommer containeren tilbake
(Docker sin egen `on-failure`-restart lyktes til slutt, eller noen rettet det
manuelt), nullstilles feltet av samme sveip. En ny vellykket deployment
nullstiller det med én gang også (`clearHealthFlag()`), i stedet for at
dashboardet skal vise «Nede» i opptil to minutter etter at problemet faktisk er
løst.

**Grensesnittet.** `DeploymentStatusBadge` viser «Nede» – rødt, samme
alvorlighet som «Feilet» – når `container_died_at` er satt, i stedet for å
kalle det «Live». Lenker til appen skjules samtidig som badgen endrer seg: en
lenke som ser levende ut, men gir 502, er verre enn ingen.

**Varsel.** Ved *overgangen* til nede (ikke ved hvert sveip som bekrefter et
allerede kjent avvik) sender `services/notify.ts` én e-post til
`SNOAT_NOTIFY_TO`, og likeså ved gjenoppretting. Samme infrastruktur som
`notifyFirstDeploymentLive` – ingen ny utsendingsvei.

**Restart-regelen som gjør at sveipet har noe å finne.** Containere kjørte
tidligere med `RestartPolicy: unless-stopped` – Docker restartet en krasjende
app i det uendelige, uten tak og uten at noen fikk vite det. Nå er den
`on-failure:N` (`SNOAT_APP_RESTART_MAX_RETRIES`, standard 5, se `containers.ts`
og `config.ts`): en container som dør av forbigående minnemangel kommer opp
igjen av seg selv innenfor de første forsøkene, men en app i krasj-loop gir opp
etter N ganger og blir stående stoppet – synlig for dette sveipet i stedet for
å restarte i stillhet for alltid.

**Hva sveipet bevisst ikke gjør.** Det rører verken Docker eller Caddy – ingen
restart, ingen sletting, ingen omdirigering av ruten bort fra den døde
containeren. Ruten blir stående til en ny deployment bytter den eller noen
griper inn manuelt. Sveipets jobb er å si sannheten i basen og i
dashboardet, ikke å reparere infrastrukturen på egen hånd.

## Krav til brukerens applikasjon

- Må lytte på porten i `$PORT` (`SNOAT_APP_PORT`, standard 3000) på `0.0.0.0`.
- Må kunne bygges av Nixpacks, eller ha en `nixpacks.toml`.
- Trenger appen en bestemt Node-versjon, oppgis den i `engines.node` eller
  `.nvmrc`. Uten det bygges den med `SNOAT_DEFAULT_NODE_VERSION` (se steg 4).
- Private repoer fungerer **hvis** prosjektet ble opprettet gjennom
  repo-velgeren, altså har `github_installation_id` satt: da klones det med et
  kortlevd installasjonstoken (`authenticatedCloneUrl()` i `lib/github.ts`). Er
  URL-en limt inn for hånd, er `github_installation_id` `NULL`, og repoet må være
  offentlig.
- Skal auto-deploy virke, må App-en være installert på repoet – ellers sender
  GitHub ingen push-events til oss.
- Skal en annen gren enn repoets standardgren bygges, settes den under
  Innstillinger (eller ved opprettelsen). Feltet er tomt som standard, og et tomt
  felt betyr «følg det GitHub peker på» – også hvis default branch byttes senere.

## Ikke implementert ennå

- **Deploy-preview per gren/PR.** Et prosjekt bygger *én* gren, valgt på
  forhånd. Det er ikke det samme som Vercel sine previews: en push til en
  vilkårlig feature-gren gir fortsatt ingen midlertidig URL, og en pull request
  får ingen egen adresse. Vil man se `dev` på nett, opprettes `dev` som et eget
  prosjekt med sitt eget subdomene – manuelt, én gang, ikke automatisk per gren.
- **Trigger-kilden vises ikke i UI.** En webhook-build og en manuell build ser
  identiske ut i dashboardet – `deployments` har ingen kolonne som skiller dem.
- **Helsesjekk over HTTP.** Vi verifiserer at containeren *står*, ikke at appen
  svarer på `$PORT`. En app som starter uten å binde porten regnes som frisk.
  Backend ligger ikke på `snoat_apps`-nettverket og kan derfor ikke nå appen
  direkte; en ordentlig readiness-probe må gå gjennom Caddy eller kobles på
  nettverket. Gjelder både `assertStillRunning()` ved utrulling og det
  periodiske sveipet i `services/helse.ts` – begge ser på Docker, ingen av dem
  spør appen selv om noe.
- **Automatisk rute-reparasjon når en container er død.** `services/helse.ts`
  oppdager avviket og retter *basens* påstand (`container_died_at`), men rører
  ikke Caddy-ruten. Er containeren først borte, blir ruten stående og peke på
  ingenting til noen deployer på nytt eller griper inn manuelt – se
  «Containerhelse» over for hvorfor det er en bevisst grense og ikke en
  forglemmelse.
- **Tilbakerulling til forrige versjon.** Vi beholder den gamle containeren til
  den nye er frisk, men når den først er fjernet, finnes ingen «rull tilbake til
  forrige deployment»-knapp. Image-et fra forrige build har mistet taggen sin
  (`snoat/<slug>` overskrives per build) og ligger igjen som et dangling image
  til Docker rydder det.
- **Egne domener.** Ruten som opprettes matcher kun
  `<slug><SNOAT_APP_DOMAIN_SUFFIX>`. Kunden kan sette DNS-pekerne sine (fanen
  «DNS» veileder i det), men Caddy svarer ikke på vertsnavnet før det legges inn
  som ekstra `host` på ruten. Se `11_custom_domains_and_dns.md`.
- **Bygging på tvers av flere verter.** Alt kjører mot én Docker-daemon.
