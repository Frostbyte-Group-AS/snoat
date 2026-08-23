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
 *   Feilet    rød ramme      (eneste stedet rødt brukes i systemet)
 *   Hviler    grå flate      (stoppet, fullført, aldri deployet)
 *
 * Prikkene fra forrige generasjon er borte med vilje: en 6 px sirkel i farge
 * var det eneste som skilte «Bygger» fra «Feilet» for en fargeblind bruker.
 * Nå skiller fyllet dem, og teksten sier det uansett.
 */

type Tone = "live" | "work" | "wait" | "fail" | "rest";

const TONES: Record<Tone, string> = {
  live: "bg-ink text-paper border-ink",
  work: "bg-sun text-ink border-ink",
  wait: "bg-paper text-ink border-ink",
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
}: {
  status: DeploymentStatus | null;
  isLive?: boolean;
  /** Prosjektet er slått av (`projects.stopped_at`). */
  stopped?: boolean;
  /** Stopp-forespørselen pågår akkurat nå. */
  stopping?: boolean;
}) {
  let info = BY_STATUS[status ?? "none"];

  if (status === "success" && !isLive) {
    info = { label: "Fullført", tone: "rest" };
  }

  // Rekkefølgen er meningsbærende.
  //
  // «Stenger» er en pågående handling brukeren nettopp startet, og skal vises
  // uansett hva den siste deploymenten sier. «Stoppet» viker derimot for et bygg
  // som pågår: starter man en ny deployment på et stoppet prosjekt, er «Bygger»
  // det riktige svaret – backend nullstiller `stopped_at` i samme øyeblikk.
  if (stopping) {
    info = { label: "Stenger …", tone: "work" };
  } else if (stopped && status !== "building" && status !== "queued") {
    info = { label: "Stoppet", tone: "rest" };
  }

  return (
    <span
      className={`inline-flex shrink-0 items-center border-2 px-[10px] py-[3px] font-body text-[12px] font-bold uppercase leading-none tracking-[0.1em] ${TONES[info.tone]}`}
    >
      {info.label}
    </span>
  );
}
