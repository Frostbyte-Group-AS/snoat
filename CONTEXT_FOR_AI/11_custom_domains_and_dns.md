# Egne domener og DNS-fanen

Hvert prosjekt får automatisk `<slug><SNOAT_APP_DOMAIN_SUFFIX>` – altså
`min-app.snoat.com` i produksjon og `min-app.snoat.localhost` lokalt. Denne filen
handler om steget videre: at kunden peker sitt **eget** domene mot Snoat.

| Del | Status |
| --- | --- |
| Veiledningen i dashboardet (hvilke records kunden må sette) | **Implementert** |
| Lagring (`projects.custom_domain`, migrasjon `0006`) | **Implementert** |
| Ruting i Caddy, inkludert `*.<domenet>` | **Implementert** |
| Sertifikat via on-demand TLS med `ask`-endepunkt | **Implementert** |
| Statusvisning i DNS-fanen (DNS / rute / sertifikat) | **Implementert** |

### Fellen: to kilder til sannhet

TLS-tillatelsen (`routes/tls.ts`) leser **databasen**, mens rutingen leser
**Caddys minne**. Caddy kjører med `persist: false`, så en Caddy-restart uten en
påfølgende reconcile tømmer rutene mens databasen fortsatt sier at domenet er
koblet opp. Da svarer `tls-ask` ja, kunden får et gyldig sertifikat – og
forespørselen faller likevel gjennom til catch-all-en med «ingen applikasjon er
rutet til dette domenet». Symptomet ser ut som et sertifikatproblem, men er et
ruteproblem.

`ensureProjectRoute()` i `services/deploy.ts` er det ene stedet som skriver en
rute for et prosjekt. Den **oppretter** ruten hvis den mangler – tidligere ble
den bare endret når den allerede fantes, slik at et domene kunne lagres uten at
noe pekte dit. Både `reconcileRoutes()` og `PATCH /projects/:id/domain` går
gjennom den, og domene-endepunktet svarer 502 hvis skrivingen feiler i stedet for
å påstå at alt gikk bra.

`GET /projects/:id/domain/status` måler de tre leddene hver for seg og er det
DNS-fanen viser. Sertifikatsjekken er en TLS-handshake mot Caddy med domenet som
SNI, og den kjøres **kun** når DNS og rute allerede stemmer: handshaken utløser
on-demand-utstedelse, og et forsøk uten fungerende DNS teller mot Let's Encrypts
grense på fem mislykkede valideringer per vertsnavn per time.

Et eget domene dekker også subdomenene sine (`*.dittdomene.no`), slik at en
flerleietaker-app kan gi hver kunde sitt eget vertsnavn uten å registrere dem én
for én. `parentDomain()` i `lib/caddy.ts` er oppslaget som gjør det.

## DNS-fanen i prosjektvisningen

`frontend/src/components/DnsSettingsTab.tsx`, montert som fanen `dns` i
`frontend/src/routes/projects.$projectId.tsx`. Fanen er delt i fire steg med
heksagon-markører:

1. **Statusboks** – prosjektets nåværende Snoat-adresse, en Live-indikator basert
   på siste deployment, og hjelpeteksten om at Caddy utsteder SSL automatisk.
2. **Velg domenet ditt** – kunden skriver inn domenet sitt. En veksler mellom
   *Rotdomene* og *Subdomene* avgjør hvilke records som vises.
3. **Records** – ett kort per record, hver med tre kopiknapper.
4. **Leverandørveiledning + verifisering** – steg for steg hos de vanligste
   norske registrarene, og `dig`-kommandoer for å sjekke resultatet.

Inndata normaliseres før den vises: `https://www.Mitt-Domene.no/` blir
`mitt-domene.no`. Det sparer oss for de vanligste feilene (limt inn URL i stedet
for domene, `www.` foran, avsluttende skråstrek).

## Recordene kunden skal sette

**Rotdomene** (`dittdomene.no` + `www`):

| Type | Host | Verdi | Merknad |
| --- | --- | --- | --- |
| `A` | `@` | `SNOAT_SERVER_IP` | Obligatorisk. |
| `CNAME` | `www` | `<slug><SNOAT_APP_DOMAIN_SUFFIX>` | Anbefalt. |

**Subdomene** (`app.dittdomene.no`):

| Type | Host | Verdi | Merknad |
| --- | --- | --- | --- |
| `CNAME` | `app` | `<slug><SNOAT_APP_DOMAIN_SUFFIX>` | Obligatorisk. |

Rotdomenet må være en A-record fordi DNS ikke tillater CNAME på sonens apex –
en apex-CNAME kolliderer med SOA- og NS-recordene som må ligge der. Subdomener
har ikke det problemet, og der er CNAME å foretrekke: peker vi på vertsnavnet
i stedet for IP-en, overlever kunden en framtidig IP-endring uten å røre sonen
sin.

Fanen sier også fra om at gamle `A`/`AAAA`/`CNAME` på samme host må fjernes
først – én host kan ikke ha både en A-record og en CNAME – og at TTL kan stå på
`3600` eller «Auto».

## `SNOAT_SERVER_IP`

IP-en fanen viser fram i A-recorden. Den utledes **ikke** av domenet, siden
serveren kan bytte IP uten at domenet endres:

- `.env`: `SNOAT_SERVER_IP` (skrives av `scripts/bootstrap-env.mjs`, som beholder
  en eksisterende verdi og bare faller tilbake til `127.0.0.1` lokalt /
  `38.87.117.167` i produksjon).
- Frontend: `VITE_SNOAT_SERVER_IP`, bakt inn i bundlen ved build via `build.args`
  i `docker-compose.yml` og `ARG`/`ENV` i `frontend/Dockerfile`.
- Leses i koden av `frontend/src/lib/platform.ts`.

Bytter serveren IP må frontend bygges på nytt – se `09_production_deployment.md`.

## Cloudflare må stå på «DNS only»

Fanen advarer eksplisitt mot den oransje skyen. Det er to grunner, og begge er
prinsipielle for oss:

1. **Sertifikatet.** Med Cloudflare-proxy foran terminerer Cloudflare TLS, og
   Caddys ACME-utfordring når ikke fram til opprinnelsesserveren.
2. **Datasuverenitet.** Proxyet trafikken gjennom Cloudflare, går den innom
   utenlandsk infrastruktur – stikk i strid med hele premisset for Snoat
   (`01_vision_and_brand.md`).

## Slik verifiserer kunden

```bash
dig +short dittdomene.no            # skal svare med SNOAT_SERVER_IP
dig +short www.dittdomene.no CNAME  # skal svare med <slug>.snoat.com.
```

## Det som gjenstår

1. **Flere domener per prosjekt.** `custom_domain` er én kolonne, så et prosjekt
   kan eie nøyaktig ett eget domene. Skal kunden ha både `dittdomene.no` og
   `dittdomene.com`, må dette bli en `project_domains`-tabell.
2. **Ekte wildcard-sertifikat.** On-demand utsteder ett sertifikat per vertsnavn.
   Let's Encrypt teller 50 per registrert domene per uke, så en app som får mange
   nye subdomener raskt vil treffe taket. Løsningen er DNS-01-utfordring med et
   ekte `*.dittdomene.no`-sertifikat, men det krever API-tilgang til kundens
   DNS-sone.
3. **Rydding av sertifikater.** Fjernes et domene fra et prosjekt, blir
   sertifikatet liggende i Caddys lager til det utløper.
