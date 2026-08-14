# Betaling, planer og håndheving

Snoat tar betalt fordi kjørende containere koster reelt minne på en 16 GB VPS.
Denne filen beskriver planene, hvordan de håndheves, og hvordan Stripe er koblet
inn.

Betaling er **valgfritt** i kodebasen, på samme måte som GitHub App-en: uten
`STRIPE_SECRET_KEY` starter plattformen som før, alle kontoer kjører på
Free-grensene, og dashboardet skjuler kjøpsknappene.

## Planene

| | Free | Pro | Business |
| --- | --- | --- | --- |
| Pris eks. mva (Norge) | 0 | 199 kr/mnd | 799 kr/mnd |
| Pris eks. mva (øvrige) | 0 | 19 €/mnd | 79 €/mnd |
| Dynamiske apper samtidig | 1 | 5 | 20 |
| RAM per app | 256 MB | 1 GB | 8 GB |
| vCPU per app | 0,5 | 1 | 4 |
| Byggeminutter per måned | 100 | 500 | 2 000 |
| Byggekø | Standard | Prioritert | Prioritert |
| Statiske sider | Ubegrenset | Ubegrenset | Ubegrenset |

Grensene står **kun ett sted i koden**: `PLAN_LIMITS` i
`backend/src/services/plans.ts`. Både håndhevingen, ressurstaket på containeren
og planvisningen i dashboardet leser derfra. Legges en grense inn et annet sted,
er det bare et spørsmål om tid før prissiden og virkeligheten sier ulike ting.

**Prisene står et annet sted**: `PLAN_PRICES` i `backend/src/services/markets.ts`.
Skillet er poenget – grensene er like i alle markeder, prisene er det ikke.

### Den fjerde planen: `agency`

Det finnes en tier til, som ikke står i tabellen over fordi den ikke kan kjøpes.
`agency` (migrasjon 0010) er for integrasjonspartnere som drifter mange
kundesider under **én** konto hos oss – i dag LeadLab, gjennom nettsidebyggeren
«Snekkeren». Den settes for hånd med `source = 'invoice'`, slik at en senere
Stripe-webhook ikke skriver over den.

Grensene: 50 kjørende apper, 20 000 byggeminutter/md, 1 GB / 1 vCPU per app.
Tallene er høye, men **ikke** `Infinity`, og det er et bevisst valg: et tak som
aldri kan nås er et tak vi aldri får se virke. En integrasjon i en løkke har ingen
menneskelig hånd som stopper den, og den skal treffe *noe* før den tar ned verten
for alle de andre. `maxRunningProjects` er nesten teoretisk – kundesidene er
statiske og teller ikke mot taket – så den bremser bare hvis en partner begynner
å deploye apper som faktisk kjører.

Planen holdes utenfor `planCatalogue()` via `UNLISTED_PLANS` i `markets.ts`. Uten
det filteret ville den dukket opp på landingssiden med prisen 0 kr, altså som en
gratis Business-plan. `SubscriptionTier` i **frontend** har fortsatt bare tre
verdier, og det er tilsiktet: dashboardet skal aldri motta `agency` i
plankatalogen, og byråkontoen logger seg ikke inn der.

Modelleringen er poenget: hadde dette vært et «hvis dette er LeadLab»-unntak,
måtte hvert enkelt sperrepunkt husket på det. Som en ordinær tier går
`entitlementFor()` og `assertCanDeploy()` sin vante vei.

**Statiske sider er ubegrenset med vilje.** Et prosjekt med `static_output_dir`
kjører ingen container (`03_deployment_flow.md`) og koster noen megabyte på disk.
Kostnaden ligger i kjørende prosesser, ikke i filer.

**Båndbredde er ikke en grense.** Vi samler nå inn Caddy sine access-logger for å vise båndbredde og statistikk i panelet (gjennom den nye `AnalyticsTab`-komponenten), men vi håndhever ingen hard GB-grense. En grense vi måler men ikke håndhever betyr at prissiden fortsatt sier «rimelig bruk». Skal vi blokkere trafikk ved overforbruk, må det bygges en enforcement-mekanisme oppå analytics-dataene.

## ⚠️ Marked, språk og valuta er tre forskjellige ting

Dette er den andre tingen det er verdt å forstå i denne filen.

