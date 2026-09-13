import { config } from "../config.js";
import { logger } from "../lib/logger.js";
import { supabase } from "../lib/supabase.js";
import { notificationsEnabled, notifyNewSignup } from "./notify.js";

/**
 * Varsel til drift når en ny bruker registrerer seg.
 *
 * ## Problemet: registreringen skjer ikke i backend
 *
 * Frontend snakker med GoTrue direkte (`supabase.auth.signUp`, og
 * `/auth/v1/callback` for GitHub-innlogging). Backend ser ikke forespørselen,
 * har ingen rute den treffer, og får aldri vite noe – nøyaktig samme situasjon
 * som ved *opprettelsen* av et prosjekt, der dashboardet inserter raden rett i
 * Supabase gjennom RLS (se `notifyFirstDeploymentLive` og
 * `CONTEXT_FOR_AI/03_deployment_flow.md`). Det finnes altså ikke noe sted i
 * koden vår der «en ny bruker ble til» er en hendelse vi kan henge et varsel på.
 *
 * ## Valgt løsning: et sveip over `profiles`, med et merke per rad
 *
 * `handle_new_user()` (migrasjon 0001) er en trigger på `auth.users` som
 * oppretter én rad i `public.profiles` for hver nye bruker. Den raden er derfor
 * en fullgod fasit på «hvem har registrert seg», og den ligger i et skjema
 * backend allerede leser med service-role.
 *
 * Sveipet henter de radene som ennå ikke er varslet, krysser dem av med et
 * betinget UPDATE, og sender e-post for dem som faktisk ble vunnet.
 * Avkryssingen er kolonnen `profiles.signup_notified_at` (migrasjon 0017).
 *
 * Intervallet er `SNOAT_SIGNUP_SWEEP_MS`, standard fem minutter. Mønsteret –
 * periodisk sveip, tilstand i basen, varsel kun ved overgangen – er det samme
 * som `services/helse.ts` bruker for containerhelse, og av samme grunn: en
 * prosess som kan restarte kan ikke holde «hva har jeg allerede varslet om» i
 * minnet.
 *
 * ## Alternativene, og hvorfor de ble forkastet
 *
 * **GoTrue-webhook.** Den gamle `GOTRUE_WEBHOOK_URL` med hendelsene
 * `validate`/`signup`/`login` finnes ikke lenger i imaget vi kjører
 * (`supabase/gotrue:v2.193.1`, se `docker-compose.yml`). Det som finnes er
 * Auth Hooks, og de er *definert* av hva de skal brukes til: custom access
 * token, send SMS, send e-post, MFA- og passordforsøk, og «before user
 * created». Ingen av dem er «en bruker ble opprettet»; den nærmeste,
 * before-user-created, kjører **før** raden finnes og er en del av
 * registreringens kritiske sti – et varsel som feiler der ville i verste fall
 * blitt en registrering som feiler. Det bryter regelen som gjelder for alt i
 * `notify.ts`: et varsel skal aldri kunne velte det det varsler om.
 *
 * **Postgres-trigger på `auth.users` som kaller backend via `pg_net`.** Krever
 * at `pg_net` skrus på i databasen, et nytt uautentisert-nok skriveendepunkt i
 * backend med sin egen delte hemmelighet, og at databasen får lov til å ta
 * utgående HTTP-kall til plattform-API-et. Det er tre nye ting som kan feile –
 * og feiler kallet, er varselet tapt uten spor, for en trigger har ingen
 * kø. Vi ville altså byttet ut «fem minutters forsinkelse» med «ny
 * infrastruktur og dårligere garanti».
 *
 * **Realtime-abonnement på `profiles`.** Backend kunne lyttet på INSERT-er over
 * Realtime, som allerede kjører. Men et abonnement hører bare det som skjer
 * mens det er koblet opp: en registrering under en backend-restart eller et
 * nettverksglipp ville aldri blitt varslet, og ingenting hadde fortalt oss det.
 * Sveipet leser tilstand, ikke hendelser, og tar derfor igjen etterslepet av
 * seg selv.
 *
 * ## Om etterslep
 *
 * Sveipet starter ikke uten Resend-konfigurasjon, og migrasjonen krysser av
 * alle brukere som fantes da kolonnen ble laget. Slås varsling *på* senere,
 * sender første sveip derfor én e-post per bruker som registrerte seg i
 * mellomtiden. Det er ikke en feil – det er etterslepet, og det er sannsynligvis
 * det man vil ha.
 */

