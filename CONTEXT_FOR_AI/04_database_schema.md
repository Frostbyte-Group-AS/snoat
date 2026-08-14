# Supabase MVP Databasestruktur

Plattformen benytter en relasjonsdatabase (PostgreSQL via Supabase) for å holde styr på brukere, prosjekter og byggeprosesser.

Skjemaet er implementert i `supabase/migrations/0001_snoat_schema.sql`, og
speiles i TypeScript i `backend/src/types.ts` og `frontend/src/lib/database.types.ts`.

## profiles
Håndterer utvidet brukerdata knyttet til Supabase Auth (GitHub).
- **Kolonner:**
  - `id` (PK, refererer `auth.users`)
  - `full_name`
  - `avatar_url`
  - `created_at`

Raden opprettes automatisk av triggeren `on_auth_user_created` på `auth.users`,
som plukker `full_name`/`name`/`user_name` og `avatar_url` ut av GitHub-profilen
GoTrue lagrer i `raw_user_meta_data`.

## projects
Hvert repository som er koblet til plattformen.
- **Kolonner:**
  - `id` (PK)
  - `user_id` (FK -> `profiles`)
  - `name` (URL-vennlig slug)
  - `repo_url`
  - `build_command` (valgfri override)
  - `env_vars` (JSONB for `.env`)
  - `github_installation_id` (valgfri, se under)
  - `stopped_at` (når brukeren slo av appen; NULL = kjører)
  - `created_at`

`stopped_at` (migrasjon 0005) er den **synlige** tilstanden til et stoppet
prosjekt. Før den fantes, skrev `POST /api/projects/:id/stop` ingenting til
databasen: den fjernet Caddy-ruten og containerne, men alt dashboardet tegner –
statusprikken, live-URL-en og om stopp-knappen vises – utledes av
`deployments.status`, som fortsatt sier `success` etter en stopp. Et vellykket
stopp så derfor ut som om ingenting skjedde.

Containeren kan ikke være kilden til den tilstanden: frontend snakker med
Supabase, ikke med Docker, og «stoppet av brukeren» er noe annet enn «ingen
container kjører akkurat nå» – det siste er også sant midt i en deployment.

Feltet nullstilles av `startDeployment()`, ikke ved vellykket build, slik at
dashboardet slutter å si «Stoppet» i samme øyeblikk byggingen starter.

`name` er subdomenet applikasjonen blir live på, og valideres derfor mot
`^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$` i databasen. Kombinasjonen
`(user_id, name)` er unik.

`github_installation_id` peker på installasjonen repoet ble valgt gjennom.
Er den satt, kloner backend med et installasjonstoken – det er dette som gjør
private repoer mulige. `NULL` betyr at URL-en ble limt inn for hånd, og repoet
må da være offentlig.

**`repo_url` er ikke bare noe vi kloner fra – den er også nøkkelen webhooks slår
opp på.** Et push-event kjenner bare `owner/repo`, så
`backend/src/routes/webhooks.ts` normaliserer begge sider til `owner/repo` med
små bokstaver før de sammenlignes (`repoIdentity()` i `lib/github.ts`). Kolonnen
har ingen formatvalidering i databasen, og verdiene finnes derfor med og uten
`.git`, med skråstrek til slutt og i vilkårlig case – normaliseringen er det som
gjør at alle variantene likevel treffer. Legger man til en ny måte å registrere
repoer på, er det denne normalformen som må holde, ellers slutter auto-deploy å
finne prosjektet uten at noe annet ser galt ut.

Kombinasjonen `(user_id, repo_url)` er **ikke** unik: flere prosjekter kan peke
på samme repo, og ett push-event starter da en deployment per prosjekt.

`external_ref` (migrasjon 0010) er integrasjonens egen ID for prosjektet, satt av
`POST /api/projects`. Den gjør opprettelsen idempotent: unik på
`(user_id, external_ref)` gjennom en **delvis** indeks, slik at prosjekter fra
dashboardet – der feltet er NULL – ikke teller som duplikater av hverandre.
Unikheten er per bruker og ikke global, så to partnere kan bruke samme interne
ID-er uten å kollidere.

## api_keys
Langlevde nøkler for maskin-til-maskin-tilgang (migrasjon 0010).
- **Kolonner:** `id`, `user_id` (FK -> `profiles`), `name`, `token_prefix`,
  `token_hash`, `created_at`, `last_used_at`, `revoked_at`

**Vi lagrer aldri nøkkelen i klartekst** – kun sha256-hashen, av samme grunn som
vi aldri lagrer et GitHub-token. `token_prefix` er de første tegnene, slik at en
nøkkel kan gjenkjennes i en liste uten å avsløre resten. Tilbaketrekking er en
tidsstempling og ikke en sletting: en nøkkel som har vært i bruk skal kunne spores
i ettertid.

RLS er slått på **uten en eneste policy**. Det er ikke en forglemmelse: en tabell
uten policies er stengt for alle andre enn service-role-nøkkelen, og en innlogget
bruker i nettleseren har ingenting her å gjøre.

