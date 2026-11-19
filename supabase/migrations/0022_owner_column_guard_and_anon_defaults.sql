-- ---------------------------------------------------------------------------
-- 0022: Kolonner eieren ikke skal kunne skrive rett i databasen, og standard-
-- rettighetene for nye tabeller.
--
-- Kjøres ved hver oppstart (db-migrate), så alt her er idempotent.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 1. Plan, eget domene og forelderprosjekt går bare gjennom backend.
--
-- RLS-policyen `projects_all_own` (0001) lar eieren skrive *alle* kolonner på
-- sin egen rad fra nettleseren. For de fleste er det meningen (dashboardet
-- lagrer gren, byggekommando og miljøvariabler selv), men tre kolonner bærer
-- rettigheter eller valideres bare i backend:
--
-- - `plan`: `prevent_project_plan_update` (0007) stopper bare UPDATE. Med
--   INSERT kunne hvem som helst opprette et prosjekt med `plan = 'business'`
--   og få betalte ressurser gratis.
-- - `custom_domain`: domenevalideringen og sjekken mot andres foreldredomener
--   ligger i `PATCH /api/projects/:id/domain`. En direkte skriving hoppet over
--   begge, og ga sertifikat og rute for et subdomene under en annen kundes
--   domene.
-- - `parent_project_id`: gjør raden til en dev-side av et annet prosjekt –
--   det skal bare backend avgjøre (services/dev-sites.ts).
--
-- Gjelder bare innloggede brukere (`auth.uid()` satt). Backend
-- (service_role, `auth.uid()` NULL) og migrasjoner går som før.
-- ---------------------------------------------------------------------------

create or replace function public.projects_guard_owner_columns()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null then
    return new;
  end if;

  if tg_op = 'INSERT' then
    if new.plan is distinct from 'free' then
      raise exception 'Planen settes av Snoat, ikke fra klienten.' using errcode = '42501';
    end if;
    if new.custom_domain is not null then
      raise exception 'Eget domene legges til fra prosjektinnstillingene.' using errcode = '42501';
    end if;
    if new.parent_project_id is not null then
      raise exception 'Dev-sider opprettes fra prosjektinnstillingene.' using errcode = '42501';
    end if;
    return new;
  end if;

  if new.custom_domain is distinct from old.custom_domain then
    raise exception 'Eget domene endres fra prosjektinnstillingene.' using errcode = '42501';
  end if;
  if new.parent_project_id is distinct from old.parent_project_id then
    raise exception 'Bare Snoat kan endre hvilket prosjekt en dev-side hører til.' using errcode = '42501';
  end if;

  return new;
end;
$$;

drop trigger if exists projects_guard_owner_columns_trigger on public.projects;
create trigger projects_guard_owner_columns_trigger
  before insert or update on public.projects
  for each row execute function public.projects_guard_owner_columns();

-- ---------------------------------------------------------------------------
-- 2. Nye tabeller er ikke lenger åpne for `anon` som standard.
--
-- zzz-01-snoat-roles.sql gir `anon` og `authenticated` alle rettigheter på
-- *fremtidige* tabeller og funksjoner. Alle dagens tabeller har RLS, men én ny
-- tabell som glemmer `enable row level security` ville vært lesbar og skrivbar
-- for alle på internett. `anon` får nå ingenting automatisk; en tabell som skal
-- være åpen for anonyme, må gi rettigheten eksplisitt. Eksisterende grants
-- røres ikke.
-- ---------------------------------------------------------------------------

alter default privileges in schema public revoke all on tables from anon;
alter default privileges in schema public revoke all on functions from anon;
alter default privileges in schema public revoke all on sequences from anon;
alter default privileges for role postgres in schema public revoke all on tables from anon;
alter default privileges for role postgres in schema public revoke all on functions from anon;
alter default privileges for role postgres in schema public revoke all on sequences from anon;
