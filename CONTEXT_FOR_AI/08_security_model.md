# Sikkerhetsmodell

Snoat kjører vilkårlig brukerkode i containere på egen infrastruktur. Dette
dokumentet samler tillitsgrensene, hva som faktisk er implementert, og hva som
gjenstår før produksjon.

## Tillitsgrenser

```
Bruker (nettleser)                     Besøkende på en kundeapp
  │  anon-nøkkel + eget JWT              │  ingen autentisering
  ▼                                      ▼
Supabase ─── RLS: kun egne rader       Caddy ─── ser IP fra TCP-koblingen
  ▲                                      │  access-logg, kun docker-nettet
  │  service-role-nøkkel (omgår RLS)     ▼
Snoat backend ─── eierskap i koden ◄──── ingest (port 3100)
  │
  ▼
Docker-daemon ──── full kontroll over verten
```

Jo lenger ned, jo større privilegier. Hvert nivå må derfor ikke lekke oppover.

**Analytikk-ingesten er en skrivevei uten autentisering**, og er sikret ved
plassering framfor ved tokens: porten bindes til `0.0.0.0` *inne i containeren*,
men publiseres aldri i `ports:`, så den er kun nåbar fra `snoat`-nettverket.
Legger du den i `ports:`, kan hvem som helst dikte opp trafikk for et hvilket
som helst prosjekt. Til gjengjeld kan **IP-en ikke forfalskes**: den leses av
Caddy fra TCP-koblingen på kanten, ikke fra en header klienten kontrollerer.

## Implementert

**RLS på alle tabeller.** Brukeren når Supabase direkte med anon-nøkkelen fra
nettleseren. Anon-nøkkelen er offentlig og gir ingen tilgang i seg selv – det er
RLS-policyene som avgjør hva som returneres. Frontend filtrerer aldri på
`user_id`; databasen gjør det.

**Eierskapssjekk i backend.** Backend bruker service-role-nøkkelen og omgår RLS.
`loadOwnedProject()` er derfor den eneste kontrollen som står mellom en bruker og
andres prosjekter. Den svarer 404 og ikke 403, slik at et ID-gjett ikke avslører
at raden finnes.

**Abonnementet ligger i en tabell brukeren ikke kan skrive til.** RLS i Postgres
er rad-nivå, ikke kolonne-nivå. `profiles` har en update-policy for eieren, så en
`plan`-kolonne der ville latt enhver bruker kjøre
`update profiles set plan = 'business'` mot sin egen rad fra nettleserkonsollen –
og betalingsmuren ville vært omgått med én linje. `public.subscriptions` har
derfor **kun en select-policy**, og all skriving skjer fra backend etter en
verifisert Stripe-signatur. Samme resonnement som `github_installations`.

Regelen generelt: **legg aldri et privilegium som en kolonne på en tabell
brukeren kan oppdatere.** Skal en slik kolonne likevel dit, må rettigheten
trekkes tilbake på kolonnenivå med `revoke update (kolonne)` – ikke med en
RLS-policy, for den kan ikke se forskjell på kolonner.

**Token valideres av GoTrue,** ikke ved lokal signaturverifisering. Det fanger
også opp tokens som er trukket tilbake.

**E-post må bekreftes før kontoen er aktiv.** `ENABLE_EMAIL_AUTOCONFIRM=false`
er ikke kosmetikk. Med autoconfirm på blir en adresse markert som bekreftet uten
at noen beviser eierskap, og da åpner denne kjeden seg: en angriper registrerer
`offer@domene.no` med sitt eget passord, kontoen auto-bekreftes, og når offeret
senere logger inn med GitHub matcher GoTrue på den «verifiserte» adressen og
lenker OAuth-identiteten inn i angriperens konto. Angriperen har fortsatt
passordet. Bekreftelseskravet er det som lukker den.

**Passord settes kun mot bevist e-posteierskap.** Registrering kan aldri sette
passord på en adresse som allerede finnes – GoTrue avviser med
`user_already_exists`, og frontend flytter brukeren til innlogging i stedet for
å prøve å omgå det. Vil en OAuth-bruker legge til passord, går det via
gjenopprettingslenken i `/forgot-password` → `/reset-password`, der lenken i
innboksen er beviset.

**Gjenopprettingsskjemaet lekker ikke hvem som er registrert.**
`/forgot-password` viser samme nøytrale kvittering uansett om adressen finnes.
Merk at signup-endepunktet er enumerable når autoconfirm står på – nok en grunn
til å holde den av.

