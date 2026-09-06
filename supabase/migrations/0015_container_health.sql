-- ---------------------------------------------------------------------------
-- Containerhelse: databasen kan lyve om egen tilstand, og gjorde det.
--
-- `eierfullstack` sto som `success`/Live i produksjon lenge etter at
-- containeren var borte fra Docker (0B/0B i `docker stats`, 502 fra Caddy).
-- To ting gjorde at ingen merket det: helsesjekken ved utrulling er ett
-- øyeblikksbilde rett etter oppstart og ser aldri på appen igjen, og
-- `reconcileRoutes()` kjører kun ved backend-oppstart – dør containeren en
-- time senere, oppdager ingenting det før neste restart av backend.
--
-- `services/helse.ts` retter dette med et periodisk sveip som sammenligner hva
-- denne raden påstår kjører mot hva Docker faktisk har. Denne kolonnen er
-- stedet avviket skrives, slik at det rettes i basen – ikke bare logges og
-- glemmes.
--
-- NULL er «ingen kjent avvik akkurat nå», ikke «aldri sjekket» – et prosjekt
-- som aldri har hatt en vellykket deployment er aldri en kandidat for sveipet
-- (se `helse.ts`), og skal ikke se ut som det har blitt friskmeldt.
alter table public.projects
  add column if not exists container_died_at timestamptz;

comment on column public.projects.container_died_at is
  'Satt av det periodiske sveipet i services/helse.ts når containeren prosjektet skal ha kjørende er borte fra Docker, selv om prosjektet ikke er stoppet (stopped_at) og har en vellykket deployment. NULL = ingen kjent avvik. Nullstilles av samme sveip når containeren er tilbake, av en ny vellykket deployment, og av et stopp brukeren selv ber om.';

-- Sveipet spør «hvilke ikke-stoppede prosjekter finnes» hvert par minutter.
-- `stopped_at is null` er allerede indeksert via `idx_projects_user_id`? Nei –
-- det er det ikke, men prosjekttabellen er liten (én rad per prosjekt, ikke
-- per deployment), så en sekvensiell skann her koster ingenting i praksis.
-- Ingen ny indeks er derfor lagt til.
