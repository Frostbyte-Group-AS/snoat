-- ---------------------------------------------------------------------------
-- Team: flere brukere på samme prosjekt.
--
-- Fram til nå hadde et prosjekt nøyaktig én bruker – `projects.user_id` – og
-- hver tilgangsregel i plattformen var «er du eieren?». Skulle en kollega hjelpe
-- til, var eneste vei å dele innloggingen.
--
-- ## Modellen
--
-- `projects.user_id` er fortsatt **eieren**, og betyr det samme som før: kontoen
-- som betaler, hvis plan og byggeminutter prosjektet bruker, og den eneste som
-- kan slette prosjektet, bytte repo og styre teamet. Ingenting av det flyttes.
--
-- `project_members` legger til **medlemmer**: brukere som kan se prosjektet,
-- deploye, stoppe, endre gren, byggeinnstillinger, miljøvariabler og domene. Det
-- er det en utvikler trenger, og det er bevisst ikke mer. Én rolle, ikke flere:
-- en «lesetilgang»-rolle ble vurdert og forkastet, fordi `projects`-raden – som
-- dashboardet leser rett fra Supabase – har `env_vars` med, og RLS kan ikke
-- skjule én kolonne for noen brukere og ikke for andre. En leserolle som likevel
-- ser alle hemmelighetene er en falsk trygghet.
--
-- Medlemskap gjelder **hovedprosjektet**, og dev-sidene arver det. En dev-side er
-- et miljø for prosjektet (migrasjon 0013), og et team som bare så produksjonen
-- ville vært et halvt team.
--
-- ## Invitasjoner
--
-- Ingen blir medlem uten å si ja selv. Eieren inviterer en **e-postadresse**, og
-- invitasjonen godtas av en innlogget bruker hvis *bekreftede* e-post er nøyaktig
-- den adressen (`routes/team.ts`). Det betyr:
--
--   - Lenken i e-posten er ingen hemmelighet. Videresendes den, kan mottakeren
--     ikke bruke den – hen er ikke logget inn med riktig adresse.
--   - Vi trenger ikke vite om adressen har en konto fra før. Har den ikke det,
--     registrerer hen seg, bekrefter e-posten (krav, se 08_security_model.md) og
--     godtar etterpå.
--   - Ingen token lagres, og ingen kan legges til et team mot sin vilje.
--
-- ## RLS
--
-- Begge tabellene har RLS **uten en eneste policy**, som `api_keys`: all lesing
-- og skriving går gjennom backend. Dashboardet trenger dessuten navn og e-post
-- til de andre i teamet, og de ligger i `auth.users`, som bare backend når.
--
-- Det som endres for nettleseren, er `projects` og `deployments`: medlemmer kan
-- nå lese radene, og oppdatere et avgrenset sett kolonner på prosjektet. Se
-- `projects_guard_member_update()` under.
--
-- Må være idempotent: `db-migrate` kjører alle filene på nytt ved hver oppstart.
-- ---------------------------------------------------------------------------