**Repo-URL valideres.** `assertSafeRepoUrl()` tillater kun `http(s)`. Uten den
kunne `repo_url` vært `ext::sh -c …`, som får git til å kjøre vilkårlige
kommandoer på byggemaskinen.

**Grennavn valideres på samme måte.** `projects.branch` (migrasjon 0012) blir
`--branch <verdi>` på samme kommandolinje, og er dermed samme angrepsflate: git
leser et argument som starter med `-` som en opsjon, og `--upload-pack=…` er
kommandokjøring på byggeverten. `assertSafeBranch()` krever at første tegn er en
bokstav, et tall eller en understrek, og avviser ellers alt som ikke er et
konservativt gyldig refnavn (`..`, `//`, avsluttende `/`, `.lock`, `@{`,
mellomrom, `~^:?*[`). Regelen står **to** steder – også som check-constrainten
`projects_branch_check` – fordi dashboardet skriver prosjektraden selv med sin
egen sesjon, mens backend omgår constrainten med service-role-nøkkelen. Ingen av
de to veiene inn skal være uvoktet.

**Ingen shell-interpolasjon.** Nixpacks kalles med et argument-array via `execa`,
ikke som en bash-streng. Brukerens miljøvariabler går derfor aldri gjennom et
shell. (Dokploy, som vi henter mønstre fra, bygger en bash-streng og må
shell-escape – vi unngår hele problemklassen.)

**Brukerapper publiserer ingen port på verten.** De ligger på det interne
`snoat_apps`-nettverket, og Caddy er eneste vei inn. En app kan ikke nås direkte
på en tilfeldig hostport.

**Ressurstak per container.** `Memory` og `NanoCpus` settes på hver
applikasjonscontainer. Dette er mekanismen som gjør gratisplanen mulig uten at
ett prosjekt kan sulte ut verten.

Merk at taket er per *container*, ikke per prosjekt. Under en rullerende utrulling
kjører to containere for samme prosjekt samtidig, og prosjektet holder da
kortvarig **2× `SNOAT_APP_MEMORY_MB`** – i sekundene mellom at den nye starter og
den gamle er ryddet. Dimensjoner verten etter det, ikke etter summen av
prosjekter i ro. Skulle den nye containeren bli OOM-drept fordi verten er full,
er utfallet riktignok trygt: helsesjekken feiler, og forrige versjon står.

**Helsesjekken kan ikke overtales av en krasj-loop.** `assertStillRunning()`
krever `RestartCount === 0` gjennom hele vinduet, ikke bare at containeren står
oppe når vi ser etter. Uten det ville en app som krasjer i oppstart – og som
`RestartPolicy: on-failure:N` (`SNOAT_APP_RESTART_MAX_RETRIES`) starter på nytt
flere ganger – blitt sluppet gjennom som «Live», *og* fått en fungerende versjon
revet ned under seg. En deployment kan altså ikke ta ned en app som virker,
verken ved uhell eller ved å bli laget slik med vilje.

**Krasj-loop lenge etter en vellykket deployment er et eget problem.**
`assertStillRunning()` dekker bare sekundene rundt utrullingen. Gir Docker opp
restart-forsøkene en time – eller en uke – senere, oppdager ingenting det før
`services/helse.ts` sitt periodiske sveip (`SNOAT_HEALTH_CHECK_INTERVAL_MS`)
sammenligner det databasen påstår mot det Docker faktisk har, og retter
`projects.container_died_at` deretter. Se `10_recent_updates_and_roadmap.md`.

**Build-timeout.** `SNOAT_BUILD_TIMEOUT_MS` (standard 15 min) avbryter builds som
henger.

**CORS er hvitelistet** til `SNOAT_FRONTEND_ORIGIN`.

**Databasen og Caddys admin-API er kun bundet til loopback** i compose
(`127.0.0.1:5432`, `127.0.0.1:2019`).

**Unike hemmeligheter per installasjon.** Vi bruker ikke Supabase sine
publiserte demo-nøkler; `bootstrap-env.mjs` genererer og signerer egne.

**GitHub-tilgang lagres aldri som token.** Vi kjenner kun installasjons-ID-en og
bytter den inn i et kortlevd token (én time) via App-ens private nøkkel når det
trengs. En OAuth-app ville krevd at vi oppbevarte et langlevd token med
skrivetilgang til alt brukeren eier – med App-modellen velger brukeren selv
hvilke repoer vi ser, og tilgangen er `Contents: read-only`.

