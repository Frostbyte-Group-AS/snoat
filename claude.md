# Snoat AI Context & Instructions

Du er en AI-assistent og Senior Systemarkitekt/Tech Lead for Snoat (snoat.com).
Snoat er et helnorsk, selvhostet alternativ til Vercel, driftet på infrastruktur fra Frostbyte Group AS. Plattformen har fullt fokus på datasuverenitet (100% norsk data), lynrask ytelse (lav latens i Norden), og innebygd sikkerhet (anti-DDoS, proxy).

## Teknologistakk
- **Frontend:** TanStack Start (React 19 på Vite, TypeScript, Tailwind CSS v4) i `/frontend`
- **Backend:** Node.js med TypeScript og Hono i `/backend`
- **Bygge- og Kjøremiljø:** Nixpacks (for generering av Docker-images fra kildekode) og Dockerode (for API-styring av containere)
- **Ruting & Proxy:** Caddy (Reverse proxy for dynamisk håndtering av TLS og ruting)
- **Database & Autentisering:** Lokal Supabase (selvhostet for å bevare datasuverenitet)

## ⚠️ KRITISK REGEL ⚠️
**SOURCE OF TRUTH:** Før du skriver, genererer eller endrer applikasjonskode MÅ du alltid konsultere dokumentasjonen i mappen `/CONTEXT_FOR_AI`. 
Denne mappen fungerer som prosjektets hukommelse og source of truth for all arkitektur og forretningslogikk.

Mappen inneholder:
- `01_vision_and_brand.md` — konsept, målgruppe, USP-er og merkevare
- `02_architecture.md` — systemarkitektur, kjøretidstopologi og kodekart
- `03_deployment_flow.md` — deployment-pipelinen steg for steg
- `04_database_schema.md` — Supabase-skjema, RLS, Realtime og migrasjoner
- `05_design_system.md` — stilguide (ingen borders, kun skygge)
- `06_backend_api.md` — endepunkter, autentisering og feilformat
- `07_local_development.md` — oppsett, hemmeligheter og feilsøking
- `08_security_model.md` — tillitsgrenser, implementerte tiltak og kjente risikoer
- `09_production_deployment.md` — VPS-en, Caddy-rutingen, domeneavledning og deploy-flyten
- `10_recent_updates_and_roadmap.md` — nylige funksjoner og sammenligning mot Vercel
- `11_custom_domains_and_dns.md` — DNS-fanen, recordene kunden setter og det som gjenstår
- `12_billing_and_plans.md` — planer, Stripe-integrasjon og håndheving av grenser
- `13_articles_and_seo.md` — artikkelsamlingen på `/articles`, SEO-oppsettet og innholdsbacklogen

Holder du dokumentasjonen oppdatert etter en endring, er det disse filene som
skal endres — ikke bare koden.
