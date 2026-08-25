-- ---------------------------------------------------------------------------
-- Hvilken gren prosjektet deployes fra.
--
-- Fram til nå har Snoat kunnet én gren: repoets egen. `git clone --depth 1`
-- uten `--branch` henter default branch, og webhooken bygget kun ved push til
-- `default_branch`. For alle som holder `main` produksjonsklar er det riktig –
-- men ikke for dem som gjør det motsatte, og de er ikke få: et repo der `main`
-- er kundens egen kode og `dev` er det som skal stå på nett, en kunde som vil se
-- neste versjon på et eget subdomene før den slås sammen, et repo Snoat deler
-- med en annen plattform som eier `main`.
--
-- Uten kolonnen fantes det ingen vei rundt det. Å bytte default branch på GitHub
-- er ikke et alternativ: den styrer pull requests, beskyttelsesregler og
-- klonestandarden for alle som jobber i repoet – langt mer enn hva Snoat skal
-- bygge.
--
-- **NULL betyr «bruk repoets default branch».** Det er ikke latskap, det er den
-- eneste verdien som ikke kan bli feil: hadde vi backfill-et med `'main'`,
-- ville hvert eksisterende prosjekt med en annen hovedgren – `master`, `trunk`,
-- `produksjon` – sluttet å deploye i samme øyeblikk migrasjonen kjørte. NULL
-- bevarer dagens oppførsel for alle rader som finnes, og lar GitHub fortsette å
-- være autoriteten for dem som ikke har valgt noe.
--
-- Merk at kolonnen ikke er unik sammen med `repo_url`, og heller ikke skal være
-- det. Flere prosjekter kan peke på samme repo med *ulik* gren – det er nettopp
-- «se `dev` på et eget subdomene»-tilfellet – og webhooken avgjør per prosjekt
-- hvem en push angår.
--
-- Må være idempotent: `db-migrate` kjører alle filene på nytt ved hver oppstart.
-- ---------------------------------------------------------------------------

alter table public.projects
  add column if not exists branch text;

comment on column public.projects.branch is
  'Grenen som klones og deployes. NULL = bruk repoets default branch (GitHub avgjør). Styrer også hvilke push-events webhooken bygger på.';

-- Verdien går inn som `--branch <verdi>` i et `git clone`-argument, og den
-- kommer fra brukeren. Det er samme angrepsflate som `repo_url`: git tolker et
-- argument som starter med `-` som en opsjon, og `--upload-pack=…` gjør en
-- klone til vilkårlig kommandokjøring på verten. Regexet krever derfor at første
-- tegn er en bokstav, et tall eller en understrek – da finnes det ingen vei til
-- en bindestrek i posisjon én, og heller ikke til en sti-komponent som starter
-- med punktum (som git selv avviser).
--
-- Resten av reglene er git sine egne fra `git check-ref-format`, i konservativ
-- form: ingen `..`, ingen tom sti-komponent, ikke avsluttende skråstrek, ikke
-- `.lock`-suffiks og ingen `@{`-refspec. Vi tillater med vilje mindre enn git
-- gjør – ingen `~^:?*[`, ingen mellomrom, ingen kontrolltegn – fordi et grennavn
-- som trenger dem er sjeldnere enn et grennavn som er et angrep.
--
-- Taket på 255 tegn er praktisk: navnet blir også en del av kommandolinjen vi
-- logger, og ingen reell gren er lengre.
--
-- `assertSafeBranch()` i `backend/src/services/git.ts` validerer det samme på
-- nytt, og det er ikke dobbeltarbeid: service-role-nøkkelen backend bruker
-- omgår ikke bare RLS, den omgår også denne constrainten hvis noen skriver
-- direkte. Constrainten er vernet mot dashboardet, som skriver raden selv med
-- brukerens egen sesjon.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'projects_branch_check'
  ) then
    alter table public.projects
      add constraint projects_branch_check check (
        branch is null
        or (
          branch ~ '^[A-Za-z0-9_][A-Za-z0-9._/-]{0,254}$'
          and branch !~ '\.\.'
          and branch !~ '//'
          and branch !~ '/$'
          and branch !~ '\.lock$'
          and branch !~ '@\{'
        )
      );
  end if;
end
$$;
