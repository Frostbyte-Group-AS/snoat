-- Grenen et bygg faktisk kom fra.
--
-- Uten dette feltet fantes svaret bare som en linje inne i byggeloggen
-- («Gren: dev»), og byggelisten kunne ikke si om man så på produksjonsbygget
-- eller dev-bygget. Å utlede det fra `projects.branch` er ikke godt nok: den
-- kan endres i morgen, og da ville historikken påstått at gårsdagens bygg kom
-- fra den nye grenen. Og for et prosjekt uten valgt gren er `projects.branch`
-- NULL – grenen er da repoets standardgren, som bare git kan svare på.
--
-- NULL betyr «vet ikke»: rader fra før denne migrasjonen, og de få tilfellene
-- der klonen aldri kom så langt at grenen kunne leses.
alter table public.deployments
  add column if not exists branch text;

comment on column public.deployments.branch is
  'Grenen bygget kom fra. Settes til projects.branch ved opprettelsen og til den git faktisk sjekket ut etter klonen. NULL for rader fra før 0014.';

-- Byggelisten filtrerer aldri på grenen alene, bare per prosjekt, så det
-- trengs ingen egen indeks her.