`services/markets.ts` definerer to markeder: **`no`** (Norge, NOK) og **`eu`**
(alt annet, EUR). To og ikke tjue, fordi Stripe Tax uansett regner riktig avgift
per kundeland – det eneste vi må bestemme selv er valutaen og prispunktet, og
der er det to svar.

| | Språk | Marked | Formatering |
| --- | --- | --- | --- |
| Hva det er | En preferanse | En faktureringsfakta | En konsekvens av språket |
| Hvor det bor | i18next, `no`/`en` | `subscriptions.currency` + `markets.ts` | `lib/format.ts` |
| Kan endres | Når som helst | **Aldri etter første kjøp** | Følger språket |

Før dette lå alle tre i én verdi. `VAT_RATE = 0.25` og `PLAN_PRICES_ORE` sto i
`plans.ts`, altså i den eneste definisjonen av hva en plan *er*; prisene sto
dessuten som ferdige strenger i oversettelsesfilene («199 kr / mnd»), og
`Intl.NumberFormat("nb-NO", { currency: "NOK" })` var hardkodet i komponentene.
Den engelske prissiden lovet «€19 / month» mens Stripe trakk 199 kroner.

### Regelen: norsk visning gir kroner, alt annet gir euro

Utledes av visningsspråket i `marketForLanguage()` (samme funksjon finnes i
`frontend/src/lib/market.ts` og i backend). Det er en produktbeslutning, ikke en
teknisk nødvendighet: en engelsktalende i Oslo får euro-prisen og faktureres
like fullt norsk mva, fordi Stripe Tax går på **adressen i kassen**, ikke på
valutaen.

`resolveMarket()` avgjør, i streng rekkefølge:

1. **`subscriptions.currency`** – låst, kan ikke overstyres.
2. **`?market=`** fra frontend, utledet av visningsspråket.
3. **`Accept-Language`** – for kall uten parameter.
4. **`SNOAT_DEFAULT_MARKET`** (standard `no`).

⚠️ **Ingen GeoIP.** `lib/geoip.ts` finnes og brukes av trafikkanalysen, så
fristelsen er nær – men geografi ville motsagt regelen over: en nordmann som
velger engelsk skal ha euro-prisen, og et IP-oppslag ville dratt hen tilbake til
kroner. Det ville dessuten krevd at vi stolte på `X-Forwarded-For` fra klienten,
som er nøyaktig den angrepsflaten `02_architecture.md` beskriver at vi fjernet.

### ⚠️ Valutaen låses ved første faktura

**Stripe knytter valutaen til kunden, ikke til abonnementet.** En kunde som har
betalt i NOK kan ikke bytte til EUR – det ville krevd en ny Stripe-kunde. Derfor
overstyrer `subscriptions.currency` både visningsspråk og alt annet: viser vi
euro-prisen til en kunde som faktureres i kroner, står det ett beløp på skjermen
og et annet på fakturaen. `BillingState.marketLocked` er sann i det tilfellet, og
betalingssiden sier fra i stedet for å late som om kunden kan velge.

Av samme grunn nuller **ikke** `downgradeToFree()` ut `currency`. Sier kunden opp
og tegner nytt senere, gjelder den gamle valutaen fortsatt hos Stripe.

### Mva vises bare når vi vet satsen

`Market.displayVatRate` er `0.25` for Norge og **`null`** for euro-markedet.
Null betyr «vi kan ikke oppgi en pris inkl. mva», ikke «ingen mva»: satsen
avhenger av kundeland, og forsvinner helt ved omvendt avgiftsplikt til en
EU-bedrift. Da viser vi eks. mva og sier at avgiften beregnes i kassen. Å gjette
25 % for en tysk kunde ville vært å oppgi feil pris – og det er
prisopplysningsforskriften som krever begge deler.

## ⚠️ Hvorfor `subscriptions` er en egen tabell

Dette er det viktigste å forstå i hele filen.

`profiles` har policyen `profiles_update_own`, og **RLS i Postgres er rad-nivå,
ikke kolonne-nivå**. Lå `plan` som en kolonne på `profiles`, kunne enhver
innlogget bruker åpnet konsollen i dashboardet og kjørt:

```js
await getSupabase().from("profiles").update({ plan: "business" }).eq("id", user.id)
```

Det ville gått rett gjennom – raden er jo deres egen – og hele betalingsmuren
ville vært omgått med én linje.

