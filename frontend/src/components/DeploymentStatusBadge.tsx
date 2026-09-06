import type { DeploymentStatus } from "@/lib/database.types";

/**
 * Status som firkantet merkelapp.
 *
 * Designet har ingen ikoner og bare tre flater å spille på – svart, gult og
 * grått – så statusen bæres av *fyllet*, ikke av en farget prikk:
 *
 *   Live      svart flate    (den sterkeste tilstanden får den sterkeste flaten)
 *   Bygger    gul flate      (noe pågår)
 *   I kø      hvit m/ramme   (venter, ingenting skjer ennå)
 *   Feilet    rød ramme      (bygget feilet)
 *   Nede      rød ramme      (bygget gikk bra, men containeren svarer ikke – se under)
 *   Hviler    grå flate      (stoppet, fullført, aldri deployet)
 *
 * ── «NEDE», OG HVORFOR DEN IKKE ER DET SAMME SOM «FULLFØRT» ─────────────────
 * En deployment kan være `success` uten at appen faktisk kjører: containeren
 * kan ha dødd lenge etter at bygget var ferdig (OOM, krasj-loop som til slutt
 * ga opp – se `services/helse.ts` på backend). Det var løgnen som gjorde at
 * `eierfullstack` sto som «Live» i produksjon mens siden svarte 502. `unhealthy`
 * kommer fra `projects.container_died_at` (migrasjon 0015) – databasens egen
 * rettelse av tilstanden, ikke et gjett i grensesnittet.
 *
 * «Nede» deler `fail`-tonen med «Feilet» – begge er «se hit» i rødt – men er en
 * egen etikett: den skal aldri gjenbruke «Fullført», som betyr noe helt annet
 * («en nyere deployment overtok»). En app som skulle kjøre, men ikke gjør det,
 * er nettopp den typen ting rødt er reservert for i dette systemet, uansett om
 * det var selve bygget eller det som skjedde etterpå som gikk galt.
 *
 * Prikkene fra forrige generasjon er borte med vilje: en 6 px sirkel i farge
 * var det eneste som skilte «Bygger» fra «Feilet» for en fargeblind bruker.
 * Nå skiller fyllet dem, og teksten sier det uansett.
 *
 * «Bygger» og «Stenger …» får i tillegg en lys strek som løper rundt ramma, så
 * en pågående tilstand skiller seg fra en ferdig én på bevegelse og ikke bare
 * på farge. Streken er dekorativ (`aria-hidden`) – etiketten bærer meningen.
 */

type Tone = "live" | "work" | "wait" | "fail" | "rest";

const TONES: Record<Tone, string> = {
  live: "bg-ink text-paper border-line",
  work: "bg-sun text-ink border-line",
  wait: "bg-paper text-ink border-line",
  fail: "bg-paper text-error border-error",
  rest: "bg-ash text-ink border-ash",
};

const BY_STATUS: Record<DeploymentStatus | "none", { label: string; tone: Tone }> = {
  success: { label: "Live", tone: "live" },
  building: { label: "Bygger", tone: "work" },
  queued: { label: "I kø", tone: "wait" },
  failed: { label: "Feilet", tone: "fail" },
  none: { label: "Ikke deployet", tone: "rest" },
};

export function DeploymentStatusBadge({
  status,
  isLive = true,
  stopped = false,
  stopping = false,
  unhealthy = false,
}: {
  status: DeploymentStatus | null;
  isLive?: boolean;
  /** Prosjektet er slått av (`projects.stopped_at`). */
  stopped?: boolean;
  /** Stopp-forespørselen pågår akkurat nå. */
  stopping?: boolean;
  /**
   * Helsesveipet på backend fant at containeren er borte, selv om dette er den
   * deploymenten databasen (fortsatt) kaller `success` (`projects.container_died_at`).
   * Skal aldri settes for en deployment som er forbigått av en nyere – bruk
   * `isLive` til det, som før.
   */
  unhealthy?: boolean;
}) {
  let info = BY_STATUS[status ?? "none"];

  if (status === "success" && !isLive) {
    info = { label: "Fullført", tone: "rest" };
  }

  // Rekkefølgen er meningsbærende.
  //
  // «Stenger» er en pågående handling brukeren nettopp startet, og skal vises
  // uansett hva den siste deploymenten sier. «Stoppet» går foran «Nede»: er
  // prosjektet slått av med vilje, er det den forklaringen som er sann og
  // nyttig, ikke et gammelt helseavvik fra før stoppet. «Nede» viker i sin tur
  // for et bygg som pågår – en ny deployment er allerede i gang med å rette
  // nettopp det avviket badgen ellers ville meldt.
  if (stopping) {
    info = { label: "Stenger …", tone: "work" };
  } else if (stopped && status !== "building" && status !== "queued") {
    info = { label: "Stoppet", tone: "rest" };
  } else if (unhealthy && status !== "building" && status !== "queued") {
    info = { label: "Nede", tone: "fail" };
  }

  // `key` på etiketten gjør at merket toner inn på nytt når tilstanden faktisk
  // endrer seg – «I kø» → «Bygger» → «Live» leses da som tre hendelser, ikke som
  // en tekst som stille ble byttet ut.
  //
  // Mens noe pågår løper en lys strek rundt ramma (`anim-trace`). Den erstatter
  // pusten som lå her før: en flate som toner ut og inn leses like gjerne som at
  // noe er deaktivert, og sa ingenting om at det gikk framover. To samtidige
  // virkemidler ble bare uroligere, så pusten er tatt bort her – `anim-breathe`
  // står urørt for de andre stedene som bruker den.
  const isWorking = info.tone === "work";

  return (
    <span
      key={info.label}
      className={`anim-pop relative isolate inline-flex shrink-0 items-center border-2 px-[10px] py-[3px] font-body text-[12px] font-bold uppercase leading-none tracking-[0.1em] transition-colors duration-300 ${
        TONES[info.tone]
      }`}
    >
      {isWorking ? <span aria-hidden className="anim-trace" /> : null}
      {info.label}
    </span>
  );
}