**Installasjonskoblingen er signert.** `/github/setup` treffes av nettleseren
uten Authorization-header. `state` er HMAC-signert med `GITHUB_APP_STATE_SECRET`
og har 30 minutters levetid; signaturen sammenlignes med `timingSafeEqual`. Uten
den kunne hvem som helst kalt endepunktet med en vilkårlig `installation_id` og
knyttet andres repoer til sin egen konto. `installation_id` verifiseres i tillegg
mot GitHub før koblingen lagres.

**Webhooks er HMAC-signert.** `POST /api/webhooks/github` er offentlig, og
starter builds – altså et endepunkt som får oss til å bruke CPU, minne og
diskplass. `x-hub-signature-256` verifiseres derfor mot `GITHUB_WEBHOOK_SECRET`
med `timingSafeEqual`, over **råkroppen** av forespørselen. Ruten har i tillegg
et body-tak på 5 MB, slik at en tilfeldig POST ikke kan spise minnet før
signaturen i det hele tatt er sjekket.

Signaturen sier bare at *GitHub* sendte forespørselen. Hvilket prosjekt som skal
bygges avgjøres av `repository.full_name` i payloaden, matchet mot `repo_url` –
og verten i den må være `github.com`, ellers kunne en push til
`github.com/eier/app` trigget en deployment av `gitlab.com/eier/app`.

**Stripe-webhooken feiler lukket.** `POST /api/webhooks/stripe` verifiseres mot
`STRIPE_WEBHOOK_SECRET` over råkroppen, med et body-tak på 1 MB. Er secreten tom,
avvises **alt** med 503 – i motsetning til GitHub-varianten under, som tas imot
uverifisert med en advarsel. Forskjellen er tilsiktet: en uverifisert
GitHub-webhook koster oss et uønsket bygg, mens en uverifisert Stripe-webhook
lar hvem som helst POST-e seg til Business-planen. Se `12_billing_and_plans.md`.

**Klone-URL-er redigeres før logging.** `lib/redact.ts` fjerner credentials fra
alt som skrives til byggeloggen. Loggen lagres i `deployments.logs` og leses av
frontend med anon-nøkkelen, så et installasjonstoken i URL-en ville vært synlig
for alle som kan se loggen. Både vår egen logging, git sitt stderr og execa sine
feilmeldinger går gjennom den – alle tre gjentar URL-en ordrett.

## Kjente risikoer

**Personvern i trafikkanalysen er avhengig av at loggen ikke lekker.** Caddys
`filter`-encoder sletter `Cookie`, `Authorization`, `Set-Cookie` og
`Proxy-Authorization` før noe forlater proxyen, og loggen går rett over
docker-nettet uten å innom disk. IP-en finnes i klartekst kun i minnet til
`handleLine()`, fram til den hashes bort. Endrer du encoder-konfigurasjonen i
`caddy/config.json`, endrer du samtidig hva som er personopplysninger på avveie
– feltene skal legges til, aldri fjernes. Aktiverer du fillogging i tillegg,
skriver du IP-adresser til disk, og da gjelder andre regler for oppbevaring.

**Loggstrømmen dekker også plattformens egne vertsnavn.** Serveren logger alt,
og ingesten forkaster det som ikke tilhører et prosjekt. Det er enklere og
sikrere enn per-rute-konfigurasjon, men det betyr at forespørsler mot
`api.snoat.com` og Supabase også passerer parseren. De havner ingen steder, men
kravet om at hemmeligheter er filtrert bort gjelder derfor dem også.

**Docker-socketen er montert inn i backend-containeren.** Det gir containeren
reell root-tilgang på verten – enhver RCE i backend blir til vertskompromittering.
Akseptabelt i utviklingsmiljøet. I produksjon bør backend enten kjøre direkte på
verten, eller gå gjennom en socket-proxy som kun tillater de API-kallene
pipelinen faktisk bruker.

**Brukerkode kjører uten ekstra sandboxing.** Containere deler kjerne med verten.
For flerbruker-produksjon bør man vurdere gVisor, Kata Containers eller
dedikerte byggenoder, samt `--read-only`, `no-new-privileges` og droppede
capabilities på applikasjonscontainere.

**Miljøvariabler lagres i klartekst** i `projects.env_vars` (JSONB). De er
beskyttet av RLS, men ikke kryptert i hvile. Bør krypteres med en nøkkel backend
holder, før plattformen tar imot ekte produksjonshemmeligheter.

**Byggelogger kan inneholde hemmeligheter.** Nixpacks-output skrives ordrett til
`deployments.logs`. Et byggeskript som ekkoer en variabel vil lekke den inn i
loggen, som brukeren selv kan lese – men den er ikke maskert.

