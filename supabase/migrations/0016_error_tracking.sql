-- ---------------------------------------------------------------------------
-- Feilsporing: det analytikken kunne telle, men aldri fortelle
--
-- `rollup_hourly` vet at appen svarte 5xx tolv ganger i går. Den vet ikke hva
-- som feilet, i hvilken fil, på hvilken linje, eller om det er tolv ulike feil
-- eller samme feil tolv ganger. Det er akkurat den forskjellen mellom «noe er
-- galt» og «dette er galt» som avgjør om noen faktisk retter den.
--
-- Modellen har to nivåer, av samme grunn som Sentry har det:
--
--   `errors.groups`  – én rad per distinkt feil, med teller. Det er denne et
--                      menneske eller en agent leser. Tolv like krasj er én rad
--                      med `events = 12`, ikke tolv rader å vasse gjennom.
--   `errors.events`  – de siste konkrete forekomstene i en gruppe, med
--                      stacktrace. Nødvendig for å faktisk skrive fiksen, men
--                      dyrt å lagre, så halen kuttes hardt (se `errors_prune`).
--
-- Grupperingen er en fingerprint, ikke meldingen. To krasj med teksten
-- «Cannot read properties of undefined (reading 'id')» fra hver sin fil er to
-- forskjellige feil; samme feil i samme fil med to ulike objekt-IDer i teksten
-- er én. Normaliseringen som gjør det mulig ligger i backend
-- (`services/error-ingest.ts`), fordi den må kunne endres uten en migrasjon.
--
-- ## Personvern
--
-- Feilsporing er farligere enn trafikkstatistikk: en stacktrace kan inneholde
-- hva som helst appen hadde i minnet. Tre regler er derfor bygget inn i
-- skjemaet, ikke bare i koden som skriver til det:
--
--   * Ingen IP-adresse lagres. Ikke hashet heller – det finnes ingen kolonne.
--   * Ingen rå User-Agent. Kun `browser` og `os`, samme parsede verdier som
--     analytikken allerede viser.
--   * `url` lagres uten query-streng. Tokens og e-postadresser ligger i
--     query-strenger oftere enn noen liker å tro.
--
-- Redigeringen skjer i backend før raden når hit. Kolonnene under finnes ikke
-- for det som ikke skal lagres, slik at en framtidig feil i den koden blir en
-- databasefeil og ikke en stille lekkasje.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 1. Skjema
--
-- Utenfor `public`, av samme grunn som `analytics`: PostgREST eksponerer kun
-- `public`, så ingen av tabellene under er nåbare fra en nettleser uansett hva
-- som skulle skje med RLS senere. Dashboardet leser gjennom backend, som går
-- veien om funksjonene nederst i fila.
-- ---------------------------------------------------------------------------
create schema if not exists errors;

-- ---------------------------------------------------------------------------
-- 2. Feilgrupper
--
-- `fingerprint` er sha256 over (kind ‖ normalisert melding ‖ fil ‖ linje), 32
-- byte. Den regnes i backend og er unik per prosjekt – samme feil i to apper er
-- to grupper, fordi de har hver sin kodebase og hver sin fiks.
--
-- `first_deployment_id` er det feltet som gjør en fiks rask å skrive: den sier
-- hvilken utrulling feilen dukket opp i, og dermed hvilket diff som innførte
-- den. Den er `on delete set null` og ikke `cascade` – at en gammel deployment
-- ryddes bort skal ikke ta feilhistorikken med seg.
-- ---------------------------------------------------------------------------
create table if not exists errors.groups (
  id           uuid        primary key default gen_random_uuid(),
  project_id   uuid        not null references public.projects(id) on delete cascade,
  fingerprint  bytea       not null,

  -- Hvor feilen ble observert. Bestemmer hvilke felter som er utfylt:
  --   client  – i nettleseren. Har fil/linje/kolonne fra stacktracen.
  --   server  – ufanget unntak i appens egen prosess (stderr).
  --   crash   – containeren døde. Ingen fil/linje, men exit-kode i `message`.
  --   http    – vedvarende 5xx fra proxyen uten at noe av det over ble fanget.
  kind         text        not null check (kind in ('client', 'server', 'crash', 'http')),

  message      text        not null,
  -- Fil og linje er null for `crash`, og kan være null for `client` når appen
  -- er bygget uten source maps og feilen kom fra en cross-origin-ressurs.
  file         text,
  line         integer,
  col          integer,

  first_seen   timestamptz not null default now(),
  last_seen    timestamptz not null default now(),
  events       bigint      not null default 0,

  -- `open` til noen tar tak i den. `resolved` settes av dashboardet eller av
  -- patch-agenten når PR-en er merget. `ignored` er «vi vet, og vi bryr oss
  -- ikke» – typisk utvidelser i nettleseren som kaster i vår kontekst.
  status       text        not null default 'open'
                           check (status in ('open', 'resolved', 'ignored')),
  resolved_at  timestamptz,

  -- Satt av patch-agenten, slik at neste kjøring ikke lager PR nummer to på en
  -- feil den allerede har foreslått en fiks for.
  patch_pr_url text,

  first_deployment_id uuid references public.deployments(id) on delete set null,
  last_deployment_id  uuid references public.deployments(id) on delete set null,

  unique (project_id, fingerprint)
);