`public.subscriptions` (migrasjon `0004_billing.sql`) har derfor **kun en
select-policy**. Det finnes ingen insert-, update- eller delete-policy i det hele
tatt, så `authenticated` kan lese sin egen rad og ingenting mer. All skriving går
gjennom backend med service-role-nøkkelen, etter en verifisert Stripe-signatur.
Samme resonnement som `github_installations` i `04_database_schema.md`.

Kolonner verdt å kjenne:

- `plan` / `status` – planen kunden betaler for, og tilstanden hos Stripe.
- `source` – `stripe` (kort og webhooks) eller `invoice` (EHF, satt for hånd).
  Uten dette skillet ville en manuelt satt bedriftsplan sett ut som en Stripe-rad
  med manglende data, og neste webhook kunne nullstilt den.
- `current_period_end` – slutten på perioden det er betalt for.
- `delinquent_since` – når betalingen først feilet. Det er **denne**, ikke
  `updated_at`, som avgjør når nådefristen er ute; `updated_at` flyttes av enhver
  webhook.
- `cancel_at_period_end` – kunden har sagt opp, men perioden løper. Dashboardet
  skal si «aktiv til <dato>», ikke «kansellert».
- `currency` (0009) – valutaen abonnementet faktureres i. **Låst** – se over.
- `billing_country` (0009) – ISO-3166-1 alpha-2 fra adressen i Stripe. Dette er
  avgiftsgrunnlaget, og det eneste vi har som sier hvor kunden holder til. Ikke
  utledet av språk eller valuta.
- `customer_kind` (0009) – `individual` eller `business`, avledet av om kunden
  oppga mva-nummer i kassen. Avgjør omvendt avgiftsplikt i EU.

De tre nye kolonnene har ingen egen policy, og det er ikke en forglemmelse:
tabellen har kun en select-policy fra 0004, og kolonnene arver den. Det er like
viktig her som for `plan` – kunne en bruker satt `currency` selv fra
nettleserkonsollen, kunne hen valgt hvilken prisliste kontoen skulle måles mot,
og siden en lagret valuta overstyrer alt annet, ville løgnen overlevd helt fram
til kassen.

Alle brukere har en rad: triggeren `on_profile_created` oppretter en `free`-rad
sammen med profilen, og migrasjonen etterfyller for eksisterende brukere. En rad
som alltid finnes er en sikrere standardtilstand enn «ingen rad», som en
framtidig endring lett kunne tolket som «ingen grenser».

## Hvor grensene håndheves

**I `startDeployment()`, ikke ved opprettelse av prosjekt.** To grunner:

1. **Frontend oppretter prosjekter direkte i Supabase med RLS**
   (`dashboard.tsx`), uten å røre backend i det hele tatt. En sjekk i API-laget
   ville ikke vært en sjekk.
2. Et prosjekt uten deployment koster ingenting. Det er containeren som spiser
   minne, og det er den vi tar betalt for.

`startDeployment` er dessuten den eneste veien inn til pipelinen – både det
manuelle endepunktet og GitHub-webhooken går gjennom den. En sjekk i
`routes/api.ts` ville sluppet auto-deploy ved push rett forbi, og det er nettopp
den som kan starte bygg i det uendelige uten at noen ser på.

Selve sperren er `assertCanDeploy()` i `services/plans.ts`:

- **Byggeminutter** – summen av `deployments.duration_ms` for kalendermåneden.
  Feilede bygg teller med; de brukte de samme minuttene på verten.
- **Antall apper** – prosjekter med en kjørende container, talt i Docker og ikke
  i databasen, fordi Docker har fasit. Statiske prosjekter er unntatt.
  **Et prosjekt som allerede kjører, slipper alltid gjennom** – uten det ville en
  Free-bruker med én app blitt låst ute fra sin egen neste versjon.

Feilen kaster `DeployError` med steg `plan`, som `routes/api.ts` oversetter til
**402 Payment Required** i stedet for 409. Koden er meningsbærende: 409 sier
«prøv igjen senere», 402 sier «dette koster penger», og dashboardet skiller på
den for å vise oppgraderingsknappen.

### ⚠️ Backend skriver ikke kundetekst

`DeployError` bærer i tillegg en `detail: { code, params }`. Meldingen er norsk
og går i **loggen**; det er koden dashboardet oversetter, mot `errors`-seksjonen
i `locales/<språk>/translation.json`.

