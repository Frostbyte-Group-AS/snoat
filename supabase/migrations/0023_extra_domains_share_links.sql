-- ---------------------------------------------------------------------------
-- Flere domener per prosjekt, og delelenker med utløp foran en beskyttet app.
--
-- ## extra_domains
--
-- `custom_domain` er ett domene (pluss `*.<domene>`). Et byrå som hoster
-- kundesider trenger to: sin egen faste adresse for siden (f.eks.
-- `kunde.sider.osia.no`) og kundens domene (`kunde.no`, `www.kunde.no`), som
-- peker dit med CNAME. Begge må stå i Caddy-ruten og få sertifikat.
--
-- `extra_domains` er de eksakte vertsnavnene prosjektet svarer på i tillegg.
-- Ingen wildcard: `www.` må stå oppført for seg. Valideringen (gyldig navn,
-- ikke brukt av et annet prosjekt, ikke under et domene en annen konto eier)
-- skjer i `PUT /api/projects/:id/extra-domains`, samme regler som for
-- `custom_domain`.
--
-- ## project_share_links
--
-- En passordbeskyttet app (typisk en dev-side) kan deles med en lenke som
-- slipper forbi passordet til den utløper: `https://<vert>/?snoat_tilgang=<token>`.
-- Første treff setter en informasjonskapsel med samme token, så resten av
-- sidene og filene virker uten parameteren. Tokenet må stå i klartekst i
-- Caddy-ruten (Caddy sammenligner strenger), så det ligger her i klartekst –
-- i en tabell uten RLS-policy, slik som `project_access`: kun service-role.
--
-- Utløpet håndheves to steder: informasjonskapselen får `Max-Age` lik tiden som
-- er igjen, og sveipet i `services/dev-sites.ts` skriver ruten på nytt uten
-- tokenet når det er utløpt.
--
-- Må være idempotent: `db-migrate` kjører alle filene på nytt ved hver oppstart.
-- ---------------------------------------------------------------------------

alter table public.projects
  add column if not exists extra_domains text[] not null default '{}';

comment on column public.projects.extra_domains is
  'Eksakte vertsnavn prosjektet svarer på i tillegg til <navn>.snoat.com og custom_domain. Ingen wildcard.';

-- tls-ask og domenevalideringen slår opp «hvilket prosjekt har dette navnet».
create index if not exists projects_extra_domains_idx
  on public.projects using gin (extra_domains);

create table if not exists public.project_share_links (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete cascade,
  token text not null unique,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

comment on table public.project_share_links is
  'Delelenker forbi passordet på en beskyttet app. Kun service_role – ingen RLS-policy, med vilje.';

alter table public.project_share_links enable row level security;

create index if not exists project_share_links_project_idx
  on public.project_share_links (project_id);

create index if not exists project_share_links_expires_idx
  on public.project_share_links (expires_at);