-- To spørringer finnes: dashboardet («åpne grupper for dette prosjektet, nyeste
-- først») og agenten («alt som er nytt siden i går, på tvers av prosjekter»).
create index if not exists groups_project_status_idx
  on errors.groups (project_id, status, last_seen desc);

create index if not exists groups_recent_idx
  on errors.groups (last_seen desc)
  where status = 'open';

-- ---------------------------------------------------------------------------
-- 3. Forekomster
--
-- Stacktracene. Kun de nyeste per gruppe overlever `errors_prune`; poenget er
-- å ha nok kontekst til å skrive fiksen, ikke å arkivere hver forekomst.
--
-- `bigserial` og ikke uuid: tabellen er den eneste her som kan få mange rader
-- per sekund, og innsettingsrekkefølgen er nyttig når halen skal kuttes.
-- ---------------------------------------------------------------------------
create table if not exists errors.events (
  id            bigserial   primary key,
  group_id      uuid        not null references errors.groups(id) on delete cascade,
  at            timestamptz not null default now(),

  -- Trunkeres i backend. En uendelig rekursjon produserer en stacktrace på
  -- flere megabyte, og de nederste hundre rammene sier det samme som de øverste.
  stack         text,

  -- Sti uten query-streng, av personvernhensyn. Se toppen av fila.
  url           text,
  -- Parsede verdier, aldri rå User-Agent.
  browser       text,
  os            text,

  deployment_id uuid references public.deployments(id) on delete set null
);

create index if not exists events_group_at_idx
  on errors.events (group_id, at desc);

-- ---------------------------------------------------------------------------
-- 4. RLS
--
-- Belte og bukseseler, som i analytics: tabellene ligger utenfor det PostgREST
-- eksponerer, og RLS uten policy betyr at ingen slipper til. `service_role` og
-- security definer-funksjonene under går utenom, og de er de eneste veiene inn.
-- ---------------------------------------------------------------------------
alter table errors.groups enable row level security;
alter table errors.events enable row level security;

-- ---------------------------------------------------------------------------
-- 5. Ingest
--
-- Samme form som `analytics_ingest_batch`: backend aggregerer i minnet noen
-- sekunder og sender én jsonb. En app i uendelig krasj-løkke blir dermed noen
-- få rader per flush i stedet for tusenvis av INSERT-er.
--
--   {
--     "groups": [{project_id, fingerprint (hex), kind, message, file, line,
--                 col, last_seen, events}],
--     "events": [{project_id, fingerprint (hex), at, stack, url, browser, os}]
--   }
--
-- Forekomstene refererer gruppa si med (project_id, fingerprint) og ikke med
-- en id, fordi backend ikke vet gruppe-id-en før denne funksjonen har kjørt.
-- Gruppene settes derfor inn først, i samme setning.
--
-- Utrullingen feilen tilhører sendes *ikke* med fra backend. Den slås opp her,
-- som «nyeste vellykkede deployment for prosjektet akkurat nå». Alternativet
-- var en cache i backend som måtte holdes synkronisert med deploy-pipelinen, og
-- den ville tatt feil i nøyaktig det vinduet der det betyr mest: minuttene rett
-- etter en utrulling, som er når nye feil faktisk dukker opp.
--
-- Joinen mot `public.projects` er ikke pynt: et prosjekt kan slettes mellom
-- feilen og flushen, og uten den ville en fremmednøkkelfeil forkastet hele
-- batchen for alle de andre prosjektene.
-- ---------------------------------------------------------------------------
create or replace function public.errors_ingest_batch(payload jsonb)
returns void
language plpgsql
security definer
set search_path = public, errors, pg_temp
as $$
declare
  v_groups jsonb := coalesce(payload -> 'groups', '[]'::jsonb);
  v_events jsonb := coalesce(payload -> 'events', '[]'::jsonb);