create table if not exists public.project_members (
  project_id uuid not null references public.projects (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  -- Hvem som inviterte. Kun til visning; NULL når den kontoen er slettet.
  invited_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (project_id, user_id)
);

comment on table public.project_members is
  'Brukere med tilgang til et prosjekt de ikke eier. Kun hovedprosjekter; dev-sidene arver. Kun service_role.';

-- «Hvilke prosjekter er jeg med i?» er oppslaget dashboardet gjør på hver side.
create index if not exists project_members_user_id_idx on public.project_members (user_id);

alter table public.project_members enable row level security;
revoke all on public.project_members from anon, authenticated;

create table if not exists public.project_invitations (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete cascade,
  -- Alltid med små bokstaver. Sammenlignes med den bekreftede e-posten til den
  -- som godtar, og to skrivemåter av samme adresse skal være samme invitasjon.
  email text not null,
  invited_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  -- Sist e-posten ble sendt. Fornyes, sammen med `expires_at`, når eieren sender
  -- invitasjonen på nytt – og er det døgntaket på utsendelser teller på.
  sent_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '14 days'),
  accepted_at timestamptz,
  accepted_by uuid references public.profiles (id) on delete set null,
  declined_at timestamptz,
  revoked_at timestamptz
);

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'project_invitations_email_check') then
    alter table public.project_invitations
      add constraint project_invitations_email_check
      check (email = lower(email) and length(email) <= 254 and email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$');
  end if;
end
$$;

comment on table public.project_invitations is
  'Invitasjoner til et prosjekt, adressert til en e-post. Godtas av brukeren med den bekreftede adressen. Kun service_role.';

-- Én åpen invitasjon per adresse og prosjekt. En ny invitasjon til samme adresse
-- fornyer den som står, i stedet for å legge en ny ved siden av – ellers ville
-- mottakeren fått to like rader å godta.
create unique index if not exists project_invitations_open_unique
  on public.project_invitations (project_id, email)
  where accepted_at is null and declined_at is null and revoked_at is null;

-- «Har noen invitert meg?» slås opp på e-post.
create index if not exists project_invitations_email_idx
  on public.project_invitations (email)
  where accepted_at is null and declined_at is null and revoked_at is null;

-- Taket på hvor mange invitasjoner en konto kan sende per døgn teller på denne.
create index if not exists project_invitations_invited_by_idx
  on public.project_invitations (invited_by, sent_at);

alter table public.project_invitations enable row level security;
revoke all on public.project_invitations from anon, authenticated;

-- ---------------------------------------------------------------------------
-- Medlemskap kun på hovedprosjekter, og aldri for eieren selv.
--
-- Backend sjekker begge deler før den skriver, men service-role-nøkkelen omgår
-- alt annet enn triggere – og en dev-side med egne medlemmer ville gitt et
-- tilgangsbilde ingen skjermer viser.
-- ---------------------------------------------------------------------------

create or replace function public.project_members_check()
returns trigger
language plpgsql
as $$
declare
  target public.projects;
begin
  select * into target from public.projects where id = new.project_id;

  if not found then
    raise exception 'Prosjektet finnes ikke';
  end if;

  if target.parent_project_id is not null then
    raise exception 'Medlemmer legges til på hovedprosjektet, ikke på en dev-side';
  end if;

  if target.user_id = new.user_id then
    raise exception 'Eieren er allerede med i prosjektet';
  end if;

  return new;
end;
$$;

drop trigger if exists project_members_check_trigger on public.project_members;
create trigger project_members_check_trigger
  before insert or update on public.project_members
  for each row execute function public.project_members_check();

-- ---------------------------------------------------------------------------
-- Tilgangsfunksjonen RLS-policyene under bruker.
--
-- `security definer` er nødvendig, ikke en snarvei: policyen på `projects` må
-- slå opp i `project_members`, og funksjonen må lese `projects` for å finne
-- hovedprosjektet til en dev-side. Under RLS ville det første vært stengt (ingen
-- policy) og det andre en rekursjon inn i policyen som kaller den.
--
-- Den svarer bare ja/nei for `auth.uid()` – kalleren selv – og kan ikke brukes
-- til å spørre om andres tilgang.
-- ---------------------------------------------------------------------------

create or replace function public.has_project_access(target uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.projects p
    where p.id = target
      and (
        p.user_id = auth.uid()
        or exists (
          select 1
          from public.project_members m
          where m.project_id = coalesce(p.parent_project_id, p.id)
            and m.user_id = auth.uid()
        )
      )
  );
$$;

revoke all on function public.has_project_access(uuid) from public, anon;
grant execute on function public.has_project_access(uuid) to authenticated, service_role;

-- Eierens policy (`projects_all_own`, 0001) står urørt. Disse kommer i tillegg,
-- og Postgres slipper gjennom en rad når minst én policy sier ja.
drop policy if exists "projects_select_member" on public.projects;
create policy "projects_select_member" on public.projects
  for select to authenticated using (public.has_project_access(id));

drop policy if exists "projects_update_member" on public.projects;
create policy "projects_update_member" on public.projects
  for update to authenticated
  using (public.has_project_access(id))
  with check (public.has_project_access(id));

-- Ingen insert- eller delete-policy for medlemmer. Et prosjekt opprettes på
-- egen konto (`projects_all_own` krever `user_id = auth.uid()`), og slettes
-- gjennom `DELETE /api/projects/:id`, som bare eieren slipper gjennom.

drop policy if exists "deployments_select_member" on public.deployments;
create policy "deployments_select_member" on public.deployments
  for select to authenticated using (public.has_project_access(project_id));

-- ---------------------------------------------------------------------------
-- Hva et medlem kan endre direkte på raden.
--
-- Dashboardet skriver prosjektraden selv, med brukerens sesjon (miljøvariabler og
-- byggeinnstillinger). RLS er rad-nivå og kan ikke skille kolonner, så uten
-- denne triggeren kunne et medlem kjørt `update projects set user_id = <seg selv>`
-- fra nettleserkonsollen og tatt over prosjektet – eller byttet `repo_url` til et
-- annet privat repo eieren har gitt Snoat tilgang til, og fått det klonet med
-- eierens installasjonstoken.
--
-- Regelen er en allowlist og ikke en blokkliste: en kolonne som legges til
-- `projects` i morgen, er stengt for medlemmer til noen bevisst åpner den.
--
-- Gjelder bare innloggede brukere som ikke er eieren. Eieren og backend
-- (service_role, der `auth.uid()` er NULL) går som før.
-- ---------------------------------------------------------------------------

create or replace function public.projects_guard_member_update()
returns trigger
language plpgsql
as $$
declare
  editable text[] := array[
    'branch',
    'build_command',
    'env_vars',
    'static_output_dir',
    'static_spa_fallback'
  ];
begin
  if auth.uid() is null or auth.uid() = old.user_id then
    return new;
  end if;

  if (to_jsonb(new) - editable) is distinct from (to_jsonb(old) - editable) then
    raise exception 'Bare eieren av prosjektet kan endre dette.'
      using errcode = '42501';
  end if;

  return new;
end;
$$;

drop trigger if exists projects_guard_member_update_trigger on public.projects;
create trigger projects_guard_member_update_trigger
  before update on public.projects
  for each row execute function public.projects_guard_member_update();
