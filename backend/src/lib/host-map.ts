import { config } from "../config.js";
import { devAliasHostname } from "./caddy.js";
import { logger } from "./logger.js";
import { supabase } from "./supabase.js";

/**
 * Vertsnavn → prosjekt-ID.
 *
 * Bodde tidligere inne i `services/analytics-ingest.ts`, som var riktig så
 * lenge det bare var én ting som trengte oppslaget. Med feilsporingen er det to
 * – og to kopier av dette kartet ville betydd to sett med dev-alias-regler som
 * kunne komme i utakt, og to periodiske spørringer mot `projects` i stedet for
 * én. Kartet er derfor flyttet hit og deles.
 *
 * Innholdet er ikke hemmelig: det er hvilke offentlige adresser som peker på
 * hvilke prosjekter. Det er ingen tilgangskontroll her, og skal ikke være det –
 * den som kaller må selv sjekke eierskap før den viser noe til noen.
 */

let hostMap = new Map<string, string>();
let hostMapAt = 0;
let refreshing: Promise<void> | null = null;
let started = false;

export async function refreshHostMap(): Promise<void> {
  if (refreshing) return refreshing;

  refreshing = (async () => {
    const { data, error } = await supabase
      .from("projects")
      .select("id, name, custom_domain, parent_project_id, branch");

    if (error) {
      logger.warn({ err: error.message }, "Kunne ikke friske opp vertsnavn-kartet");
      return;
    }

    type Row = {
      id: string;
      name: string;
      custom_domain: string | null;
      parent_project_id: string | null;
      branch: string | null;
    };

    const rows = (data ?? []) as Row[];
    const nameById = new Map(rows.map((row) => [row.id, row.name]));

    const next = new Map<string, string>();
    for (const row of rows) {
      next.set(`${row.name}${config.SNOAT_APP_DOMAIN_SUFFIX}`.toLowerCase(), row.id);
      if (row.custom_domain) next.set(row.custom_domain.toLowerCase(), row.id);

      // En dev-side svarer også på `<gren>.<hovedprosjekt>`. Uten denne linja
      // ville alle treff på den pene adressen falt utenfor kartet og blitt
      // forkastet, og statistikken for dev-siden vært tom uansett hvor mye den
      // ble besøkt.
      const parentName = row.parent_project_id ? nameById.get(row.parent_project_id) : null;
      const alias = parentName && row.branch ? devAliasHostname(parentName, row.branch) : null;
      if (alias) next.set(alias.toLowerCase(), row.id);
    }

    hostMap = next;
    hostMapAt = Date.now();
  })().finally(() => {
    refreshing = null;
  });

  return refreshing;
}

/**
 * Tømmer kartet slik at neste treff leser på nytt.
 *
 * Kalles fra deploy-pipelinen når en rute opprettes eller et eget domene
 * endres. Uten den ville de første forespørslene til et helt nytt prosjekt
 * blitt forkastet fram til den periodiske oppfriskningen rakk å kjøre.
 */
export function invalidateHostMap(): void {
  hostMapAt = 0;
}

export function resolveProject(host: string): string | null {
  // Caddy tar med porten på ikke-standard porter (typisk lokalt).
  const clean = host.toLowerCase().replace(/:\d+$/, "");

  const known = hostMap.get(clean);
  if (known) return known;

  // Ukjent vert kan være et prosjekt som nettopp ble deployet. Frisk opp, men
  // ikke oftere enn hvert 10. sekund – ellers blir en portscan mot tilfeldige
  // vertsnavn til en spørring per forespørsel.
  if (Date.now() - hostMapAt > 10_000) void refreshHostMap();

  return null;
}

/**
 * Starter den periodiske oppfriskningen. Idempotent, slik at både
 * analytikk-ingesten og feil-ingesten kan kalle den uten å koordinere
 * rekkefølge – den som kommer først vinner, den andre er en no-op.
 *
 * Sveipet fanger opp slettede prosjekter og domeneendringer som ikke gikk veien
 * om deploy-pipelinen.
 */
export function startHostMapRefresh(): void {
  if (started) return;
  started = true;

  void refreshHostMap();
  setInterval(() => void refreshHostMap(), 60_000).unref();
}
