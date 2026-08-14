# Snoat MCP Server Brukerveiledning

Snoat MCP (Model Context Protocol) Server gjør det mulig å koble din personlige Snoat-bruker direkte til AI-assistenter som **Claude Desktop**, **Cursor**, **Antigravity**, **VS Code**, **Windsurf** og andre MCP-kompatible klienter.

Med Snoat MCP Server kan din AI-assistent:
- Inspisere alle prosjekter du har tilgang til, deres status og miljøvariabler.
- Opprette nye prosjekter direkte fra GitHub-repositories.
- Utløse nye deployments, stoppe applikasjoner eller koble til tilpassede domener.
- Hente ut bygge- og kjøretidslogger for å feilsøke feil i applikasjoner.
- Hente ut trafikkstatistikk (unike besøkende, sidevisninger, responstider).
- **Trygg håndtering av sletting:** Sletting er som standard sperret for å forhindre utilsiktet sletting fra en LLM.

---

## 1. Opprette din personlige API-nøkkel

MCP-serveren er **unik per bruker** og benytter din personlige Snoat API-nøkkel (`snoat_ak_...`) for autentisering. 

Snoat backend sikrer at du **kun ser og kan administrere dine egne prosjekter**.

Du kan opprette eller hente din API-nøkkel i Snoat Dashboard under **Konto / API-nøkler**, eller generere en nøkkel direkte via Supabase/Backend.

---

## 2. Installasjon og Konfigurasjon

### A. Claude Desktop (`claude_desktop_config.json`)

Legg til følgende i din Claude Desktop sin konfigurasjonsfil:
- **macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows**: `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "snoat": {
      "command": "node",
      "args": ["/absolutt/sti/til/snoat/mcp-server/dist/index.js"],
      "env": {
        "SNOAT_API_KEY": "snoat_ak_din_personlige_api_nokkel",
        "SNOAT_API_URL": "http://api.snoat.localhost",
        "ALLOW_DANGEROUS_DELETIONS": "false"
      }
    }
  }
}
```

### B. Cursor / Antigravity (`mcp.json`)

I Cursor eller Antigravity sine MCP-innstillinger:

```json
{
  "mcpServers": {
    "snoat": {
      "command": "node",
      "args": ["/absolutt/sti/til/snoat/mcp-server/dist/index.js"],
      "env": {
        "SNOAT_API_KEY": "snoat_ak_din_personlige_api_nokkel",
        "SNOAT_API_URL": "http://api.snoat.localhost"
      }
    }
  }
}
```

---

## 3. Sikkerhetsmodell for Sletting (Begrensning for sletting)

Sletting av et prosjekt er en destruktiv handling som fjerner både databasen, containeren og Caddy-ruten. 

Snoat MCP Server implementerer **3 lag med slette-restriksjoner**:

1. **Mislagt / Sperret som standard:**
   Dersom miljøvariabelen `ALLOW_DANGEROUS_DELETIONS=true` *ikke* er satt i miljøet til MCP-serveren, vil enhver forespørsel om sletting returnere en feilmelding:
   > `BEGRENSNING MOT SLETTING: Sletting av prosjekter er deaktivert på denne MCP-serveren.`

2. **Eksplisitte Bekreftelsesparametere:**
   Om sletting er aktivert i miljøvariablene, krever verktøyet `snoat_delete_project` at kalleren oppgir:
   - `confirmProjectName`: Prosjektets eksakte navneslug eller ID.
   - `confirmPermanentDeletion`: Må settes eksplisitt til `true`.

3. **Backend Tilgangskontroll:**
   Backend API-et avviser alle kallet dersom API-nøkkelen har blitt tilbaketrukket eller ikke tilhører eieren av prosjektet.

---

## 4. Tilgjengelige MCP Verktøy (Tools)

| Verktøy | Beskrivelse |
| --- | --- |
| `snoat_list_projects` | Henter oversikt over alle dine prosjekter og status på siste deployment. |
| `snoat_get_project` | Henter fullstendige detaljer om et prosjekt (byggekommando, env_vars, domene). |
| `snoat_create_project` | Registrerer og oppretter et nytt prosjekt fra en GitHub repo-URL. |
| `snoat_update_project` | Endrer byggekommando, miljøvariabler eller statiske innstillinger. |
| `snoat_stop_project` | Stopper den kjørende applikasjonscontaineren uten å slette prosjektet. |
| `snoat_set_custom_domain` | Kobler et tilpasset eget domene til et prosjekt. |
| `snoat_trigger_deployment` | Utløser ny bygging og utrulling (Nixpacks + Dockerode + Caddy). |
| `snoat_get_deployments` | Henter byggehistorikk og status for prosjektets deployments. |
| `snoat_get_deployment_logs` | Henter ut bygge- og kjøretidslogger for feilsøking. |
| `snoat_get_analytics` | Henter trafikkstatistikk (besøkende, sidevisninger, feilkoder). |
| `snoat_get_domain_status` | Verifiserer DNS, Caddy-ruting og TLS-sertifikater for et eget domene. |
| `snoat_delete_project` | **Destruktiv:** Permanent sletting av et prosjekt (krever tillatelse). |

---

## 5. Eksempel på bruk i chat

Når MCP-serveren er tilkoblet, kan du gi naturlige kommandoer til AI-assistenten:

- *"Vis meg en liste over alle prosjektene mine på Snoat og om de kjører."*
- *"Lag et nytt prosjekt 'min-demo' som peker på https://github.com/mitt-navn/min-demo og deploy det."*
- *"Hvorfor feilet siste deployment for prosjektet min-demo? Hent ut loggene."*
- *"Hvor mange unike besøkende har appen min hatt det siste døgnet?"*
- *"Endre miljøvariabelen API_URL til https://api.example.com på prosjektet mitt."*