begin
  -- Gruppene.
  --
  -- `first_seen` og `first_deployment_id` settes kun ved innsetting og røres
  -- aldri av oppdateringen: de er definisjonen av «når begynte dette», og en
  -- feil som blusser opp igjen skal ikke se ut som den akkurat oppsto.
  --
  -- En `resolved` gruppe som får en ny forekomst åpnes igjen. Det er det eneste
  -- ærlige svaret – fiksen virket ikke, eller feilen har en ny årsak – og uten
  -- det ville en lukket gruppe vært et permanent blindpunkt.
  insert into errors.groups as g (
    project_id, fingerprint, kind, message, file, line, col,
    first_seen, last_seen, events, first_deployment_id, last_deployment_id
  )
  select (e ->> 'project_id')::uuid,
         decode(e ->> 'fingerprint', 'hex'),
         e ->> 'kind',
         e ->> 'message',
         e ->> 'file',
         (e ->> 'line')::integer,
         (e ->> 'col')::integer,
         (e ->> 'last_seen')::timestamptz,
         (e ->> 'last_seen')::timestamptz,
         (e ->> 'events')::bigint,
         d.id,
         d.id
    from jsonb_array_elements(v_groups) as e
    join public.projects p on p.id = (e ->> 'project_id')::uuid
    left join lateral (
      select dep.id
        from public.deployments dep
       where dep.project_id = p.id
         and dep.status     = 'success'
       order by dep.created_at desc
       limit 1
    ) d on true
  on conflict (project_id, fingerprint) do update set
    last_seen          = greatest(g.last_seen, excluded.last_seen),
    events             = g.events + excluded.events,
    last_deployment_id = coalesce(excluded.last_deployment_id, g.last_deployment_id),
    -- Meldingen oppdateres slik at gruppa viser den nyeste varianten. Fil og
    -- linje er derimot en del av fingerprinten og kan ikke endre seg.
    message            = excluded.message,
    status             = case when g.status = 'ignored' then 'ignored' else 'open' end,
    resolved_at        = case when g.status = 'ignored' then g.resolved_at else null end;

  -- Forekomstene.
  insert into errors.events (group_id, at, stack, url, browser, os, deployment_id)
  select g.id,
         (e ->> 'at')::timestamptz,
         e ->> 'stack',
         e ->> 'url',
         e ->> 'browser',
         e ->> 'os',
         g.last_deployment_id
    from jsonb_array_elements(v_events) as e
    join errors.groups g
      on g.project_id  = (e ->> 'project_id')::uuid
     and g.fingerprint = decode(e ->> 'fingerprint', 'hex');
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. Uthenting for dashboardet
--
-- Eierskapssjekken ligger i backend (`loadOwnedProject`), som er den eneste som
-- kan kalle denne – se GRANT-ene nederst.
-- ---------------------------------------------------------------------------
create or replace function public.errors_list(
  p_project_id uuid,
  p_status     text default 'open',
  p_limit      integer default 50,
  p_stacks     integer default 1
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, errors, pg_temp
as $$
declare
  v_rows jsonb;
begin
  select coalesce(jsonb_agg(row order by (row ->> 'last_seen') desc), '[]'::jsonb)
    into v_rows
    from (
      select jsonb_build_object(
               'id',           g.id,
               'kind',         g.kind,
               'message',      g.message,
               'file',         g.file,
               'line',         g.line,
               'col',          g.col,
               'first_seen',   g.first_seen,
               'last_seen',    g.last_seen,
               'events',       g.events,
               'status',       g.status,
               'patch_pr_url', g.patch_pr_url,
               'first_deployment_id', g.first_deployment_id,
               -- De nyeste stacktracene, ikke alle. Dashboardet viser én;
               -- agenten ber om flere for å se om feilen har ulike veier inn.
               'stacks', coalesce((
                 select jsonb_agg(jsonb_build_object(
                          'at',      ev.at,
                          'stack',   ev.stack,
                          'url',     ev.url,
                          'browser', ev.browser,
                          'os',      ev.os
                        ) order by ev.at desc)
                   from (
                     select * from errors.events
                      where group_id = g.id
                      order by at desc
                      limit greatest(p_stacks, 0)
                   ) ev
               ), '[]'::jsonb)
             ) as row
        from errors.groups g
       where g.project_id = p_project_id
         and (p_status = 'all' or g.status = p_status)
       order by g.last_seen desc
       limit greatest(p_limit, 1)
    ) s;

  return v_rows;
end;
$$;

-- ---------------------------------------------------------------------------
-- 7. Uthenting for agenten
--
-- Forskjellen fra `errors_list` er at denne går på tvers av prosjekter og
-- filtrerer på tid: «hva er nytt siden forrige kjøring». `p_project_ids` er
-- prosjektene den kallende brukeren eier – utvalget gjøres i backend, som er
-- det eneste stedet som kjenner eierskapet.
--
-- `p_min_events` finnes fordi en feil som har truffet én gang kan være en
-- nettleserutvidelse eller en bot som prøvde noe rart. Terskelen holder
-- engangsstøy ute av PR-strømmen uten å skjule den i dashboardet.
-- ---------------------------------------------------------------------------
create or replace function public.errors_recent(
  p_project_ids uuid[],
  p_since       timestamptz,
  p_min_events  integer default 1,
  p_limit       integer default 50,
  p_stacks      integer default 3
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, errors, pg_temp
as $$
declare
  v_rows jsonb;
begin
  select coalesce(jsonb_agg(row order by (row ->> 'events')::bigint desc), '[]'::jsonb)
    into v_rows
    from (
      select jsonb_build_object(
               'id',           g.id,
               'project_id',   g.project_id,
               'project',      p.name,
               'repo_url',     p.repo_url,
               'branch',       p.branch,
               'kind',         g.kind,
               'message',      g.message,
               'file',         g.file,
               'line',         g.line,
               'col',          g.col,
               'first_seen',   g.first_seen,
               'last_seen',    g.last_seen,
               'events',       g.events,
               'patch_pr_url', g.patch_pr_url,
               -- Utrullingen feilen dukket opp i. Commit-hashen er det agenten
               -- trenger for å se hvilket diff som innførte den.
               'introduced_by', case
                 when d.id is null then null
                 else jsonb_build_object(
                        'deployment_id', d.id,
                        'commit_hash',   d.commit_hash,
                        'created_at',    d.created_at
                      )
               end,
               'stacks', coalesce((
                 select jsonb_agg(jsonb_build_object(
                          'at',      ev.at,
                          'stack',   ev.stack,
                          'url',     ev.url,
                          'browser', ev.browser,
                          'os',      ev.os
                        ) order by ev.at desc)
                   from (
                     select * from errors.events
                      where group_id = g.id
                      order by at desc
                      limit greatest(p_stacks, 0)
                   ) ev
               ), '[]'::jsonb)
             ) as row
        from errors.groups g
        join public.projects p on p.id = g.project_id
        left join public.deployments d on d.id = g.first_deployment_id
       where g.project_id = any(p_project_ids)
         and g.status     = 'open'
         and g.last_seen >= p_since
         and g.events    >= greatest(p_min_events, 1)
       order by g.events desc
       limit greatest(p_limit, 1)
    ) s;

  return v_rows;
end;
$$;

-- ---------------------------------------------------------------------------
-- 8. Statusendring
--
-- Én funksjon for både dashboardet og agenten. `p_pr_url` settes kun av
-- agenten, og kun når den faktisk åpnet en PR – den er sperren mot at neste
-- nattkjøring lager PR nummer to på samme feil.
--
-- `p_project_ids` er prosjektene kalleren eier, og står i WHERE-setningen og
-- ikke i en sjekk etterpå. Forskjellen er reell: en gruppe-ID er en uuid som
-- kommer utenfra, og uten dette måtte rutelaget skrevet først og rullet tilbake
-- hvis eieren viste seg å være en annen. Da er endringen allerede skjedd, om
-- enn kortvarig, og «rull tilbake» er et steg som kan feile.
-- ---------------------------------------------------------------------------
create or replace function public.errors_set_status(
  p_group_id    uuid,
  p_status      text,
  p_project_ids uuid[],
  p_pr_url      text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, errors, pg_temp
as $$
declare
  v_row errors.groups;
begin
  if p_status not in ('open', 'resolved', 'ignored') then
    raise exception 'Ukjent status: %', p_status;
  end if;

  update errors.groups
     set status       = p_status,
         resolved_at  = case when p_status = 'open' then null else now() end,
         patch_pr_url = coalesce(p_pr_url, patch_pr_url)
   where id = p_group_id
     and project_id = any(p_project_ids)
  returning * into v_row;

  if v_row.id is null then
    return null;
  end if;

  return jsonb_build_object(
    'id',           v_row.id,
    'project_id',   v_row.project_id,
    'status',       v_row.status,
    'patch_pr_url', v_row.patch_pr_url
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 9. Sletting etter lagringsbegrensning
--
-- Tre kutt, i rekkefølge etter hvor mye plass de frigjør:
--
--   * Forekomster eldre enn `p_event_days`. Stacktracene er det store.
--   * Halen per gruppe: kun de `p_events_per_group` nyeste beholdes, uansett
--     alder. En feil som skjer tusen ganger i timen skal ikke kunne fylle
--     disken alene mellom to nattkjøringer.
--   * Løste grupper som ikke er sett på lenge. Åpne grupper slettes aldri –
--     en feil ingen har rettet er fortsatt en feil, uansett hvor gammel.
--
-- Idempotent, som `analytics_prune`, og kalles fra samme timessveip.
-- ---------------------------------------------------------------------------
create or replace function public.errors_prune(
  p_event_days       integer default 30,
  p_events_per_group integer default 20,
  p_resolved_days    integer default 90
)
returns jsonb
language plpgsql
security definer
set search_path = public, errors, pg_temp
as $$
declare
  v_old      bigint;
  v_trimmed  bigint;
  v_groups   bigint;
begin
  delete from errors.events
   where at < now() - make_interval(days => p_event_days);
  get diagnostics v_old = row_count;

  with ranked as (
    select id,
           row_number() over (partition by group_id order by at desc) as rank
      from errors.events
  )
  delete from errors.events e
   using ranked r
   where e.id = r.id
     and r.rank > greatest(p_events_per_group, 1);
  get diagnostics v_trimmed = row_count;

  delete from errors.groups
   where status <> 'open'
     and last_seen < now() - make_interval(days => p_resolved_days);
  get diagnostics v_groups = row_count;

  return jsonb_build_object(
    'events_expired', v_old,
    'events_trimmed', v_trimmed,
    'groups_removed', v_groups
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 10. Rettigheter
--
-- Funksjonene er `security definer` og ligger i `public`, som PostgREST
-- eksponerer. Uten disse revoke-ene kunne en hvilken som helst innlogget bruker
-- kalt dem fra nettleseren: `errors_ingest_batch` for å dikte opp feil,
-- `errors_recent` for å lese en fremmed kundes stacktraces – som er langt verre
-- enn å lese trafikktallene deres.
-- ---------------------------------------------------------------------------
revoke all on function public.errors_ingest_batch(jsonb) from public, anon, authenticated;
revoke all on function public.errors_list(uuid, text, integer, integer) from public, anon, authenticated;
revoke all on function public.errors_recent(uuid[], timestamptz, integer, integer, integer) from public, anon, authenticated;
revoke all on function public.errors_set_status(uuid, text, uuid[], text) from public, anon, authenticated;
revoke all on function public.errors_prune(integer, integer, integer) from public, anon, authenticated;

grant execute on function public.errors_ingest_batch(jsonb) to service_role;
grant execute on function public.errors_list(uuid, text, integer, integer) to service_role;
grant execute on function public.errors_recent(uuid[], timestamptz, integer, integer, integer) to service_role;
grant execute on function public.errors_set_status(uuid, text, uuid[], text) to service_role;
grant execute on function public.errors_prune(integer, integer, integer) to service_role;
