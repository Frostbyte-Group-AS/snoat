-- ---------------------------------------------------------------------------
-- 0021: Globalt unike prosjektnavn, reserverte navn, og at GitHub-installasjonen
-- på et prosjekt tilhører prosjekteieren.
--
-- Kjøres ved hver oppstart (db-migrate), så alt her er idempotent.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 1. Prosjektnavnet er subdomenet – det må være unikt på tvers av kontoer.
--
-- `projects_user_name_unique` (0001) gjorde navnet unikt bare *per bruker*, mens
-- alt som ruter trafikk nøkler på navnet alene: Caddy-rute-ID-en
-- `snoat_app_<navn>`, nettverksaliaset, image-taggen `snoat/<navn>` og
-- TLS-oppslaget. En annen konto kunne derfor opprette et prosjekt med samme navn
-- som ditt, deploye, og overta `<navn>.snoat.com` – eller ta ruten ned ved å
-- stoppe sitt eget prosjekt.
--
-- Finnes det allerede duplikater, beholder det *eldste* prosjektet navnet (det
-- var der først, og er det som eier subdomenet i dag), og de nyere får et
-- suffiks av sin egen ID. Det logges som en WARNING i db-migrate-loggen.
-- ---------------------------------------------------------------------------

do $$
declare
  r record;
  base text;
  candidate text;
begin
  for r in
    select id, name
    from (
      select id, name, row_number() over (partition by name order by created_at, id) as rn
      from public.projects
    ) d
    where rn > 1
  loop
    base := regexp_replace(left(r.name, 56), '-+$', '');
    candidate := base || '-' || left(replace(r.id::text, '-', ''), 6);
    update public.projects set name = candidate where id = r.id;
    raise warning 'projects: «%» (%) omdøpt til «%» – navnet var i bruk av et eldre prosjekt',
      r.name, r.id, candidate;
  end loop;
end
$$;

create unique index if not exists projects_name_unique on public.projects (name);

-- Plattformens egne vertsnavn under SNOAT_ROOT_DOMAIN. En trigger og ikke en
-- check-constraint: selv `NOT VALID` gjelder hver UPDATE av en eksisterende rad,
-- og da ville et eventuelt gammelt prosjekt med et slikt navn ikke lenger kunne
-- oppdateres i det hele tatt (heller ikke av backend under en deploy). Triggeren
-- slår bare inn når navnet settes eller endres.
create or replace function public.projects_name_not_reserved()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'UPDATE' and new.name is not distinct from old.name then
    return new;
  end if;

  if new.name in ('www', 'api', 'supabase', 'studio', 'edge', 'admin') then
    raise exception 'Prosjektnavnet «%» er reservert for Snoat.', new.name
      using errcode = '23514';
  end if;

  return new;
end;
$$;

drop trigger if exists projects_name_not_reserved_trigger on public.projects;
create trigger projects_name_not_reserved_trigger
  before insert or update of name on public.projects
  for each row execute function public.projects_name_not_reserved();

-- ---------------------------------------------------------------------------
-- 2. `github_installation_id` må være en installasjon prosjekteieren har koblet.
--
-- RLS-policyen `projects_all_own` (0001) lar eieren skrive alle kolonner på sin
-- egen rad direkte fra nettleseren. Uten denne triggeren kunne en eier sette
-- `github_installation_id` til en annens installasjon og trigge en deploy:
-- backend ville utstedt et token for offerets installasjon og klonet offerets
-- private repo. `verifiedInstallationId()` i backend dekker bare API-veien.
--
-- `github_installations` har kun en select-policy, så brukeren kan ikke selv
-- legge inn raden som skal til; den skrives av backend etter
-- eierskapssjekken i services/installation-ownership.ts.
--
-- Eksisterende rader røres ikke: triggeren slår bare inn når installasjonen
-- eller eieren faktisk endres.
-- ---------------------------------------------------------------------------

create or replace function public.projects_installation_owned()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.github_installation_id is null then
    return new;
  end if;

  if tg_op = 'UPDATE'
     and new.github_installation_id is not distinct from old.github_installation_id
     and new.user_id is not distinct from old.user_id then
    return new;
  end if;

  if not exists (
    select 1
    from public.github_installations gi
    where gi.user_id = new.user_id
      and gi.installation_id = new.github_installation_id
  ) then
    raise exception 'GitHub-installasjon % er ikke koblet til prosjekteierens konto.', new.github_installation_id
      using errcode = '42501';
  end if;

  return new;
end;
$$;

revoke all on function public.projects_installation_owned() from public, anon, authenticated;

drop trigger if exists projects_installation_owned_trigger on public.projects;
create trigger projects_installation_owned_trigger
  before insert or update of github_installation_id, user_id on public.projects
  for each row execute function public.projects_installation_owned();