Grunnen er ikke ryddighet, men at backend **ikke kjenner visningsspråket** til
den som utløste bygget. En auto-deploy fra en GitHub-push har ingen bruker i den
andre enden i det hele tatt. Skrev vi ferdig setning her, ville dashboardet vært
låst til norsk uansett hvor mange oversettelser frontend hadde.

Kodene bæres ut via `HTTPException`-ens `cause`, som `app.onError` i `index.ts`
legger i JSON-svaret som `{ error, code, params }`. Frontend slår dem opp med
`translateApiError()` i `lib/errors.ts`, som **faller tilbake på den norske
meldingen** når koden mangler. Det er med vilje: bare feil som er ment for kunden
har kode. En byggefeil fra Nixpacks er diagnostikk blandet med verktøy-output, og
en halvoversatt versjon av den er verre enn originalen.

Kodene som finnes nå: `plan.build_minutes_exhausted`, `plan.apps_limit_reached`,
`plan.apps_limit_reached_downgraded`, `deploy.already_building`,
`deploy.building_now`, `auth.signed_out`.

### Ressurstak per plan

`runContainer()` tar nå imot en `ContainerResources` i stedet for å lese
`config.SNOAT_APP_MEMORY_MB` selv. `SNOAT_APP_MEMORY_MB` og `SNOAT_APP_CPUS`
brukes ikke lenger av containeroppstarten – de står igjen i config som
dokumentasjon på hva verten tåler.

⚠️ `NODE_OPTIONS=--max-old-space-size` og `HostConfig.Memory` **må regnes fra
samme tall**. Tror V8 den har mer heap enn Docker tillater, rydder den for lat og
containeren blir OOM-drept. Kommer de to fra hver sin kilde, er det feilen som
kommer tilbake – og da bare for kunder på én bestemt plan.

### Prioritert byggekø

`waiting`-køen i `services/deploy.ts` er ikke lenger ren FIFO. `enqueue()` setter
bygget inn foran den første oppføringen med lavere `queuePriority`, altså bakerst
blant sine likemenn. Sammenligningen må være **streng ulikhet**: med `<=` ville
et nytt bygg gått foran likemennene sine, og køen blitt LIFO innenfor hver plan.

Med `SNOAT_MAX_CONCURRENT_BUILDS = 1` er dette en reell forskjell. Free-brukere
kan vente merkbart lenge bak betalte bygg – det er et produktvalg, ikke bare en
kodeendring.

## Stripe-oppsettet

### Kontoen

Alt under ligger i **live-modus** i `acct_1U1oJ0Kk43sISMuX` (Frostbyte Group AS).
Testmodus er tomt – oppretter du ikke de samme objektene der, må lokal testing
kjøre mot live-nøkler, og det er ikke greit. Live price-ID sammen med en
`sk_test_`-nøkkel gir «No such price».

### Opprettet (ligger inne)

| Objekt | ID | Merknad |
| --- | --- | --- |
| Produkt Pro | `prod_V1tVR6EBkm03vs` | `snoat_plan=pro`, tax code `txcd_10102001` (PaaS, personal use) |
| Produkt Business | `prod_V1tVnYlGEwvU9W` | `snoat_plan=business`, tax code `txcd_10102000` (PaaS, business use) |
| Pris Pro | `price_1U1piiKk43sISMuXkPn25uvF` | 199 kr/mnd, NOK, `tax_behavior=exclusive` |
| Pris Business | `price_1U1pijKk43sISMuXPVCR6vgt` | 799 kr/mnd, NOK, `tax_behavior=exclusive` |
| Webhook | `we_1U1piuKk43sISMuXwYvnLx8a` | `https://api.snoat.com/api/webhooks/stripe`, 8 eventer |
| Tax-standarder | – | `tax_code=txcd_10102000`, `tax_behavior=exclusive` |

### Multi-valuta på price-ene — ✅ lagt inn

**Én price-ID per plan, ikke én per valuta.** `currency_options` ligger på samme
price. Et eget sett env-variabler per marked ville doblet konfigurasjonen for
hver valuta, og gjort det mulig å peke NOK- og EUR-prisen på hvert sitt produkt –
og da ville `planForSubscription()` sett to ulike planer.

Begge price-ene har nå begge valutaene, i live-modus:

