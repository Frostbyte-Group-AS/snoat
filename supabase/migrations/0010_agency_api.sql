-- ---------------------------------------------------------------------------
-- Maskin-API for byrå-integrasjoner (LeadLab / «Snekkeren»).
--
-- Fram til nå har prosjekter blitt opprettet klient-side, direkte mot Supabase
-- med brukerens egen sesjon og RLS. Det fungerer for dashboardet, men gjør det
-- umulig for en annen tjeneste å opprette en nettside på vegne av en kunde:
-- den har ingen nettleser, ingen GoTrue-sesjon og ingen bruker å låne.
--
-- Denne migrasjonen legger til de tre tingene et server-til-server-API trenger:
--
--   1. `agency`-planen  – LeadLab drifter mange kundesider under én konto, og
--                         skal ikke stoppes av gratisgrensene.
--   2. `api_keys`       – langlevde nøkler som identifiserer en maskin.
--   3. `external_ref`   – kallerens egen ID på prosjektet, som gjør
--                         opprettelsen idempotent.
--
-- Må være idempotent: `db-migrate` kjører alle filene på nytt ved hver oppstart.
-- ---------------------------------------------------------------------------

-- --- 1. Byråplanen ----------------------------------------------------------
--
-- Modellert som en ordinær plan-tier i stedet for et unntak i koden. Da går
-- `entitlementFor()` og `assertCanDeploy()` sin vante vei, og byrå-kontoen får
-- grensene sine fra `PLAN_LIMITS` som alle andre – i stedet for at hvert enkelt
-- sperrepunkt må huske på et «hvis dette er LeadLab»-tilfelle. Planen kan ikke
-- kjøpes; den settes for hånd på kontoen (`source = 'invoice'`).
--
-- Kjøres av psql i autocommit, så ADD VALUE trenger ingen egen transaksjon.
alter type public.subscription_tier add value if not exists 'agency';

-- --- 2. API-nøkler ----------------------------------------------------------
--
-- Nøkkelen lagres **kun** som sha256-hash. Lekker databasen, følger det ingen
-- tilgang med den – samme prinsipp som at vi aldri lagrer et GitHub-token
-- (se 0002_github_app.sql). `token_prefix` er de første tegnene i klartekst,
-- slik at en nøkkel kan gjenkjennes i en liste uten å avsløre resten.
create table if not exists public.api_keys (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  -- Hvem nøkkelen er utstedt til, f.eks. 'leadlab-produksjon'. Kun for oss.
  name text not null,
  token_prefix text not null,
  token_hash text not null unique,
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  -- Tilbaketrekking er en tidsstempling, ikke en sletting: en nøkkel som har
  -- vært i bruk skal kunne spores i ettertid.
  revoked_at timestamptz
);

create index if not exists api_keys_user_id_idx
  on public.api_keys (user_id) where revoked_at is null;

-- RLS på, uten en eneste policy. Det er ikke en forglemmelse: kun
-- service-role-nøkkelen (som omgår RLS) skal kunne lese denne tabellen.
-- En innlogget bruker i nettleseren har ingenting her å gjøre, og en tabell
-- uten policies er stengt for alle andre.
alter table public.api_keys enable row level security;
revoke all on public.api_keys from anon, authenticated;

-- --- 3. Kallerens egen referanse --------------------------------------------
--
-- LeadLab kjenner sin egen `customer_sites.id`, men ikke prosjekt-ID-en vår før
-- prosjektet finnes. Uten et sted å legge sin egen ID måtte den ha gjettet på
-- navnet for å svare på «har jeg allerede opprettet dette?», og et nettverksbrudd
-- midt i et POST ville gitt to prosjekter for samme kunde ved neste forsøk.
--
-- Unik per bruker, ikke globalt: to ulike byråer kan bruke samme interne ID-er
-- uten å kollidere. Delvis indeks, slik at prosjekter opprettet fra dashboardet
-- (der feltet er NULL) ikke teller som duplikater av hverandre.
alter table public.projects add column if not exists external_ref text;

create unique index if not exists projects_user_external_ref_unique
  on public.projects (user_id, external_ref)
  where external_ref is not null;

comment on column public.projects.external_ref is
  'Kallerens egen ID for prosjektet, satt ved opprettelse over maskin-APIet. Gjør POST /api/projects idempotent. NULL for prosjekter opprettet fra dashboardet.';
