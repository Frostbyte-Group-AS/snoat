import { supabase } from "../lib/supabase.js";
import type { Project } from "../types.js";

/**
 * Uthenting av feil. Motstykket til `error-ingest.ts`, som skriver dem.
 *
 * Alt går gjennom RPC-ene i migrasjon 0016. Tabellene ligger i skjemaet
 * `errors`, som PostgREST ikke eksponerer, så det finnes ingen annen vei inn –
 * og det er med vilje: en stacktrace kan inneholde hva som helst appen hadde i
 * minnet, og skal aldri kunne leses av noen som ikke eier prosjektet.
 *
 * Eierskapssjekken ligger ikke her, men i `loadOwnedProject` i rutelaget, på
 * samme måte som for analytikken. Funksjonene under tar imot et `Project` som
 * kalleren allerede har bevist at den eier.
 */

export type ErrorStatus = "open" | "resolved" | "ignored";

export interface ErrorGroup {
  id: string;
  kind: "client" | "server" | "crash" | "http";
  message: string;
  file: string | null;
  line: number | null;
  col: number | null;
  first_seen: string;
  last_seen: string;
  events: number;
  status: ErrorStatus;
  patch_pr_url: string | null;
  stacks: Array<{
    at: string;
    stack: string | null;
    url: string | null;
    browser: string | null;
    os: string | null;
  }>;
}

/** Feilene i ett prosjekt. Det dashboardets feilfane viser. */
export async function listForProject(
  project: Project,
  options: { status?: ErrorStatus | "all"; limit?: number; stacks?: number } = {},
): Promise<ErrorGroup[]> {
  const { data, error } = await supabase.rpc("errors_list", {
    p_project_id: project.id,
    p_status: options.status ?? "open",
    p_limit: clamp(options.limit ?? 50, 1, 200),
    p_stacks: clamp(options.stacks ?? 1, 0, 20),
  });

  if (error) throw new Error(`Kunne ikke lese feil: ${error.message}`);

  return (data ?? []) as ErrorGroup[];
}

/**
 * Nye feil på tvers av prosjektene en bruker eier.
 *
 * Dette er spørringen patch-agenten stiller hver morgen: «hva har dukket opp
 * siden i går, hvor mye skjer det, og hvilken commit innførte det».
 *
 * `projectIds` må være prosjektene kalleren faktisk eier. Rutelaget slår dem
 * opp – funksjonen her stoler på lista den får, som er samme kontrakt som
 * resten av servicelaget følger.
 */
export async function listRecent(
  projectIds: string[],
  options: { since?: Date; minEvents?: number; limit?: number; stacks?: number } = {},
): Promise<unknown[]> {
  if (projectIds.length === 0) return [];

  const since = options.since ?? new Date(Date.now() - 24 * 60 * 60 * 1000);

  const { data, error } = await supabase.rpc("errors_recent", {
    p_project_ids: projectIds,
    p_since: since.toISOString(),
    p_min_events: clamp(options.minEvents ?? 1, 1, 10_000),
    p_limit: clamp(options.limit ?? 50, 1, 200),
    p_stacks: clamp(options.stacks ?? 3, 0, 20),
  });

  if (error) throw new Error(`Kunne ikke lese nye feil: ${error.message}`);

  return (data ?? []) as unknown[];
}

/**
 * Endrer status på én feilgruppe.
 *
 * `projectIds` er prosjektene kalleren eier, og går inn i WHERE-setningen i
 * databasen. Treffer den ingenting, får kalleren `null` – enten fordi gruppa
 * ikke finnes eller fordi den tilhører noen andre. De to skal se like ut
 * utenfra: å skille dem ville bekreftet at en gruppe-ID eksisterer for en som
 * ikke har noe med den å gjøre.
 */
export async function setStatus(
  groupId: string,
  status: ErrorStatus,
  projectIds: string[],
  prUrl?: string | null,
): Promise<{ id: string; project_id: string; status: ErrorStatus; patch_pr_url: string | null } | null> {
  if (projectIds.length === 0) return null;

  const { data, error } = await supabase.rpc("errors_set_status", {
    p_group_id: groupId,
    p_status: status,
    p_project_ids: projectIds,
    p_pr_url: prUrl ?? null,
  });

  if (error) throw new Error(`Kunne ikke endre status: ${error.message}`);

  return (data ?? null) as {
    id: string;
    project_id: string;
    status: ErrorStatus;
    patch_pr_url: string | null;
  } | null;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(Math.trunc(value), min), max);
}