| Price | NOK | EUR |
| --- | --- | --- |
| `price_1U1piiKk43sISMuXkPn25uvF` (Pro) | 19900 | 1900 |
| `price_1U1pijKk43sISMuXPVCR6vgt` (Business) | 79900 | 7900 |

Alle fire med `tax_behavior=exclusive`. Skal en valuta legges til senere:

```bash
stripe prices update <price_id> \
  -d "currency_options[eur][unit_amount]=1900" \
  -d "currency_options[eur][tax_behavior]=exclusive"
```

⚠️ Update **erstatter ikke** de andre valutaene – basisvalutaen følger av
price-ens egen `currency`/`unit_amount` og kan ikke fjernes denne veien. Men
`tax_behavior` per valuta er **immutabel** når den først er satt, så en feil der
krever en ny price.

⚠️ **`PLAN_PRICES` må holdes i takt med disse beløpene.** Tabellen i koden er
det kunden ser før hen klikker; Stripe er det som faktisk trekkes. Spriker de
to, oppdager vi det først når noen klager på beløpet. Merk også at EUR-prisene er
**egne prispunkter**, ikke en kurskonvertering: 199 kr er ikke 17,32 €, det er
19 €. Et produkt med publiserte priser skal ha runde tall i hver valuta, og
kursen skal ikke flytte prislappen fra uke til uke.

**Ikke bruk Adaptive Pricing** til dette. Den gjør automatisk FX med påslag og
gir skjeve tall som ikke kan settes selv.

Metadataen **`snoat_plan`** på *produktet* er viktigere enn den ser ut:
`STRIPE_PRICE_PRO` peker på prisen vi selger *nå*. Justerer du prisen, lager
Stripe en ny price-ID, mens eksisterende abonnenter blir liggende på den gamle.
Uten metadata ville alle de kundene sett ut som om de hadde en ukjent plan ved
neste webhook, og blitt nedgradert til Free. `planForSubscription()` leser
metadata først og faller tilbake på price-ID-sammenligning.

Webhooken abonnerer på nøyaktig de åtte eventene `routes/stripe.ts` har en
`case` for: `checkout.session.completed`, `customer.subscription.{created,
updated,deleted,paused,resumed}`, `invoice.payment_succeeded` og
`invoice.payment_failed`. Legger du til en `case`, må endepunktet oppdateres –
ellers venter koden på et event som aldri sendes.

### Gjenstår, og må gjøres i dashbordet

Disse tre kan **ikke** opprettes over API-et – Stripe eksponerer dem bare i
dashbordet:

1. **Mva-registreringer** (Tax → Registrations). Stripe Tax er aktivert og
   hovedkontoret står i Oslo, men uten registreringene beregner Stripe **0 %
   uten å feile**. Prisene er eks. mva, så inntil dette er på plass selges Pro
   til 199 kr uten at avgiften kreves inn i det hele tatt. Dette er det eneste
   punktet som stille gir feil beløp – resten feiler synlig.

   - **Norge** – ✅ aktiv (`taxreg_1U1q1iKk43sISMuXKzaXIYyc`, standard). Gjelder
     også kunder med norsk adresse som betaler i euro – Stripe Tax går på
     adressen, ikke på valutaen.
   - **EU** – salg av digitale tjenester til EU-**forbrukere** krever VAT OSS
     (ikke-unionsordningen), siden Frostbyte Group AS er utenfor EU. Registrer i
     ett medlemsland, så håndterer Stripe destinasjonslandets sats.
     ⚠️ **Rask vei inn: lanser EU som B2B-only først.** Til EU-*bedrifter*
     gjelder omvendt avgiftsplikt – ingen mva, ingen OSS-registrering fra vår
     side – og `tax_id_collection` er allerede skrudd på i checkout. Da kan
     euro-markedet åpnes uten å vente på OSS.
2. **Kundeportalen** (Settings → Billing → Customer portal). Det finnes ingen
   portalkonfigurasjon ennå, så `/api/billing/portal` svarer 502. Skru på
   fakturahistorikk, bytte av betalingsmåte, oppsigelse og planbytte mellom de
   to prisene over – det er portalen som er oppgraderings- og nedgraderingsflyten
   vår; vi bygger den ikke selv.
3. **Betalingsmåter** (Settings → Payment methods). Kort er på som standard.
   Vipps er bevisst utelatt (se «Ikke implementert»), SEPA Direct Debit er verdt
   å vurdere nå som euro-markedet finnes.