`last_used_at` skrives uten at kallet venter på svaret. Feltet finnes for at vi
skal kunne se hvilke nøkler som er i bruk før vi rydder, og det er ikke verdt et
rundturs-kall i den kritiske stien for hver forespørsel – langt mindre verdt at en
mislykket skriving gjør et gyldig kall til en 401.

## github_installations
Kobling mellom en Snoat-bruker og en GitHub App-installasjon.
- **Kolonner:**
  - `id` (PK)
  - `user_id` (FK -> `profiles`)
  - `installation_id` (`bigint` – GitHub sine ID-er går utenfor int4)
  - `account_login`, `account_type`
  - `created_at`

**Vi lagrer aldri et GitHub-token.** Installasjons-ID-en er nok: backend bytter
den inn i et kortlevd token (én time) via App-ens private nøkkel når det trengs.
Lekker databasen, følger det ingen tilgang til brukerens kode med den.

`(user_id, installation_id)` er unik. Samme installasjon kan kobles til flere
Snoat-kontoer – to kolleger i samme organisasjon – men ikke to ganger til én.

## deployments
En historikk over hver gang et prosjekt bygges.
- **Kolonner:**
  - `id` (PK)
  - `project_id` (FK -> `projects`)
  - `status` (`queued`, `building`, `success`, `failed`)
  - `commit_hash`
  - `logs` (tekst eller JSON-strøm)
  - `url` (slutt-URL for deploymenten)
  - `created_at`

  - `duration_ms` (hvor lenge bygget kjørte)

`status` er en Postgres-enum (`public.deployment_status`). `logs` skrives som ren
tekst av backend, som holder hele loggen i minnet og skriver den komplette
teksten ved hver flush – det gjør skrivingen idempotent og hindrer at to
samtidige flush-er mister linjer.

`duration_ms` (migrasjon 0004) er grunnlaget for kvoten på byggeminutter. Den
skrives i **både** suksess- og feilgrenen av pipelinen: et bygg som feiler etter
ti minutter har brukt ti minutter av verten. NULL betyr at bygget pågår, eller at
raden er fra før 0004.

## subscriptions

Abonnementet til én bruker. Se `12_billing_and_plans.md` for hele modellen.

- **Kolonner:**
  - `user_id` (PK, FK -> `profiles`)
  - `plan` (`free`, `pro`, `business` – enum `public.subscription_tier`)
  - `status` (enum `public.subscription_status`)
  - `source` (`stripe` eller `invoice`)
  - `stripe_customer_id`, `stripe_subscription_id`
  - `current_period_end`, `delinquent_since`, `cancel_at_period_end`
  - `currency` (0009) – ISO-4217 lowercase. **Låst etter første faktura**:
    Stripe knytter valutaen til kunden, ikke til abonnementet, så den kan ikke
    byttes uten en ny Stripe-kunde. Er den satt, overstyrer den visningsspråket
    når backend velger prisliste.
  - `billing_country` (0009) – ISO-3166-1 alpha-2 fra adressen i Stripe.
    Avgiftsgrunnlaget. Ikke utledet av språk eller valuta – en kunde kan betale i
    euro og holde til i Norge.
  - `customer_kind` (0009) – `individual` eller `business`, avledet av om kunden
    oppga mva-nummer i kassen. Avgjør omvendt avgiftsplikt i EU.
  - `created_at`, `updated_at`

De tre markedskolonnene er `text` med regex-sjekk og ikke enum, med vilje: dette
er data vi henter fra Stripe, ikke tilstander vi selv kontrollerer. En enum måtte
fått en migrasjon for hvert nye marked, og ville feilet skrivingen fra webhooken
– altså midt i en betaling – hvis Stripe sendte noe vi ikke hadde forutsett.

**⚠️ Dette er en egen tabell og ikke kolonner på `profiles`, av én grunn:**
`profiles` har `profiles_update_own`, og RLS i Postgres er rad-nivå, ikke
kolonne-nivå. Lå `plan` der, kunne enhver bruker kjørt
`update profiles set plan = 'business'` fra nettleseren mot sin egen rad og gitt
seg selv Business gratis. Se policy-tabellen under.

Det samme gjelder `currency`: kunne en bruker satt den selv, kunne hen valgt
hvilken prisliste kontoen skulle måles mot – og siden en lagret valuta overstyrer
alt annet, ville løgnen overlevd helt fram til kassen.

Triggeren `on_profile_created` gir hver ny profil en `free`-rad. At raden alltid
finnes er tryggere enn å la backend håndtere «finnes ikke» – det tilfellet ville
fort blitt tolket som «ingen grenser» av en framtidig endring.

## stripe_events

Idempotensnøkler for Stripe-webhooks: `id` (Stripe sin event-id, PK), `type`,
`received_at`. Stripe leverer «at least once», og innsettingen i denne tabellen
er låsen som hindrer at samme event behandles to ganger.

