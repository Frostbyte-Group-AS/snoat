-- ---------------------------------------------------------------------------
-- Varsel ved ny registrering: hvorfor det trengs en kolonne
--
-- Drift skal ha én e-post hver gang en ny bruker registrerer seg. Problemet er
-- hvor det varselet kan utløses fra: registreringen skjer i GoTrue, som
-- frontend snakker med direkte (`supabase.auth.signUp`). Backend er ikke i
-- flyten i det hele tatt – på samme måte som opprettelsen av et prosjekt går
-- rett i Supabase gjennom RLS (`CONTEXT_FOR_AI/03_deployment_flow.md`).
--
-- `services/signups.ts` løser det med et periodisk sveip over `profiles` (raden
-- `handle_new_user()` i 0001 oppretter for hver nye bruker i `auth.users`).
-- Denne kolonnen er stedet sveipet krysser av at varselet er sendt, og den
-- finnes fordi et sveip *må* ha idempotens: uten et merke per rad ville hvert
-- sveip sendt e-post om de samme brukerne på nytt, hvert femte minutt, for
-- alltid. Det er samme problem `projects.container_died_at` (0015) løser for
-- helsesveipet, og løsningen er bevisst den samme: tilstanden skrives i basen,
-- ikke i minnet til en prosess som kan restarte.
--
-- Kolonnen er også låsen som gjør sveipet trygt. `signups.ts` gjør et
-- betinget UPDATE (`... where signup_notified_at is null returning id`) *før*
-- e-posten sendes, så en rad kan bare vinnes én gang – to sveip som overlapper
-- gir null varsler for mye, ikke ett. Prisen er at et varsel kan gå tapt hvis
-- selve utsendingen feiler etter at raden er krysset av, og det er den riktige
-- veien å tape på: en tapt e-post er en irritasjon, en e-post hvert femte
-- minutt i evighet er en varsling ingen leser.
--
-- NULL betyr «ikke varslet ennå», ikke «gammel bruker». Derfor backfilles alle
-- eksisterende rader idet kolonnen legges til – ellers ville den første
-- oppstarten etter denne migrasjonen sendt én e-post per bruker som allerede
-- fantes.
-- ---------------------------------------------------------------------------

-- Migrasjonene kjøres på nytt ved hver oppstart (`db-migrate`), så backfillen
-- må skje *kun* den gangen kolonnen faktisk blir til. Sto UPDATE-en fritt i
-- fila, ville hver restart av stacken krysset av brukere som ennå ikke var
-- varslet – altså slettet nøyaktig de varslene kolonnen finnes for å sikre.
do $$
declare
  kolonnen_er_ny boolean;
begin
  kolonnen_er_ny := not exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'profiles'
      and column_name = 'signup_notified_at'
  );

  if kolonnen_er_ny then
    alter table public.profiles add column signup_notified_at timestamptz;

    -- Alle som finnes i det øyeblikket kolonnen opprettes er «gamle nyheter».
    update public.profiles set signup_notified_at = now();
  end if;
end
$$;

comment on column public.profiles.signup_notified_at is
  'Satt av sveipet i backend (services/signups.ts) når drift er varslet om registreringen over Resend. NULL = ikke varslet ennå. Feltet er både kvittering og lås: sveipet vinner raden med et betinget UPDATE før e-posten sendes, slik at samme registrering aldri kan varsles to ganger. Backfilt til now() for alle rader som fantes da migrasjon 0017 kjørte.';

-- Sveipet spør kun etter de uvarslede radene. Indeksen er partiell og derfor i
-- praksis tom – den inneholder bare rader som venter på et varsel – men den gjør
-- spørringen konstant i stedet for en full skann over hele brukertabellen hvert
-- femte minutt.
create index if not exists profiles_signup_unnotified_idx
  on public.profiles (created_at)
  where signup_notified_at is null;

-- PostgREST holder skjemaet i en cache som bare friskes opp ved oppstart eller
-- på dette signalet. `scripts/deploy.sh` kjører `docker compose up -d`, som
-- kjører migrasjonene, men *ikke* restarter `rest` – uten dette ville backend
-- fått «column profiles.signup_notified_at does not exist» fra PostgREST i opptil
-- en restart, og sveipet ville logget en feil hvert femte minutt om en kolonne
-- som faktisk finnes. Kostnaden er én NOTIFY; kanalen `pgrst` er PostgREST sin
-- standard, og signalet er ufarlig om ingen lytter.
notify pgrst, 'reload schema';
