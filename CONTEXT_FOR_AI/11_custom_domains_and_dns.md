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
| `A` | `@` | IP-en `edge.snoat.com` svarer med | Obligatorisk, med mindre leverandøren støtter ALIAS/ANAME/CNAME-flattening – da `@` → `edge.snoat.com`. |
| `CNAME` | `www` | `<slug><SNOAT_APP_DOMAIN_SUFFIX>` | Anbefalt. |

**Subdomene** (`app.dittdomene.no`):

| Type | Host | Verdi | Merknad |
| --- | --- | --- | --- |
| `CNAME` | `app` | `<slug><SNOAT_APP_DOMAIN_SUFFIX>` | Obligatorisk. |

Rotdomenet må være en A-record fordi DNS ikke tillater CNAME på sonens apex –
en apex-CNAME kolliderer med SOA- og NS-recordene som må ligge der. Unntaket er
leverandører som flater ut en CNAME/ALIAS selv (Cloudflare, DNSimple, …): da er
`@` → `edge.snoat.com` best, fordi domenet følger med når Snoat bytter server. Subdomener
har ikke det problemet, og der er CNAME å foretrekke: peker vi på vertsnavnet
i stedet for IP-en, overlever kunden en framtidig IP-endring uten å røre sonen
sin.

Fanen sier også fra om at gamle `A`/`AAAA`/`CNAME` på samme host må fjernes
først – én host kan ikke ha både en A-record og en CNAME – og at TTL kan stå på
`3600` eller «Auto».

## `SNOAT_EDGE_HOST` – kantverten

Vertsnavnet som alltid peker på serveren Caddy står på: `edge.snoat.com` i
produksjon (tom env = `edge` + `SNOAT_APP_DOMAIN_SUFFIX`). Ingen kode har
serverens IP lenger:

- Backend slår opp kantverten (`edgeHost()`/`edgeIps()` i
  `backend/src/services/domain-status.ts`, fem minutters cache) både for
  DNS-sjekken og for `GET /api/dns-target`.
- Dashboardet henter vertsnavn og IP fra `GET /api/dns-target`
  (`frontend/src/lib/dns-target.ts`), i stedet for at IP-en bakes inn ved build.
- `SNOAT_SERVER_IP` er bare en reserve når oppslaget feiler (lokalt 127.0.0.1).

Bytter Snoat server: flytt A-recorden for `edge.snoat.com` (og `snoat.com`,
`*.snoat.com`). Ingen ny build. Kunder med CNAME/ALIAS følger med av seg selv;
kunder med A-record på rotdomenet må fortsatt bytte IP. Før 2026-10-05 sto IP-en
hardkodet i frontend, og etter flyttingen til Hetzner viste dashboardet den gamle.

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
dig +short dittdomene.no            # skal svare som dig +short edge.snoat.com
dig +short www.dittdomene.no CNAME  # skal svare med <slug>.snoat.com.
```

## Omdirigeringer (migrasjon 0018)

Et domene som bare skal sende folk videre, trenger ikke et prosjekt. Før dette
var fire domener (bedrift(s)hjerne(n).no) fire prosjekter med hver sin container
som svarte 301. Nå svarer Caddy selv med en `static_response` (det `redir`
kompileres til), uten repo, bygg eller prosess.

| Del | Hvor |
| --- | --- |
| Tabeller `redirects` + `redirect_domains` (domenet er PK, unikt på tvers av kontoer) | `supabase/migrations/0018_redirects.sql` |
| Validering, konflikter, CRUD, oppstarts-reconcile | `backend/src/services/redirects.ts` |
| Caddy-rutene `snoat_redirect_<id>` | `backend/src/lib/caddy.ts` (`upsertRedirectRoute`) |
| REST `GET/POST /api/redirects`, `GET/PATCH/DELETE /api/redirects/:id`, `GET …/:id/status` | `backend/src/routes/redirects.ts` |
| MCP `snoat_list_redirects`, `snoat_set_redirect`, `snoat_get_redirect_status`, `snoat_delete_redirect` | `backend/src/services/mcp-tools.ts` |
| Dashboard: «Nytt prosjekt» → Omdirigering, og kort under prosjektene | `frontend/src/components/Redirect*.tsx` |

Regler som er lette å bryte:

- **Rekkefølgen i Caddy.** Omdirigeringene settes inn *først* i `snoat_apps`
  (`PUT …/routes/0`), apprutene legges bakerst (`POST`). Et eget domene dekker
  `*.domenet`, så `gammel.osia.no` ville aldri nådd en omdirigering som sto bak
  `*.osia.no`. Verifisert mot Caddy 2.11: rekkefølgen holder også når apper
  deployes etterpå.
- **`www.` legges på av oss.** Domenet lagres uten `www.`, ruten dekker begge, og
  `tls-ask` stripper `www.` før oppslaget i `redirect_domains`.
- **`{` og `}` i målet prosent-kodes.** `Location` er en header, og Caddy
  erstatter plassholdere som `{env.NOE}` i header-verdier.
- **Konflikter sjekkes begge veier.** En omdirigering kan ikke ta et prosjekts
  domene (eller `www.`-varianten), og ikke et subdomene av en *annen* kontos
  prosjektdomene. `PATCH /projects/:id/domain` nekter et domene som er en
  omdirigering, og et domene som har en annen kontos omdirigering under seg.
- **Løkker avvises:** målets vert kan ikke være et av domenene.
- **Tak:** 20 domener per omdirigering, 200 per konto (sertifikatkvoten).

### Avgrensede API-nøkler

`api_keys.scopes` (samme migrasjon). NULL = full tilgang som før. `{redirects}`
slipper bare inn på `/api/redirects…` – ikke `/api/api-keys`, så nøkkelen kan
ikke lage seg en full en. Håndheves i `requireAuth`. Utstedes med
`issue-api-key --scope redirects`. Laget for OSIA, som styrer omdirigeringer fra
domenemodulen sin uten å få makt over prosjektene.

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
