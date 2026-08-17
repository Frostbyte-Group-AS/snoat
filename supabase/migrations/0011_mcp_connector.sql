-- ---------------------------------------------------------------------------
-- MCP-connector: OAuth 2.1 for Claude og andre MCP-klienter
--
-- Fram til nå var MCP en lokal stdio-prosess kunden måtte installere selv, med
-- en `snoat_ak_…`-nøkkel limt inn i en JSON-fil. Claude sine «custom
-- connectors» kobler seg i stedet til en URL, og forhandler tilgangen med
-- OAuth: brukeren trykker «Connect», logger inn hos oss, godkjenner, og
-- klienten får sitt eget token. Ingen nøkkel skal noen gang innom utklippstavla.
--
-- Det krever at vi *er* en autorisasjonsserver, og en autorisasjonsserver
-- trenger tre ting: klienter som har registrert seg, kortlevde koder under
-- innloggingen, og tokens etterpå. Én tabell hver.
--
-- Hvorfor ikke Supabase/GoTrue sin egen OAuth? Fordi GoTrue er
-- *innloggingsleverandøren* vår, ikke en autorisasjonsserver for tredjeparter:
-- den har ingen dynamisk klientregistrering (RFC 7591), som er nettopp det
-- Claude bruker for å registrere seg selv uten at kunden skal fylle inn en
-- client_id for hånd. Vi låner GoTrue til å bekrefte *hvem brukeren er* på
-- samtykkesiden, og eier resten selv.
--
-- Må være idempotent: `db-migrate` kjører alle filene på nytt ved hver oppstart.
-- ---------------------------------------------------------------------------

-- --- 1. Registrerte klienter -----------------------------------------------
--
-- Claude registrerer seg selv via `POST /oauth/register` og får en `client_id`
-- tilbake. Vi utsteder ingen client_secret: klienten er en «public client» i
-- OAuth-forstand, og en hemmelighet den må lagre er en hemmelighet som lekker.
-- PKCE er det som binder token-kallet til den som startet innloggingen, og den
-- er påkrevd – se `code_challenge` under.
--
-- `redirect_uris` er hele sikkerheten i registreringen. En kode sendes bare til
-- en URI som står her, tegn for tegn, slik at en angriper ikke kan bytte den ut
-- med sin egen selv om hen kjenner `client_id` (den er ikke hemmelig).
create table if not exists public.oauth_clients (
  id uuid primary key default gen_random_uuid(),
  client_id text not null unique,
  -- Navnet klienten oppgir om seg selv, f.eks. «Claude». Vises på
  -- samtykkesiden og i listen over tilkoblinger, så kunden kan se hva hen
  -- faktisk har gitt tilgang. Klientkontrollert tekst: skal aldri rendres som
  -- HTML, og aldri tillegges tillit.
  client_name text not null,
  redirect_uris text[] not null,
  created_at timestamptz not null default now()
);

-- --- 2. Autorisasjonskoder --------------------------------------------------
--
-- Lever i sekunder, fra brukeren trykker «Godkjenn» til klienten bytter koden
-- inn i et token. Lagres som sha256-hash av samme grunn som API-nøklene: en
-- kode vi kan lese ut av databasen er en kode som kan leses ut av en dump.
--
-- `consumed_at` i stedet for `delete`: en kode som forsøkes brukt to ganger er
-- et tegn på at den er avlyttet, og det vil vi kunne se i ettertid. RFC 6749
-- krever at gjenbruk avvises – ikke at sporet slettes.
create table if not exists public.oauth_authorization_codes (
  id uuid primary key default gen_random_uuid(),
  code_hash text not null unique,
  client_id text not null references public.oauth_clients (client_id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  -- Må stemme med den `redirect_uri` klienten oppgir ved innbyttet. Uten denne
  -- bindingen kan en kode fanget opp i én flyt løses inn i en annen.
  redirect_uri text not null,
  -- PKCE (RFC 7636), alltid S256. Klienten beviser ved innbyttet at den kjenner
  -- verifikatoren bak denne hashen – det er det som gjør at en kode som lekker
  -- fra en nettleserlogg eller en Referer-header ikke er nok alene.
  code_challenge text not null,
  scope text not null default 'mcp',
  -- RFC 8707: hvilken ressurs tokenet skal gjelde for. Bæres videre til tokenet
  -- slik at et token utstedt for MCP-endepunktet ikke også er en generell
  -- API-nøkkel dersom vi senere får flere ressurser.
  resource text,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists oauth_authorization_codes_expires_idx
  on public.oauth_authorization_codes (expires_at);

-- --- 3. Tokens -------------------------------------------------------------
--
-- Både access- og refresh-tokens i samme tabell, skilt på `kind`. De har
-- identisk livssyklus-logikk (slå opp hash, sjekk utløp, sjekk tilbaketrekking)
-- og skal kunne trekkes tilbake i én operasjon når kunden kobler fra en klient.
-- To tabeller ville betydd to spørringer i hver autentisering.
--
-- `access` utløper etter dager, `refresh` etter måneder. Klienten fornyer selv;
-- kunden merker ingenting før hen kobler fra i dashboardet.
do $$ begin
  create type public.oauth_token_kind as enum ('access', 'refresh');
exception
  when duplicate_object then null;
end $$;

create table if not exists public.oauth_tokens (
  id uuid primary key default gen_random_uuid(),
  token_hash text not null unique,
  kind public.oauth_token_kind not null,
  client_id text not null references public.oauth_clients (client_id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  scope text not null default 'mcp',
  resource text,
  expires_at timestamptz not null,
  -- Rotasjon: et refresh-token som brukes, byttes ut. Kjeden peker tilbake på
  -- forrige token slik at et gjenbrukt (altså stjålet) refresh-token kan spores
  -- til hele familien og trekkes tilbake samlet.
  replaces_token_id uuid references public.oauth_tokens (id) on delete set null,
  revoked_at timestamptz,
  last_used_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists oauth_tokens_user_client_idx
  on public.oauth_tokens (user_id, client_id) where revoked_at is null;

create index if not exists oauth_tokens_expires_idx
  on public.oauth_tokens (expires_at) where revoked_at is null;

-- --- 4. Tilgangskontroll ---------------------------------------------------
--
-- RLS på, uten en eneste policy – samme begrunnelse som for `api_keys` i 0010:
-- kun service-role-nøkkelen (som omgår RLS) skal kunne lese disse tabellene.
-- Dashboardet leser tilkoblingene sine gjennom backend, ikke direkte, nettopp
-- fordi en token-hash aldri skal kunne hentes av en nettleser.
alter table public.oauth_clients enable row level security;
alter table public.oauth_authorization_codes enable row level security;
alter table public.oauth_tokens enable row level security;

revoke all on public.oauth_clients from anon, authenticated;
revoke all on public.oauth_authorization_codes from anon, authenticated;
revoke all on public.oauth_tokens from anon, authenticated;
