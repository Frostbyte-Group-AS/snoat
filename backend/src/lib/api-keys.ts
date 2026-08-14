import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { logger } from "./logger.js";
import { supabase } from "./supabase.js";
import type { ApiKey } from "../types.js";

/**
 * Langlevde API-nøkler for maskin-til-maskin-tilgang.
 *
 * Dashboardet autentiserer med en Supabase-sesjon, men en integrasjon som
 * LeadLab har ingen nettleser og ingen bruker å låne. Den trenger en legitimasjon
 * som ikke utløper etter en time og ikke krever en innlogging for å fornyes.
 *
 * Nøkkelen lagres kun som sha256-hash. Vi kan derfor ikke vise den igjen etter
 * opprettelsen – det er tilsiktet. En nøkkel vi kan lese ut av databasen er en
 * nøkkel som kan leses ut av en databasedump.
 *
 * Ingen HMAC eller salt: dette er 256 bits fra `randomBytes`, ikke et passord.
 * Salt beskytter mot at like passord får like hasher, og bcrypt-kostnad mot at
 * en ordbok kan prøves; ingen av delene har noe å bidra med når inndata er
 * uniformt tilfeldig og søkerommet er 2^256.
 */

/**
 * Prefikset gjør nøkkelen gjenkjennelig i en logg eller et .env-oppslag – og,
 * viktigere, lar `requireAuth` skille en API-nøkkel fra et Supabase-JWT uten å
 * måtte prøve begge deler mot hver forespørsel.
 *
 * Det er også det GitHub sine hemmelighetsskannere leter etter; et fast prefiks
 * er forutsetningen for at en lekket nøkkel i et offentlig repo kan oppdages.
 */
export const API_KEY_PREFIX = "snoat_ak_";

/** Så mange tegn av nøkkelen vi lagrer i klartekst, til gjenkjenning i UI/logg. */
const DISPLAY_PREFIX_LENGTH = API_KEY_PREFIX.length + 6;

export function isApiKey(token: string): boolean {
  return token.startsWith(API_KEY_PREFIX);
}

function hash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export interface GeneratedApiKey {
  /** Klartekstnøkkelen. Finnes kun i dette ene øyeblikket. */
  token: string;
  tokenHash: string;
  tokenPrefix: string;
}

export function generateApiKey(): GeneratedApiKey {
  const token = `${API_KEY_PREFIX}${randomBytes(32).toString("hex")}`;
  return {
    token,
    tokenHash: hash(token),
    tokenPrefix: token.slice(0, DISPLAY_PREFIX_LENGTH),
  };
}

/**
 * Slår opp en nøkkel og returnerer raden hvis den er gyldig.
 *
 * Oppslaget går på hash-en, som er unik-indeksert – altså ett indeksoppslag,
 * ikke en gjennomgang av alle nøkler. Det er også grunnen til at
 * `timingSafeEqual` under er nesten seremoniell her: databasen har allerede
 * sammenlignet. Den står likevel, fordi «nesten» ikke er et godt nok argument
 * for å la en `===` stå igjen i en autentiseringssti.
 */
export async function verifyApiKey(token: string): Promise<ApiKey | null> {
  if (!isApiKey(token)) return null;

  const digest = hash(token);

  const { data, error } = await supabase
    .from("api_keys")
    .select("*")
    .eq("token_hash", digest)
    .maybeSingle();

  if (error) {
    // En databasefeil er ikke det samme som en ugyldig nøkkel, men kalleren kan
    // uansett ikke slippes inn. Vi logger forskjellen så den er synlig for oss.
    logger.error({ err: error }, "Kunne ikke slå opp API-nøkkel");
    return null;
  }

  const row = data as ApiKey | null;
  if (!row || row.revoked_at) return null;

  const stored = Buffer.from(row.token_hash);
  const given = Buffer.from(digest);
  if (stored.length !== given.length || !timingSafeEqual(stored, given)) return null;

  return row;
}

/**
 * Oppdaterer `last_used_at`, uten å vente på svaret.
 *
 * Feltet er til for at vi skal kunne se hvilke nøkler som faktisk er i bruk før
 * vi rydder. Det er ikke verdt et rundturs-kall i den kritiske stien for hver
 * eneste forespørsel, og en mislykket skriving skal aldri kunne gjøre et
 * gyldig kall til en 401.
 */
export function touchApiKey(id: string): void {
  void supabase
    .from("api_keys")
    .update({ last_used_at: new Date().toISOString() })
    .eq("id", id)
    .then(({ error }) => {
      if (error) logger.debug({ err: error, id }, "Kunne ikke oppdatere last_used_at");
    });
}
