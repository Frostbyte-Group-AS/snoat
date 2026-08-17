# Snoat MCP – AI-tilkobling

Snoat kan kobles direkte til AI-assistenter via **Model Context Protocol (MCP)**. Da kan assistenten se prosjektene dine, starte deployments, lese byggelogger og hente trafikkstatistikk – på din konto, og bare din.

Tilkoblingen er en **hostet MCP-server**: én URL, ingen installasjon, ingen nøkkel å lime inn.

```
https://api.snoat.com/api/mcp
```

Kunden finner URL-en i dashboardet under **Innstillinger → AI-tilkobling** (`/settings/mcp`).

---

## 1. Koble til fra Claude

1. Åpne Claude → **Innstillinger → Connectors**.
2. Velg **«Legg til egendefinert connector»**.
3. Lim inn connector-URL-en, og trykk **«Legg til»**.
4. Logg inn hos Snoat i vinduet som åpner seg, og trykk **«Godkjenn»**.

Det er alt. Claude registrerer seg selv, forhandler tilgangen med OAuth, og fornyer den etterpå uten at kunden gjør noe.

### Claude Code, Cursor og andre kommandolinjeklienter

```bash
claude mcp add --transport http snoat https://api.snoat.com/api/mcp
```

Klienten åpner nettleseren for innlogging første gang, akkurat som Claude-appen.

### Klienter uten OAuth-støtte

Har klienten ingen OAuth-flyt, kan en API-nøkkel (`snoat_ak_…`) sendes som `Authorization: Bearer …` mot samme URL. Nøkler opprettes under **Innstillinger → AI-tilkobling → Andre klienter og kommandolinje**.

Nøkkelen utløper aldri av seg selv og gir full tilgang til kontoen, så bruk OAuth der klienten klarer det.

---

## 2. Slik virker tilkoblingen

Fire lag:

| Lag | Hvor | Hva det gjør |
| --- | --- | --- |
| MCP-endepunktet | `backend/src/routes/mcp.ts` | Tar imot JSON-RPC over Streamable HTTP. Svarer 401 med `WWW-Authenticate` når tokenet mangler – det er den headeren som setter i gang innloggingen hos klienten. |
| Autorisasjonsserveren | `backend/src/routes/oauth.ts` | Oppdagelse (RFC 8414/9728), dynamisk klientregistrering (RFC 7591), autorisasjon, token og tilbaketrekking (RFC 7009). |
| Kryptografien | `backend/src/lib/oauth.ts` | Koder, tokens, PKCE-verifisering, rotasjon av refresh-tokens, den signerte samtykke-forespørselen. |
| Verktøykatalogen | `backend/src/services/mcp-tools.ts` | De 12 verktøyene. Hvert av dem kaller vårt eget REST-API internt. |

Flyten, sett fra klienten:

```
POST /api/mcp                                 →  401 + WWW-Authenticate: … resource_metadata="…"
GET  /.well-known/oauth-protected-resource    →  hvem utsteder tokens for denne ressursen
GET  /.well-known/oauth-authorization-server  →  hvor endepunktene ligger
POST /oauth/register                          →  client_id (ingen client_secret – offentlig klient, PKCE påkrevd)
GET  /oauth/authorize                         →  302 til /oauth/consent i dashboardet
POST /oauth/approve                           →  brukeren godkjente; kode til registrert redirect_uri
POST /oauth/token                             →  access_token (24 t) + refresh_token (30 d)
POST /api/mcp                                 →  tools/list, tools/call …
```

### Hvorfor verktøyene går gjennom REST-API-et

`services/mcp-tools.ts` kaller `api.fetch()` mot vårt eget API i stedet for å snakke med databasen. Hvert verktøykall går dermed gjennom `requireAuth`, `loadOwnedProject`, plangrensene og oppryddingen – nøyaktig samme vei som dashboardets egne kall.

Konsekvensen er verdt å huske: **et nytt sperrepunkt i et REST-endepunkt gjelder automatisk for MCP også**, og en AI-klient kan aldri gjøre noe kunden ikke kunne gjort selv i dashboardet.

### Hva som ikke krever konfigurasjon

Ingen nye miljøvariabler. `issuer` og ressurs-URL leses ut av `Host`/`X-Forwarded-Proto` på forespørselen (`lib/public-url.ts`), og nøkkelen som signerer samtykke-forespørselen utledes fra service-role-nøkkelen. Begge valgene finnes for at connectoren ikke skal kunne feile i produksjon fordi en variabel ble glemt.

Tabellene ligger i `supabase/migrations/0011_mcp_connector.sql`, som `db-migrate` kjører ved oppstart.

**Merk monteringsrekkefølgen i `index.ts`:** `/api/mcp` monteres *før* `/api`. `routes/api.ts` legger `requireAuth` på alt under seg, og den svarer 401 i vårt eget JSON-format. MCP-klienter trenger 401 med `WWW-Authenticate`. Bytter du om på de to linjene, får kunden «Mangler Authorization-header» i stedet for en innloggingsdialog, og connectoren kan ikke kobles til i det hele tatt.

---

## 3. Sikkerhetsmodellen

**Tilgangen oppstår bare ett sted:** når en innlogget bruker trykker «Godkjenn» på `/oauth/consent`. Registrering er ingen tillitsbeslutning – hvem som helst kan registrere en klient, men ingen får tilgang før et menneske godkjenner.

