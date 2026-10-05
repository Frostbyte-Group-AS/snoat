-- ---------------------------------------------------------------------------
-- Omdirigeringer: domener som bare skal sende den besøkende et annet sted.
--
-- Før dette fantes det én måte å få et domene til å svare på Snoat: et prosjekt.
-- Fire domener (bedrift(s)hjerne(n).no) som alle skulle sende folk til én artikkel
-- ble dermed fire prosjekter, fire bygg og fire kjørende containere som gjorde
-- én ting – svarte 301. Her svarer Caddy selv, uten repo, bygg eller prosess.
--
-- ## Hvorfor to tabeller
--
-- `redirect_domains.domain` er primærnøkkelen, altså unik på tvers av alle
-- kontoer. Det er den samme garantien `projects.custom_domain` har (UNIQUE), og
-- av samme grunn: TLS-sjekken (`routes/tls.ts`) slår opp *ett* domene og må få
-- ett svar. En `text[]`-kolonne på `redirects` kunne ikke gitt den garantien uten
-- en trigger.
--
-- At domenet ikke også er et prosjekts eget domene, sjekkes i backend
-- (`services/redirects.ts`) – en constraint kan ikke se inn i `projects`.
--
-- ## RLS
--
-- Slått på uten en eneste policy, som `api_keys`. Dashboardet leser og skriver
-- omdirigeringer gjennom backend (`/api/redirects`), ikke rett mot Supabase:
-- hver endring må uansett nå Caddy, og det kan bare backend gjøre.
--
-- Må være idempotent: `db-migrate` kjører alle filene på nytt ved hver oppstart.
-- ---------------------------------------------------------------------------

create table if not exists public.redirects (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  -- Visningsnavn i dashboardet. Ikke en slug og ikke unik – det er domenene som
  -- identifiserer en omdirigering utad.
  name text not null,
  -- Hvor den besøkende sendes. Alltid en absolutt http(s)-URL; valideres i backend.
  target_url text not null,
  status_code smallint not null default 301,
  -- Sant: `gammelt.no/om-oss` → `<target_url>/om-oss`. Usant: alt går til
  -- `target_url` uansett sti, som er det man vil når et domene peker på én side.
  preserve_path boolean not null default false,
  -- Kallerens egen ID, som `projects.external_ref`. Gjør POST /api/redirects
  -- idempotent for integrasjoner (OSIA sender sin domene-ID).
  external_ref text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'redirects_status_code_check') then
    alter table public.redirects
      add constraint redirects_status_code_check check (status_code in (301, 302, 307, 308));
  end if;
end
$$;

create index if not exists redirects_user_id_idx on public.redirects (user_id);

create unique index if not exists redirects_user_external_ref_unique
  on public.redirects (user_id, external_ref)
  where external_ref is not null;

comment on table public.redirects is
  'Domener som bare omdirigerer. Caddy svarer selv med status_code og Location – ingen container.';

create table if not exists public.redirect_domains (
  -- Normalisert: små bokstaver, uten skjema, sti, port og `www.`. `www.`-varianten
  -- dekkes alltid automatisk av ruten.
  domain text primary key,
  redirect_id uuid not null references public.redirects (id) on delete cascade,
  created_at timestamptz not null default now()
);

create index if not exists redirect_domains_redirect_id_idx on public.redirect_domains (redirect_id);

comment on table public.redirect_domains is
  'Domenene en omdirigering svarer på. Primærnøkkelen gjør et domene unikt på tvers av kontoer.';

alter table public.redirects enable row level security;
alter table public.redirect_domains enable row level security;
revoke all on public.redirects from anon, authenticated;
revoke all on public.redirect_domains from anon, authenticated;

-- ---------------------------------------------------------------------------
-- Avgrensede API-nøkler.
--
-- En API-nøkkel har til nå vært kontoen sin, med alt kontoen kan: opprette og
-- slette prosjekter, lese miljøvariabler, lage nye nøkler. OSIA trenger bare å
-- styre omdirigeringer, og en nøkkel som ligger i en annen apps miljø bør ikke
-- kunne mer enn det.
--
-- NULL = full tilgang, slik alle eksisterende nøkler har. Ellers en liste med
-- områder; `requireAuth` slipper bare gjennom stier som hører til et av dem
-- (`middleware/auth.ts`). Eneste område foreløpig: 'redirects'.
-- ---------------------------------------------------------------------------

alter table public.api_keys add column if not exists scopes text[];

comment on column public.api_keys.scopes is
  'NULL = full tilgang. Ellers områdene nøkkelen gjelder for, f.eks. {redirects}. Håndheves i middleware/auth.ts.';

-- Se 0017: backend kan ellers få «relation does not exist» fra PostgREST til
-- `rest` restartes.
notify pgrst, 'reload schema';