4. ~~**Multi-valuta på price-ene**~~ – ✅ gjort, se tabellen over.

### Lokalt

```bash
stripe listen --forward-to http://api.snoat.localhost/api/webhooks/stripe
```

`whsec_`-verdien den skriver ut er `STRIPE_WEBHOOK_SECRET` lokalt. Den er en
**annen** verdi enn den i dashboardet – en forveksling der gir 401 på alt.

## Webhooken: fire feller

`backend/src/routes/stripe.ts`. Alle fire er ting som feiler stille.

**1. Rekkefølgen på monteringen.** Ruten ligger under `/api`, men skal utenfor
`requireAuth`. Den monteres derfor **før** `app.route("/api", api)` i `index.ts`,
akkurat som GitHub-webhooken (`02_architecture.md`). Flyttes linjen ned, begynner
Stripe å få 401 – og symptomet er ikke en feilmelding hos oss, men kunder som
betaler uten å få planen sin.

**2. Råkroppen.** Signaturen er regnet over nøyaktig de bytene Stripe sendte. Vi
leser `await c.req.text()` og gir strengen videre urørt. En tur innom `JSON.parse`
og tilbake endrer nøkkelrekkefølge og mellomrom, og da stemmer ikke signaturen.
Vi bruker `constructEventAsync`, ikke den synkrone varianten.

**3. Idempotens som ikke låser seg fast.** Stripe leverer «at least once».
`claimEvent()` setter inn event-id-en i `stripe_events`; innsettingen *er* låsen.
Men feiler behandlingen etterpå, må låsen **frigis** (`releaseEvent()`) før vi
svarer 500 – ellers ville Stripes retry sett eventet som allerede behandlet og
hoppet over det, og 500-svaret vårt hadde vært en garanti for at det aldri ble
behandlet.

**4. Feltene har flyttet seg i nyere API-versjoner.** To steder, begge gir
`undefined` framfor en feil:

- `current_period_end` ligger på **abonnements-linjen**
  (`subscription.items.data[0].current_period_end`), ikke på abonnementet.
- Fakturaens abonnement ligger under **`invoice.parent.subscription_details.subscription`**,
  ikke `invoice.subscription`.

Leser man de gamle plasseringene, blir `current_period_end` stille NULL og hver
feilede betaling stille ignorert.

**5. Adressen ligger på kunden, ikke på abonnementet.** `syncById()` ekspanderer
derfor `customer` og `customer.tax_ids` i tillegg til produktet. Uten den
ekspanderingen blir `billing_country` og `customer_kind` stille stående som
NULL – ingen feil, ingen advarsel, bare et dashboard som ikke vet hvilket land
kunden hører til. Samme kategori som de fire over.

Merk at `syncSubscription()` **bare skriver de tre markedsfeltene når den
faktisk vet noe** (`...(country ? { billing_country: country } : {})`). Det er
det eneste unntaket fra «hele tilstanden skrives hver gang»: et manglende
ekspanderingsfelt skal ikke nulle ut et land vi allerede har lagret.

### Hvorfor hele tilstanden skrives hver gang

Stripe garanterer ikke rekkefølgen på leveringene. Kom `subscription.updated` fram
før `checkout.session.completed`, ville en inkrementell oppdatering latt den eldre
meldingen skrive over den nyere tilstanden. `syncSubscription()` henter derfor alt
fra subscription-objektet og skriver hele raden, slik at den konvergerer mot
sannheten uansett rekkefølge. Faktura-eventene slår opp abonnementet på nytt i
stedet for å gjette status ut fra fakturaen – `payment_failed` betyr ikke
nødvendigvis `past_due`, det kan være første av flere forsøk.

## Nådefrist og suspensjon

Et utløpt kort skal ikke ta ned produksjonen til noen mens Stripe fortsatt prøver
på nytt. Flyten er derfor myk:

1. Betalingen feiler → status `past_due`, `delinquent_since` settes.
2. I `SNOAT_BILLING_GRACE_DAYS` dager (standard 14, som dekker Stripes Smart
   Retries) **beholder kunden alt**. Dashboardet viser en rød boks med datoen.
3. Er fristen ute, faller grensene til Free. Abonnementet er ikke borte – går
   betalingen gjennom, er alt tilbake av seg selv. `entitlementFrom()` er det
   eneste stedet dette avgjøres.
