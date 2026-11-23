-- ---------------------------------------------------------------------------
-- Wildcard-sertifikat for et prosjekts eget domene (`*.<custom_domain>`).
--
-- Et eget domene dekker subdomenene sine, men on-demand gir ett sertifikat per
-- navn, og Let's Encrypt gir høyst 50 nye per registrert domene per uke. En
-- flerleietaker-app med tusenvis av subdomener (mittvel.no) når aldri fram.
-- Ett wildcard via DNS-01 dekker alle, men krever at Caddy kan skrive en
-- TXT-oppføring i sonen – altså et API-token hos DNS-leverandøren.
--
-- Tokenet står i klartekst fordi Caddy trenger det i konfigurasjonen sin, slik
-- som tokenet i `project_share_links`. Tabellen har RLS uten policy: bare
-- service_role leser den, og API-et returnerer aldri tokenet.
--
-- `domain` er alltid prosjektets `custom_domain` da raden ble lagret. Byttes
-- domenet, fjernes raden (se `routes/api.ts`), så et token aldri gir
-- sertifikat for et domene prosjektet ikke lenger eier.
--
-- Må være idempotent: `db-migrate` kjører alle filene på nytt ved hver oppstart.
-- ---------------------------------------------------------------------------

create table if not exists public.project_wildcard_certs (
  project_id uuid primary key references public.projects (id) on delete cascade,
  domain text not null unique,
  dns_provider text not null check (dns_provider in ('cloudflare')),
  api_token text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.project_wildcard_certs is
  'Wildcard-sertifikat (*.domain) via DNS-01 per prosjekt. Kun service_role – ingen RLS-policy, med vilje.';

alter table public.project_wildcard_certs enable row level security;