- **PKCE (S256) er påkrevd.** `plain` støttes ikke.
- **`redirect_uri` matches tegn for tegn** mot de registrerte. Ingen prefiksmatching – en «starts with»-sjekk her er den klassiske måten å gi bort autorisasjonskoder.
- **Bare https** (eller loopback) som redirect_uri.
- **Koder lever i 60 sekunder** og kan brukes én gang. Et andre forsøk trekker tilbake alt klienten har – en gjenbrukt kode betyr at den kan være avlyttet.
- **Refresh-tokens roteres.** Brukes et rotert token om igjen, faller hele familien bort.
- **Alt lagres som sha256-hash.** Verken koder eller tokens kan leses ut av en databasedump.
- **Kunden kan koble fra** under Innstillinger → AI-tilkobling. Klienten mister tilgangen ved neste kall.
- **Bare sesjoner kan administrere tilkoblinger.** En connector kan ikke kartlegge eller koble fra de andre connectorene på kontoen.

### Miljøvariabler maskeres mot modellen

`GET /api/projects` returnerer `env_vars` i klartekst – riktig for dashboardet, feil for en modellkontekst. Gjennom MCP maskeres **verdiene**, mens **nøkkelnavnene** beholdes:

```json
"env_vars": {
  "DATABASE_URL": "post… ••• (skjult, 84 tegn)",
  "APP_ENV": "prod… ••• (skjult, 10 tegn)"
}
```

Uten dette ville ett `snoat_list_projects` sendt databasepassord og API-nøkler for alle prosjektene på kontoen ut av huset, uten at kunden ba om annet enn en oversikt. `snoat_update_project` kan sette nye verdier uten å ha sett de gamle.

Byggelogger klippes til de siste 20 000 tegnene og kjøres gjennom `redactCredentials()`.

### Sletting

`snoat_delete_project` krever at `confirmProjectName` stemmer med prosjektets faktiske navn – slått opp fra API-et, ikke fra det modellen tror – og at `confirmPermanentDeletion` er `true`. Verktøyet er dessuten merket `destructiveHint`, så klienten spør brukeren før det kjøres.

---

## 4. Verktøy

| Verktøy | Merking | Beskrivelse |
| --- | --- | --- |
| `snoat_list_projects` | lesende | Alle prosjekter med status på siste deployment. |
| `snoat_get_project` | lesende | Detaljer for ett prosjekt. |
| `snoat_get_deployments` | lesende | De 20 siste deploymentene. |
| `snoat_get_deployment_logs` | lesende | Bygge- og kjøretidslogg for én deployment. |
| `snoat_get_analytics` | lesende | Besøkstall, responstider, statuskoder, toppstier. |
| `snoat_get_domain_status` | lesende | DNS, Caddy-rute og TLS-sertifikat for eget domene. |
| `snoat_create_project` | skrivende | Nytt prosjekt fra en GitHub-repo. Bygger ikke automatisk. |
| `snoat_update_project` | skrivende | Byggekommando, miljøvariabler, statiske innstillinger. |
| `snoat_trigger_deployment` | skrivende | Legger et bygg i kø. |
| `snoat_set_custom_domain` | skrivende | Kobler eller fjerner eget domene. |
| `snoat_stop_project` | destruktiv | Stopper appen. Prosjektet beholdes. |
| `snoat_delete_project` | destruktiv | Permanent sletting. Krever bekreftelse. |

---

## 5. Eksempler på bruk

- *«Vis meg alle prosjektene mine på Snoat og om de kjører.»*
- *«Hvorfor feilet siste deployment av mittvel? Hent loggen.»*
- *«Lag prosjektet min-demo fra github.com/meg/min-demo og deploy det.»*
- *«Hvor mange unike besøkende har appen hatt det siste døgnet?»*
- *«Peker DNS-en for app.mittdomene.no riktig? Sjekk sertifikatet også.»*

---

## 6. Feilsøking

| Symptom | Årsak |
| --- | --- |
| Klienten får «could not connect» | Sjekk at `GET /.well-known/oauth-authorization-server` svarer, og at `issuer` i svaret stemmer med verten kunden koblet til. Er de ulike, avviser klienten oppsettet. |
| «Ukjent client_id» i innloggingen | Klienten er slettet fra `oauth_clients`. Fjern og legg til connectoren på nytt i klienten. |
| Innloggingen ender på dashboardet | Samtykkesiden mistet returadressen (`lib/return-to.ts` bruker `sessionStorage`, som privat nettlesermodus kan nekte). Start tilkoblingen på nytt fra klienten. |
| Klienten mistet tilgangen brått | Et rotert refresh-token ble brukt om igjen, eller kunden koblet fra. Begge krever ny godkjenning – det er tilsiktet. |
| Verktøykall svarer «Prosjektet finnes ikke» | Prosjektet tilhører en annen konto. Vi svarer 404 og ikke 403, slik at et ID-gjett ikke avslører at raden finnes. |

---

## 7. Om `mcp-server/`-katalogen

**Utgått.** Den lokale stdio-serveren (`@snoat/mcp-server`) var den forrige måten å koble til på: kunden måtte installere en npm-pakke og lime en `snoat_ak_…`-nøkkel inn i en JSON-fil. Pakken ble aldri publisert til npm, så konfigurasjonen dashboardet delte ut (`npx -y @snoat/mcp-server`) kunne ikke fungere.

Katalogen er beholdt for referanse, men brukes ikke lenger noe sted, og verktøydefinisjonene i den er erstattet av `backend/src/services/mcp-tools.ts`. Den kan slettes.