4. Bakgrunnssveipet `services/suspension.ts` stopper apper som ligger *over*
   Free-grensen. De eldste beholdes; det er de nyeste som tas ned.

⚠️ **`SNOAT_BILLING_SUSPEND_ENABLED` er `false` som standard.** Sveipet kjører
likevel hver time og logger «Ville suspendert …», slik at effekten kan verifiseres
i loggen før den blir ekte. Dette er den eneste mekanismen i plattformen som tar
ned kjørende kundeapper uten at et menneske trykker på noe – slå den på først når
dunning-flyten er observert i produksjon.

Prosjektet slettes aldri. `teardownProject()` fjerner ruten og containerne; raden,
historikken og miljøvariablene står urørt.

## Byggeminutter

`deployments.duration_ms` (0004) skrives i **både** suksess- og feilgrenen av
pipelinen. Varigheten ble allerede regnet ut for loggmeldingen «Ferdig på 12.3s» –
nå lagres den også. Rader fra før migrasjonen har NULL og teller som null.

## API

Alt under `/api/billing` krever innlogging (`06_backend_api.md`).

| Endepunkt | Gjør |
| --- | --- |
| `GET /api/pricing?market=` | **Offentlig.** Plankatalogen for landingssiden. Utenfor `requireAuth`. |
| `GET /api/billing?market=` | Plan, status, grenser, forbruk og plankatalog. Alt siden trenger. |
| `POST /api/billing/checkout` | Oppretter en Checkout-sesjon. Body: `{ "plan": "pro" \| "business", "market": "no" \| "eu", "projectId"? }`. Svarer `{ url }`. |
| `POST /api/billing/portal` | Lenke til Stripes kundeportal. Svarer `{ url }`. |
| `POST /api/webhooks/stripe` | **Offentlig, signaturverifisert.** Utenfor `requireAuth`. |

⚠️ `/api/pricing` må monteres **før** `app.route("/api", api)` i `index.ts`, av
samme grunn som webhookene: `api` legger `requireAuth` på alt under seg. Flyttes
linjen ned, begynner landingssiden å få 401 og prisseksjonen blir stående tom.

`market`-parameteren er et **ønske**, ikke en beslutning. Har kunden et
abonnement, er valutaen låst, og svaret kan derfor komme tilbake i et annet
marked enn det som ble spurt om – da er `marketLocked` sann.

Planen settes **aldri** av redirecten tilbake fra Stripe, kun av webhooken. Ville
vi satt den i `success_url`-håndteringen, ville en kunde som lukket fanen i kassen
fått Pro gratis. Derfor kan siden vise «free» et par sekunder etter et vellykket
kjøp, og teksten på siden lover ikke noe annet.

## Frontend

Oppgraderinger og abonnement for et bestemt prosjekt håndteres nå direkte i prosjektinnstillingene (`frontend/src/routes/projects.$projectId.tsx`), primært via komponenten `ProjectPlanCard`. Den fungerer som en accordion-meny og henter sine egne priser.
Følger stilguiden i `05_design_system.md`: ingen borders, `floating-card`, målere på `bg-surface-container`.

Målerne blir røde først når grensen er **nådd**, ikke når den nærmer seg – en
måler som står rød på 80 % lærer brukeren å ignorere rødt.

Prisene vises både eks. og inkl. mva **når satsen er kjent**. Det er ikke pynt:
mange av kundene våre er soloutviklere, altså forbrukere, og pris mot forbruker
skal oppgis inkl. mva. I euro-markedet er `priceIncludingVat` null, og da sier
siden at avgiften beregnes i kassen – samme forskrift, motsatt konklusjon.

### Tre moduler som holder språk og marked fra hverandre

| Fil | Ansvar |
| --- | --- |
| `lib/market.ts` | Utleder ønsket marked av visningsspråket. Speiler backend. |
| `lib/format.ts` | `useFormatters()` – tall, dato og penger etter *språket*, valuta fra *data*. |
| `lib/errors.ts` | `translateApiError()` – slår opp `code` fra backend i `errors`-seksjonen. |