RLS er på **uten en eneste policy**: `authenticated` og `anon` kommer ikke til,
service_role omgår RLS. Dette er backend-intern tilstand og angår ingen bruker.

## Row Level Security

RLS er på for alle tabellene. Policyene er eier-scopet:

| Tabell | Policy |
| --- | --- |
| `profiles` | Bruker kan lese og oppdatere sin egen rad. |
| `projects` | Bruker har full tilgang til egne prosjekter (`for all`). |
| `deployments` | Bruker kan **lese** deployments for egne prosjekter. Skriving skjer kun fra backend. |
| `github_installations` | Bruker kan **kun lese** egne koblinger. Skriving skjer kun fra backend, etter at GitHub har bekreftet installasjonen – en klient som kunne skrive her, kunne knyttet seg til en annens repoer. |
| `subscriptions` | Bruker kan **kun lese** sin egen rad. Det finnes bevisst ingen update-policy: planen settes utelukkende av backend etter en verifisert Stripe-signatur. |
| `stripe_events` | Ingen policyer i det hele tatt. Kun service_role. |

Backend bruker service-role-nøkkelen og **omgår RLS**. Derfor må den verifisere
eierskap selv – det gjør `loadOwnedProject()` i `backend/src/middleware/auth.ts`.
Det er den eneste kontrollen som står mellom en bruker og andres prosjekter, og
den svarer 404 (ikke 403) slik at et ID-gjett ikke avslører at raden finnes.

Frontend filtrerer aldri på `user_id` i spørringene sine – det gjør databasen.

## Realtime

`deployments` er lagt til publikasjonen `supabase_realtime` og har
`replica identity full`, slik at dashboardet kan filtrere på `id` ved UPDATE.
Dette er kanalen byggestatus og live logger går over; frontend poller ikke.

## analytics (eget skjema)

Trafikkstatistikken ligger i skjemaet `analytics`, ikke i `public`. Det er et
bevisst valg: PostgREST eksponerer kun `public`, så tabellene er ikke nåbare fra
nettleseren uansett hvordan RLS måtte bli konfigurert senere. RLS er likevel
slått på uten policyer (= alle nektes), og de eneste veiene inn er tre
`security definer`-funksjoner i `public` som kun `service_role` har `execute` på.

| Tabell | Nøkkel | Innhold |
|---|---|---|
| `rollup_hourly` | `(project_id, hour)` | `pageviews`, `visits`, `requests`, `bytes_out`, `errors_4xx`, `errors_5xx`, `duration_sum_ms`, `bot_requests` |
| `visitors_daily` | `(project_id, day, visitor)` | `visitor` = sha256(dagssalt ‖ prosjekt ‖ IP ‖ UA), 32 byte |
| `rollup_dim` | `(project_id, day, dim, value)` | `hits` per toppside, henviser, nettleser, OS, enhet og land |

Modellen er **ferdig aggregert**. Rå treff lagres ikke i det hele tatt: på en
delt VPS er forskjellen mellom «les 30 ferdige rader» og «`count(*)` over fire
millioner» forskjellen på om Postgres har headroom til resten av plattformen.

Funksjonene:

- `analytics_ingest_batch(payload jsonb)` – tar imot en hel flush fra ingesten.
  Nye besøk telles ved at `on conflict do nothing ... returning` på
  `visitors_daily` gir tilbake nøyaktig de hashene vi ikke hadde sett i dag.
  Det gjør `visits` korrekt uansett hvor mange ganger backend startes på nytt.
- `analytics_summary(project, from, to, unit, limit, tz)` – hele dashboardfanen
  i ett kall. `unit` går gjennom en allowlist før `date_trunc`, og bøttene
  regnes i norsk tid slik at «i dag» ikke starter kl. 01:00.
- `analytics_prune(visitor_days, rollup_days, dim_keep)` – sletter etter
  lagringsbegrensning og folder halen i `rollup_dim` inn i `(annet)`.

`visitor`-hashen er anonym, ikke bare pseudonym: saltet lever kun i minnet til
backend og roterer ved døgnskiftet, og IP-en lagres aldri. Prisen er at unike
besøkende over flere dager blir *summen av daglige unike* – samme kompromiss som
Plausible og Umami gjør.

## Migrasjoner

`supabase/migrations/*.sql` kjøres av `db-migrate`-tjenesten i
`docker-compose.yml`, ikke av postgres sitt initdb. Årsaken er at `profiles` har
en fremmednøkkel til `auth.users`, som GoTrue først oppretter når den kjører
sine egne migrasjoner. `db-migrate` venter derfor på at `auth` er healthy.

Migrasjonene kjøres på nytt ved hver oppstart og **må være idempotente**
(`create ... if not exists`, `drop policy if exists`, guards rundt `create type`).

`supabase/db/init/zzz-01-snoat-roles.sql` er noe annet: det kjøres av postgres
sitt initdb og setter passord på tjenesterollene. Det tar kun effekt på en tom
datakatalog – endrer du `POSTGRES_PASSWORD` eller `JWT_SECRET` må du kjøre
`docker compose down -v`.