/**
 * Maks antall registreringer som varsles per sveip.
 *
 * I normal drift kommer det aldri i nærheten av dette. Taket finnes for det
 * unormale tilfellet: skrus varsling på etter en periode uten, ligger det et
 * etterslep, og da skal vi sende det i porsjoner framfor å fyre av hundre
 * HTTP-kall mot Resend i en løkke. Resten tas av neste sveip.
 */
const MAKS_PER_SVEIP = 25;

interface NyRegistrering {
  id: string;
  full_name: string | null;
  created_at: string;
}

/** Ett sveip. Eksportert slik at det kan kjøres manuelt fra et skript. */
export async function sweepNewSignups(): Promise<number> {
  const { data: kandidater, error } = await supabase
    .from("profiles")
    .select("id, full_name, created_at")
    .is("signup_notified_at", null)
    .order("created_at", { ascending: true })
    .limit(MAKS_PER_SVEIP);

  if (error) throw new Error(`Kunne ikke lese nye registreringer: ${error.message}`);

  const rader = (kandidater ?? []) as NyRegistrering[];
  if (rader.length === 0) return 0;

  // Avkryssingen skjer FØR utsendingen, og den er betinget: `is null` i filteret
  // gjør UPDATE-en til en lås, slik at to overlappende sveip (eller to
  // backend-instanser) ikke kan vinne samme rad. `select()` gir oss tilbake kun
  // de radene som faktisk ble vunnet – de andre har noen andre allerede varslet
  // om.
  //
  // Rekkefølgen er et bevisst valg om hvilken feil vi vil ha: krasjer prosessen
  // mellom avkryssing og utsending, taper vi ett varsel. Gjorde vi det motsatt
  // veien, ville en feil i avkryssingen gitt samme e-post hvert femte minutt til
  // noen grep inn. Samme avveining som `container_died_at` i `helse.ts`, der
  // basen også rettes før varselet sendes.
  const { data: vunnet, error: laasFeil } = await supabase
    .from("profiles")
    .update({ signup_notified_at: new Date().toISOString() })
    .in(
      "id",
      rader.map((rad) => rad.id),
    )
    .is("signup_notified_at", null)
    .select("id, full_name, created_at");

  if (laasFeil) throw new Error(`Kunne ikke markere registreringer som varslet: ${laasFeil.message}`);

  const mine = (vunnet ?? []) as NyRegistrering[];

  for (const rad of mine) {
    // `await`, ikke `void`: sveipet har ingen kunde som venter, og noen få
    // Resend-kall etter hverandre er snillere mot API-et enn alle på én gang.
    // Ingenting i `notify.ts` kaster, så løkka kan ikke stoppe halvveis.
    await notifyNewSignup({
      userId: rad.id,
      fullName: rad.full_name,
      createdAt: rad.created_at,
    });

    logger.info({ userId: rad.id }, "Ny registrering – drift er varslet");
  }

  return mine.length;
}

/**
 * Starter sveipet i bakgrunnen.
 *
 * Starter ikke i det hele tatt uten Resend-konfigurasjon. Varsling er en
 * valgfri integrasjon (se `config.ts`), og et sveip som kun kunne ha krysset av
 * rader uten å sende noe ville vært verre enn ingenting: det ville stille spist
 * opp etterslepet, slik at ingen fikk vite om brukerne som registrerte seg mens
 * varslingen var av.
 *
 * `unref()` av samme grunn som i `helse.ts`: en timer som holder Node i live
 * gjør at prosessen nekter å avslutte pent på SIGTERM.
 */
export function startSignupSweep(): void {
  if (!notificationsEnabled()) {
    logger.debug("Varsling er ikke satt opp – signup-sveipet starter ikke");
    return;
  }

  const run = () => {
    void sweepNewSignups().catch((error: unknown) => {
      logger.error({ err: error }, "Signup-sveipet feilet");
    });
  };

  run();
  setInterval(run, config.SNOAT_SIGNUP_SWEEP_MS).unref();

  logger.info(
    { intervalMs: config.SNOAT_SIGNUP_SWEEP_MS },
    "Signup-sveip aktivt – varsler drift om nye registreringer",
  );
}