`useFormatters()` er der `Intl`-objektene bor nå. Valutaen sendes inn per kall og
kommer aldri fra språket: en kunde med kroneabonnement skal se kroner selv om hen
leser engelsk. Lokalet styrer *hvordan* tallet skrives, `currency` styrer *hva*.
`en` formateres som **`en-IE`** og ikke `en-US` – en kunde i Berlin skal ha
«7 August 2026» og «1 234,56», ikke amerikanske konvensjoner.

### ⚠️ Ingen `LanguageDetector` i `lib/i18n.ts`

`i18next-browser-languagedetector` var tidligere *importert*, men aldri sendt inn
i `.use()`. Den så ut til å virke uten å gjøre noe som helst. Importen er nå
fjernet, og deteksjonen ligger fortsatt i `routes/__root.tsx`, som kjører den
**etter mount** med vilje: leses `navigator.language` under serverrenderingen,
får server og klient ulikt språk og React kaster hydration-feil på hver tekst.

`lng: "en"` er derfor ikke standardspråket vårt, men *det språket serveren
rendrer med*. Det må stemme med `fallbackLng`.

⚠️ Konsekvensen er at den norske landingssiden fortsatt rendres på engelsk og
byttes i nettleseren. Det er en SEO-svakhet, ikke en feil – løsningen er
sti-prefiksede ruter (`/no/…`, `/en/…`) med `hreflang`, se «Ikke implementert».

### Prisene kommer fra API-et, ikke fra oversettelsene

Landingssiden (`routes/index.tsx`), betalingssiden og planboksene på
prosjektsiden henter alle katalogen fra samme sted. Ingen av dem har et
kronebeløp i JSX-en eller i `translation.json`. Feiler kallet, står prisseksjonen
tom framfor å vise et tall vi ikke vet om stemmer – et gammelt tall på en
prisside er verre enn ingen tall.

## Ikke implementert


- **Egne domener som betalt funksjon.** Ruting og lagring for kundedomener finnes
  ikke ennå (`11_custom_domains_and_dns.md`) – `upsertAppRoute` registrerer
  nøyaktig ett vertsnavn, og `tls-ask` innvilger kun `<slug><SNOAT_APP_DOMAIN_SUFFIX>`.
  **Det er altså ingenting å sperre.** Selg ikke Pro på dette punktet før
  funksjonen finnes.
- **Team og organisasjoner.** Hele skjemaet er `user_id`-scopet og all RLS er
  eier-scopet. Business-planen gir i dag høyere grenser, ikke delt tilgang. Å
  legge til team er en migrering av hele skjemaet, ikke en Business-funksjon.
- **EHF-faktura automatisk.** `source = 'invoice'` finnes i datamodellen, så en
  bedriftsplan kan settes for hånd og overlever webhooks. Selve utsendelsen over
  Peppol (Fiken/Tripletex eller tilsvarende) er ikke bygget.
- **Vipps.** Bevisst utelatt.
- **VAT OSS for EU-forbrukere.** Koden er klar, registreringen er ikke gjort.
  Inntil den er på plass bør euro-markedet selges B2B – se «Gjenstår».
- **Sti-prefiksede ruter per språk** (`/no/…`, `/en/…`) med `hreflang`.
  Landingssiden rendres på engelsk og byttes i nettleseren, så den norske
  versjonen indekseres dårlig. Det er dette som faktisk låser opp organisk
  trafikk i nye markeder.
- **Egen markedsføringstekst per marked.** Alt utenom priser deles i dag mellom
  markedene. «100 % norsk data» oversettes godt – Norge er EØS med GDPR
  implementert, så data i Norge er ikke tredjelandsoverføring for en EU-kunde,
  og påstanden blir «EØS-hostet, ingen US CLOUD Act» – men det er en annen tekst,
  ikke en oversettelse av den norske.
- **Namespace-splitting av oversettelsene.** `translation.json` er fortsatt én
  fil per språk med 15 toppnøkler. `errors` ligger der som en seksjon, ikke som
  et eget i18next-namespace. Å splitte er ren mekanisk endring av hvert `t()`-kall
  uten funksjonell gevinst i dag; det blir aktuelt når markedsføringsteksten skal
  variere per marked og lastes lat.
- **Hardkodet norsk i `AnalyticsTab`.** Etikettene der («Robottrafikk»,
  «Trafikkilder», tidsfiltrene) står i JSX-en og er ikke oversatt i det hele tatt.
  Tallformateringen følger nå språket, teksten gjør det ikke.