**Ingen rate limiting.** Låsen i `deploy.ts` hindrer to samtidige builds av
*samme* prosjekt, men ingenting begrenser antall prosjekter eller builds totalt.
Webhooken gjør dette mer aktuelt enn før: builds startes nå av pushene til
brukeren, ikke av en knapp noen må trykke på.

**Webhooks uten secret tas imot uverifisert.** `GITHUB_WEBHOOK_SECRET` er
valgfri, slik at oppsettet kan prøves ut før secreten er på plass. Står den tom,
kan hvem som helst poste en oppdiktet push-payload til `/api/webhooks/github` og
starte builds av et hvilket som helst repo som finnes i `projects` – en
ressursutmattelse, ikke et datainnbrudd, siden bare kode som allerede er koblet
til Snoat kan bygges. Backend logger en `warn` per forespørsel så lenge den står
tom. **Sett den i produksjon.**

**Ingen nettverksisolasjon mellom brukerapper.** Alle deployede containere ligger
på det samme `snoat_apps`-nettverket og kan nå hverandre på containernavn. Bør
bli ett nettverk per bruker, eller per prosjekt.

Aliaset `<slug>` på nettverket peker dessuten på **begge** versjoner i sekundene
en utrulling varer, siden Docker gir round-robin mellom containere som deler
alias. En app som kaller en annen app på prosjektnavnet kan altså treffe gammel
eller ny versjon i det vinduet. Caddy er upåvirket – den dial-er containernavnet,
som er entydig per deployment.

**Rester etter avbrutt utrulling holder ressurser.** Blir backend drept mellom
helsesjekken og oppryddingen, står to containere igjen for prosjektet, og den
gamle fortsetter å bruke minne og CPU uten å få trafikk. `reconcileRoutes()`
logger en `warn` ved oppstart, men rydder ikke – det gjør neste deployment, eller
en operatør. Det samme gjelder hvis `retirePrevious()` ikke får stoppet
containeren: deploymenten regnes som vellykket (trafikken går til den nye), og den
gamle logges som noe som må ryddes for hånd.

**Ingen egress-kontroll.** En deployet app kan nå internett fritt, inkludert
plattformtjenestene på `snoat`-nettverket dersom noe skulle koble nettverkene.

**Avinstallasjon oppdages først ved neste oppslag.** Fjerner en bruker App-en,
vet vi det ikke før `/api/github/repos` får 404 og rydder raden. Vi *har* nå
webhook-mottak, men abonnerer kun på `push` – `installation`-eventet, som ville
gitt beskjeden med én gang, håndteres ikke. Koblingen kan derfor ligge foreldet i
databasen i mellomtiden. Den gir ingen tilgang – tokenet utstedes først ved bruk,
og GitHub nekter – men `github_installations` speiler ikke virkeligheten før noen
ser etter.

**To GitHub-registreringer med ulik risikoprofil.** OAuth-appen (`SnoatSSO`,
client ID `Ov23li…`) gjør innlogging og har kun en client secret. GitHub App-en
(`snoatauth`, App ID 4426927) driver repo-velgeren og har en RSA-privatnøkkel som
signerer App-JWT-er. Nøkkelen ligger base64-kodet i klartekst i `.env` på både
Mac og VPS. Kompromitteres den, kan angriperen utstede installasjonstokens for
alle repoer App-en er installert på – begrenset til `Contents: read-only`, men
det inkluderer private repoer brukere har delt. Roter den ved mistanke:
generer ny nøkkel hos GitHub, og slett den gamle der.

Merk at klient-ID-prefikset skiller typene: `Ov23li…` er en OAuth App, `Iv23li…`
er en GitHub App. En OAuth App har aldri en privatnøkkel.

**Utgående e-post avhenger av Resend.** `RESEND_API_KEY` gir full sendetilgang
på det verifiserte domenet og ligger i klartekst i `.env`. Faller Resend ut,
kan ingen registrere seg eller gjenopprette passord – auth har nå en ekstern
avhengighet den ikke hadde med autoconfirm.

## Før produksjon

1. Fjern direkte docker.sock-tilgang fra backend.
2. Krypter `env_vars` i hvile.
3. Ett Docker-nettverk per bruker.
4. Rate limiting på deploy-endepunktet – og på webhook-endepunktet.
5. Sett `GITHUB_WEBHOOK_SECRET`, både i `.env` og på App-en.
6. Herding av applikasjonscontainere (`no-new-privileges`, droppede
   capabilities, read-only rootfs der det lar seg gjøre).
7. TLS. Caddy henter Let's Encrypt-sertifikater automatisk for ekte domener –
   `*.snoat.localhost` kjører på HTTP i dev.
