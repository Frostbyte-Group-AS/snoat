import { createHash } from "node:crypto";

/**
 * Reglene som avgjør hva som er «samme feil».
 *
 * Ligger i `lib/` og ikke i `services/error-ingest.ts` av én grunn: dette er den
 * eneste delen av feilsporingen som kan være feil uten at noe krasjer. En
 * fingerprint som er for løs slår sammen to ulike feil til én rad, og den ene
 * blir aldri rettet. En som er for streng lager en ny rad per forekomst, og da
 * er hele grupperingen bortkastet. Begge feilene er stille.
 *
 * Uten dependencies, slik at `error-fingerprint.test.ts` kan importere modulen
 * uten å dra inn config, Supabase-klienten eller Docker.
 */

/**
 * Gjør en feilmelding til noe som kan grupperes på.
 *
 * Uten dette blir hver forekomst sin egen gruppe så snart meldingen inneholder
 * en ID, et klokkeslett eller en URL – og det gjør de fleste meldinger som er
 * verdt å lese. Resultatet ville vært et dashboard med tusen rader som alle sier
 * det samme, altså nøyaktig problemet feilgruppering skal løse.
 *
 * Rekkefølgen på erstatningene betyr noe: UUID før hex før generelle tall,
 * ellers spiser tallregelen sifrene i UUID-en først og etterlater et mønster som
 * ikke matcher noe.
 */
export function normalizeMessage(raw: string): string {
  return raw
    .slice(0, 500)
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "<uuid>")
    .replace(/\b0x[0-9a-f]+\b/gi, "<hex>")
    .replace(/\b[0-9a-f]{16,}\b/gi, "<hash>")
    .replace(/https?:\/\/[^\s"')]+/gi, "<url>")
    .replace(/\b\d+\b/g, "<n>")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Filstien uten innholdshash og uten opphav.
 *
 * `https://app.snoat.com/_next/static/chunks/main-a3f9c1.js` og samme fil etter
 * neste bygg er den samme fila. Uten dette ville hver eneste utrulling nullstilt
 * hele feilhistorikken, og «denne feilen har vært her i tre uker» – det ene
 * tallet som forteller om noe haster – hadde aldri kunnet bli mer enn null.
 */
export function normalizeFile(raw: string | null): string | null {
  if (!raw) return null;

  let path = raw;
  try {
    path = new URL(raw).pathname;
  } catch {
    // Ikke en absolutt URL. Da er den allerede en sti.
  }

  return path.replace(/[.-][0-9a-f]{6,}(?=\.[a-z]+$)/i, "").slice(0, 255) || null;
}

/**
 * Identiteten til en feil: sha256 over art, normalisert melding, fil og linje.
 *
 * Linjenummeret er med selv om det gjør fingerprinten skjør mot refaktorering –
 * en feil som flytter seg fem linjer blir en ny gruppe. Alternativet er verre:
 * uten linjenummer smelter alle `TypeError: Cannot read properties of undefined`
 * i samme fil sammen til én rad, og det er den vanligste feilen som finnes.
 */
export function fingerprint(
  kind: string,
  message: string,
  file: string | null,
  line: number | null,
): string {
  return createHash("sha256")
    .update(kind)
    .update(" ")
    .update(normalizeMessage(message))
    .update(" ")
    .update(file ?? "")
    .update(" ")
    .update(line === null ? "" : String(line))
    .digest("hex");
}
