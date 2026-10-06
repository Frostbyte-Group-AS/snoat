-- ---------------------------------------------------------------------------
-- VPS-domener: et domene som Caddy sender rett videre til en port på en VPS.
--
-- Før dette gikk bare SSH inn til en VPS (DNAT på Proxmox-verten). En tjeneste
-- som lyttet på HTTP inne i VPS-en – f.eks. en FastAPI på :8000 – kunne ikke nås
-- utenfra uten å åpne enda en port på verten. Nå legger backend en Caddy-rute
-- `https://<domene>` → `<vps-ip>:<port>`, med sertifikat on-demand som alt annet.
-- Snoat-VM-en (10.10.10.10) når VPS-nettet (10.10.10.100–250) direkte.
--
-- Tvillingen til omdirigeringene (0018): samme eierkolonne, samme RLS, og
-- domenet er unikt på tvers av alle kontoer slik at TLS-sjekken (`routes/tls.ts`)
-- får ett svar for ett domene. Én rad per domene; en VPS kan ha flere domener
-- (ulike porter), men et domene peker på nøyaktig én VPS-port.
--
-- At domenet ikke også er et prosjekts eget domene eller en omdirigering,
-- sjekkes i backend (`services/vps-domener.ts`) – en constraint kan ikke se inn i
-- `projects` eller `redirect_domains`.
--
-- ## IP-en
--
-- `ip` er sist kjente adresse fra Proxmox, ikke fasit. Den skrives når domenet
-- kobles til og oppdateres når backend starter og synker rutene. Er Proxmox nede
-- ved oppstart, er det denne som gjør at ruten likevel kommer tilbake.
--
-- ## RLS
--
-- Slått på uten en eneste policy, som `redirects`. Alt går gjennom backend
-- (`/api/vps/:vmid/domener`), som er eneste som kan skrive til Caddy – og VPS-er
-- finnes bare for eierkontoen.
--
-- Må være idempotent: `db-migrate` kjører alle filene på nytt ved hver oppstart.
-- ---------------------------------------------------------------------------

create table if not exists public.vps_domains (
  id uuid primary key default gen_random_uuid(),
  -- Normalisert som `redirect_domains.domain`: små bokstaver, uten skjema, sti,
  -- port og `www.`. `www.`-varianten dekkes alltid automatisk av ruten.
  domain text not null,
  user_id uuid not null references public.profiles (id) on delete cascade,
  -- Proxmox' VMID. Ingen fremmednøkkel: VPS-en bor i Proxmox, ikke i databasen.
  vmid integer not null,
  port integer not null,
  -- Sist kjente IP på VPS-nettet. Se over.
  ip text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'vps_domains_domain_key') then
    alter table public.vps_domains add constraint vps_domains_domain_key unique (domain);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'vps_domains_port_check') then
    alter table public.vps_domains
      add constraint vps_domains_port_check check (port between 1 and 65535);
  end if;
end
$$;

create index if not exists vps_domains_user_id_idx on public.vps_domains (user_id);
create index if not exists vps_domains_vmid_idx on public.vps_domains (vmid);

comment on table public.vps_domains is
  'Domener Caddy sender videre til <ip>:<port> på en VPS. Domenet er unikt på tvers av kontoer.';

alter table public.vps_domains enable row level security;
revoke all on public.vps_domains from anon, authenticated;

-- Se 0017: backend kan ellers få «relation does not exist» fra PostgREST til
-- `rest` restartes.
notify pgrst, 'reload schema';
