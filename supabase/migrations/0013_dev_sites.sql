-- ---------------------------------------------------------------------------
-- Dev-sider: en passordbeskyttet utgave av appen fra en annen gren.
--
-- Behovet er det motsatte av grenvalget i 0012. Der byttet man *hvilken* gren
-- prosjektet deployer fra; her vil kunden ha begge samtidig – `main` på domenet
-- kundene ser, og `dev` på en adresse bare teamet kommer inn på.
--
-- ## Hvorfor en søskenrad og ikke en environments-tabell
--
-- Nesten alt i plattformen slår opp på `projects.name`: `tls-ask` avgjør
-- sertifikater ut fra den, `upsertAppRoute` navngir Caddy-ruten etter den,
-- analytics-ingesten kobler et vertsnavn til et prosjekt gjennom den, og
-- `assertCanDeploy` teller kjørende containere per prosjektrad. Et miljø som
-- *er* en prosjektrad arver alt dette gratis.
--
-- Push-webhooken er det tydeligste eksemplet: den henter alle prosjekter på
-- repoet og spør per rad om grenen stemmer (`isDeployBranch`). To rader på samme
-- repo med ulik gren gir derfor riktig oppførsel – push til `dev` bygger bare
-- dev-siden, push til `main` bare hovedsiden – uten en linje endret der.
--
-- En egen `environments`-tabell ville vært ryddigere som modell, men måtte rørt
-- ruting, containernavn, hostmap, plangrenser og hele dashboardet for å komme
-- dit denne migrasjonen kommer med to kolonner.
--
-- ## Hva kolonnene betyr
--
-- `parent_project_id` er hva raden er et miljø *for*. NULL = et vanlig prosjekt,
-- altså alle rader som finnes i dag. Satt = en dev-side, og da er forelderen den
-- som eier domenet og som dashboardet viser den under.
--
-- `access_protected` sier bare *at* appen er beskyttet. Selve hashen ligger i
-- `project_access`, en egen tabell uten en eneste RLS-policy for `authenticated`.
--
-- Delingen er ikke ryddighet. Dashboardet leser `projects` **direkte** fra
-- Supabase gjennom RLS (`routes/dashboard.tsx`), så en kolonne på den raden er en
-- kolonne som havner i nettleseren. En bcrypt-hash er ikke et passord, men den er
-- et offline angrepsmål, og den har ingenting å gjøre i en JS-bundle eller i en
-- modellkontekst. Boolean-en er alt UI-et trenger for å tegne en hengelås.
--
-- Prisen er at to felt må holdes i takt. Det skjer på ett sted –
-- `setAccessPassword()` i `services/dev-sites.ts` – og aldri noe annet sted.
--
-- Muligheten ligger på `projects` og ikke på dev-sider spesielt, fordi «legg et
-- passord foran denne appen» er nyttig for et hvilket som helst prosjekt: en
-- kundedemo, en app som ikke er klar. Dev-siden er bare den første som bruker den.
--
-- Må være idempotent: `db-migrate` kjører alle filene på nytt ved hver oppstart.
-- ---------------------------------------------------------------------------

alter table public.projects
  add column if not exists parent_project_id uuid references public.projects (id) on delete cascade;

comment on column public.projects.parent_project_id is
  'Prosjektet denne raden er et miljø for. NULL = et ordinært prosjekt. Satt = en dev-side, og forelderen eier domenet.';

alter table public.projects
  add column if not exists access_protected boolean not null default false;

comment on column public.projects.access_protected is
  'Sant når appen krever passord. Selve hashen ligger i project_access, som kun service_role kan lese.';

-- ---------------------------------------------------------------------------
-- Hashen, utenfor rekkevidde for klienten.
--
-- RLS er slått på og det finnes **ingen** policy. For `authenticated` betyr det
-- at tabellen er tom uansett hva man spør om; `service_role` omgår RLS og er
-- dermed den eneste som ser innholdet. Det er hele poenget: backend skriver
-- hashen og sender den til Caddy, og ingen annen vei inn finnes.
-- ---------------------------------------------------------------------------

create table if not exists public.project_access (
  project_id uuid primary key references public.projects (id) on delete cascade,
  password_hash text not null,
  updated_at timestamptz not null default now()
);

comment on table public.project_access is
  'bcrypt-hash for passordbeskyttede apper. Kun service_role – ingen RLS-policy, med vilje.';

alter table public.project_access enable row level security;

-- Oppslaget «hvilke miljøer hører til dette prosjektet» går for hver visning av
-- prosjektsiden. Uten indeksen er det en full sekvensiell skanning av tabellen.
create index if not exists projects_parent_project_id_idx
  on public.projects (parent_project_id)
  where parent_project_id is not null;

-- En rad kan ikke være sitt eget miljø. Uten dette er `parent_project_id = id`
-- en lovlig rad, og enhver rekursjon over treet – dashboardet som grupperer,
-- oppryddingen som følger cascade – går i evig løkke på den.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'projects_parent_not_self_check'
  ) then
    alter table public.projects
      add constraint projects_parent_not_self_check check (parent_project_id is null or parent_project_id <> id);
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- Dybde 1: en dev-side kan ikke selv ha dev-sider.
--
-- En check-constraint kan ikke slå opp i en annen rad, så dette er en trigger.
-- Grunnen til at grensen finnes i det hele tatt er ikke ryddighet: hvert nivå i
-- treet er et vertsnavn, en container og en plass i byggekøen, og et tre uten
-- tak er en konto som kan lage seg selv uendelig mange apper ved å bygge
-- nedover. `assertCanDeploy` teller kjørende apper og stopper det til slutt,
-- men først etter at radene er skrevet.
--
-- Vi sjekker også at eieren er den samme. `parent_project_id` er en fremmednøkkel
-- uten noen betingelse om `user_id`, så uten dette kunne en rad pekt på en annen
-- brukers prosjekt – og dashboardet ville vist dev-siden under et prosjekt
-- eieren ikke har.
--
-- Funksjonen er med vilje **ikke** `security definer`. Da leses `projects` med
-- kallerens rettigheter, altså under RLS for en innlogget bruker, og et forsøk på
-- å peke på en annen brukers prosjekt får «finnes ikke» i stedet for «feil eier».
-- Det er det riktige svaret: det avslører ikke at raden finnes. Eier-sjekken har
-- likevel en jobb, for backend bruker service-role-nøkkelen og omgår RLS.
-- ---------------------------------------------------------------------------

create or replace function public.projects_parent_is_root()
returns trigger
language plpgsql
as $$
declare
  parent_row public.projects;
begin
  if new.parent_project_id is null then
    return new;
  end if;

  select * into parent_row from public.projects where id = new.parent_project_id;

  if not found then
    raise exception 'Forelderprosjektet finnes ikke';
  end if;

  if parent_row.parent_project_id is not null then
    raise exception 'En dev-side kan ikke ha egne dev-sider';
  end if;

  if parent_row.user_id <> new.user_id then
    raise exception 'Dev-siden må ha samme eier som prosjektet';
  end if;

  return new;
end;
$$;

drop trigger if exists projects_parent_is_root_trigger on public.projects;
create trigger projects_parent_is_root_trigger
  before insert or update of parent_project_id, user_id on public.projects
  for each row execute function public.projects_parent_is_root();
