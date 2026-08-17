import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { config } from "../config.js";
import { logger } from "./logger.js";
import { supabase } from "./supabase.js";
import type { OauthAuthorizationCode, OauthClient, OauthToken } from "../types.js";

/**
 * Autorisasjonsserveren bak MCP-connectoren.
 *
 * Denne filen eier hemmelighetene i OAuth-flyten: hvordan koder og tokens lages,
 * hvordan de gjenkjennes igjen, og hvordan samtykke-forespørselen bæres trygt
 * gjennom nettleseren. Rutene i `routes/oauth.ts` er protokollen; dette er
 * kryptografien.
 *
 * Alt lagres som sha256-hash, aldri i klartekst – samme begrunnelse som for
 * API-nøklene i `lib/api-keys.ts`: verdiene er uniformt tilfeldige 256 bits, så
 * salt og bcrypt-kostnad har ingenting å bidra med, og en verdi vi ikke kan lese
 * ut av databasen kan heller ikke leses ut av en databasedump.
 */

/**
 * Prefikser, av samme grunn som `snoat_ak_`: `requireAuth` skal kunne avgjøre
 * hva et token er uten å prøve alle mulighetene mot hver forespørsel, og en
 * lekket verdi skal være gjenkjennelig i en logg.
 */
export const ACCESS_TOKEN_PREFIX = "snoat_at_";
export const REFRESH_TOKEN_PREFIX = "snoat_rt_";
const CODE_PREFIX = "snoat_ac_";
const CLIENT_ID_PREFIX = "snoat_client_";

/**
 * Levetider.
 *
 * Access-tokenet er kortere enn en API-nøkkel med vilje: klienten fornyer selv
 * med refresh-tokenet, så et lekket access-token har en utløpsdato en lekket
 * API-nøkkel ikke har. 30 dager på refresh-tokenet er valgt slik at en connector
 * som står ubrukt over en ferie fortsatt virker når kunden kommer tilbake.
 */
const ACCESS_TOKEN_TTL_SECONDS = 60 * 60 * 24; // 24 timer
const REFRESH_TOKEN_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 dager
/** Koden lever bare fra «Godkjenn» til innbyttet, som er ett omdirigeringshopp. */
const CODE_TTL_SECONDS = 60;
/** Samtykke-forespørselen lever fra Claude sender brukeren hit til hen trykker ja. */
const CONSENT_REQUEST_TTL_SECONDS = 60 * 15;

export const MCP_SCOPE = "mcp";

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * Nøkkelen som signerer samtykke-forespørselen gjennom nettleseren.
 *
 * Utledet fra service-role-nøkkelen i stedet for å være en egen miljøvariabel,
 * og det er et bevisst valg: en variabel til er en variabel som kan glemmes i
 * produksjon, og da ville connectoren – den ene funksjonen kunden faktisk
 * prøver å ta i bruk – feilet med 503 i stedet for å bare virke. Utledningen er
 * deterministisk, så alle backend-instanser kommer til samme nøkkel uten å dele
 * noe seg imellom.
 *
 * Service-role-nøkkelen brukes aldri direkte som signeringsnøkkel: HMAC-en her
 * er domeneseparert med en fast streng, slik at signaturene ikke kan gjenbrukes
 * i noen annen sammenheng nøkkelen også er i bruk.
 */
function consentSecret(): Buffer {
  return createHmac("sha256", config.SUPABASE_SERVICE_ROLE_KEY)
    .update("snoat-mcp-oauth-consent-v1")
    .digest();
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function fromBase64url(input: string): Buffer {
  return Buffer.from(input.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

/** Sammenligning som ikke lekker hvor i strengen to verdier skiller seg. */
function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

// --- Klienter --------------------------------------------------------------

/**
 * Registrerer en MCP-klient (RFC 7591).
 *
 * Claude kaller dette selv, uten at noe menneske har opprettet en app hos oss
 * først. Det er hele poenget med dynamisk registrering: kunden limer inn en URL
 * og trykker «Connect», og klienten ordner resten. Vi utsteder ingen
 * `client_secret` – klienten er offentlig, og PKCE er det som binder
 * token-innbyttet til den som startet innloggingen.
 *
 * Registreringen er derfor *ikke* en tillitsbeslutning. Hvem som helst kan
 * registrere seg; det som gir tilgang er at en innlogget bruker etterpå trykker
 * «Godkjenn» på samtykkesiden.
 */
export async function registerClient(params: {
  clientName: string;
  redirectUris: string[];
}): Promise<OauthClient> {
  const clientId = `${CLIENT_ID_PREFIX}${randomBytes(16).toString("hex")}`;

  const { data, error } = await supabase
    .from("oauth_clients")
    .insert({
      client_id: clientId,
      client_name: params.clientName.slice(0, 200),
      redirect_uris: params.redirectUris,
    })
    .select("*")
    .single();

  if (error) {
    throw new Error(`Kunne ikke registrere OAuth-klienten: ${error.message}`);
  }

  logger.info(
    { clientId, clientName: params.clientName, redirectUris: params.redirectUris },
    "MCP-klient registrerte seg",
  );

  return data as OauthClient;
}

export async function findClient(clientId: string): Promise<OauthClient | null> {
  const { data, error } = await supabase
    .from("oauth_clients")
    .select("*")
    .eq("client_id", clientId)
    .maybeSingle();

  if (error) {
    logger.error({ err: error, clientId }, "Kunne ikke slå opp OAuth-klient");
    return null;
  }

  return (data as OauthClient | null) ?? null;
}

/**
 * Er denne `redirect_uri` registrert på klienten?
 *
 * Eksakt strengsammenligning, ikke prefiks- eller mønstermatching. En
 * «starts with»-sjekk her er den klassiske måten å gi bort autorisasjonskoder:
 * `https://claude.ai/callback` ville da også godtatt
 * `https://claude.ai/callback.angriper.no`.
 */
export function isRegisteredRedirectUri(client: OauthClient, redirectUri: string): boolean {
  return client.redirect_uris.some((uri) => safeEqual(uri, redirectUri));
}

// --- Samtykke-forespørselen ------------------------------------------------

export interface ConsentRequest {
  clientId: string;
  redirectUri: string;
  /** Klientens `state`, som skal tilbake urørt. Beskytter klienten mot CSRF. */
  state: string | null;
  codeChallenge: string;
  scope: string;
  resource: string | null;
  /** Unix-sekunder. Etter dette må Claude sende brukeren hit på nytt. */
  expiresAt: number;
}

/**
 * Pakker autorisasjonsforespørselen inn i én signert, opaque streng.
 *
 * Parameterne må gjennom nettleseren – fra `/oauth/authorize` til
 * samtykkesiden i dashboardet og tilbake til `/oauth/approve` – og de avgjør
 * hvor koden havner. Alternativet var å legge dem i URL-en som lesbare
 * query-parametre og stole på dem når de kom tilbake; da kunne en bruker som ble
 * lurt til å åpne en tilpasset lenke godkjent en `redirect_uri` klienten aldri
 * hadde registrert.
 *
 * HMAC-en gjør strengen umulig å endre uten nøkkelen. Ingen DB-rad: dette er
 * kortlevd tilstand som ikke skal etterlate rader hver gang noen begynner en
 * innlogging de aldri fullfører.
 */
export function sealConsentRequest(request: ConsentRequest): string {
  const payload = base64url(JSON.stringify(request));
  const signature = base64url(createHmac("sha256", consentSecret()).update(payload).digest());
  return `${payload}.${signature}`;
}

export function openConsentRequest(sealed: string): ConsentRequest | null {
  const [payload, signature] = sealed.split(".");
  if (!payload || !signature) return null;

  const expected = base64url(createHmac("sha256", consentSecret()).update(payload).digest());
  if (!safeEqual(signature, expected)) return null;

  let parsed: ConsentRequest;
  try {
    parsed = JSON.parse(fromBase64url(payload).toString("utf8")) as ConsentRequest;
  } catch {
    return null;
  }

  // Signaturen sier at *vi* lagde den, ikke at den fortsatt er fersk.
  if (typeof parsed.expiresAt !== "number" || parsed.expiresAt * 1000 < Date.now()) return null;

  return parsed;
}

export function consentExpiry(): number {
  return Math.floor(Date.now() / 1000) + CONSENT_REQUEST_TTL_SECONDS;
}

// --- Autorisasjonskoder ---------------------------------------------------

/**
 * Utsteder en autorisasjonskode etter at brukeren har godkjent.
 * Returnerer klartekstkoden – den finnes kun her, i dette ene øyeblikket.
 */
export async function issueAuthorizationCode(params: {
  clientId: string;
  userId: string;
  redirectUri: string;
  codeChallenge: string;
  scope: string;
  resource: string | null;
}): Promise<string> {
  const code = `${CODE_PREFIX}${randomBytes(32).toString("hex")}`;

  const { error } = await supabase.from("oauth_authorization_codes").insert({
    code_hash: sha256(code),
    client_id: params.clientId,
    user_id: params.userId,
    redirect_uri: params.redirectUri,
    code_challenge: params.codeChallenge,
    scope: params.scope,
    resource: params.resource,
    expires_at: new Date(Date.now() + CODE_TTL_SECONDS * 1000).toISOString(),
  });

  if (error) {
    throw new Error(`Kunne ikke utstede autorisasjonskode: ${error.message}`);
  }

  return code;
}

export type CodeRedemption =
  | { ok: true; code: OauthAuthorizationCode }
  | { ok: false; reason: string };

/**
 * Løser inn en autorisasjonskode: én gang, av riktig klient, til riktig URI,
 * med riktig PKCE-verifikator.
 *
 * Merkingen som brukt skjer **før** vi svarer, og er betinget av at raden
 * fortsatt er umerket (`is('consumed_at', null)` i UPDATE-en). To samtidige
 * innbytter av samme kode kan dermed ikke begge lykkes – det er databasen, ikke
 * rekkefølgen i denne funksjonen, som avgjør hvem som vinner.
 */
export async function redeemAuthorizationCode(params: {
  code: string;
  clientId: string;
  redirectUri: string;
  codeVerifier: string;
}): Promise<CodeRedemption> {
  const { data, error } = await supabase
    .from("oauth_authorization_codes")
    .select("*")
    .eq("code_hash", sha256(params.code))
    .maybeSingle();

  if (error) {
    logger.error({ err: error }, "Kunne ikke slå opp autorisasjonskode");
    return { ok: false, reason: "Kunne ikke verifisere koden" };
  }

  const row = data as OauthAuthorizationCode | null;
  if (!row) return { ok: false, reason: "Ukjent autorisasjonskode" };

  if (row.consumed_at) {
    // Et andre forsøk på samme kode er et tegn på at den er avlyttet. Vi trekker
    // derfor tilbake alt klienten har fått på grunnlag av den – RFC 6749 § 4.1.2
    // anbefaler nettopp dette – i stedet for bare å svare nei på dette ene kallet.
    logger.warn(
      { clientId: row.client_id, userId: row.user_id },
      "Autorisasjonskode forsøkt gjenbrukt – trekker tilbake tokens for klienten",
    );
    await revokeClientTokens(row.user_id, row.client_id);
    return { ok: false, reason: "Koden er allerede brukt" };
  }

  if (new Date(row.expires_at).getTime() < Date.now()) {
    return { ok: false, reason: "Koden er utløpt" };
  }

  if (!safeEqual(row.client_id, params.clientId)) {
    return { ok: false, reason: "Koden tilhører en annen klient" };
  }

  if (!safeEqual(row.redirect_uri, params.redirectUri)) {
    return { ok: false, reason: "redirect_uri stemmer ikke med den koden ble utstedt for" };
  }

  // PKCE S256: BASE64URL(SHA256(verifier)) må bli challenge. Vi støtter ikke
  // `plain` – da ville verifikatoren stått i klartekst i den samme URL-en
  // challenge-en står i, og hele mekanismen vært pynt.
  const computed = base64url(createHash("sha256").update(params.codeVerifier).digest());
  if (!safeEqual(computed, row.code_challenge)) {
    return { ok: false, reason: "code_verifier stemmer ikke med code_challenge" };
  }

  const { error: consumeError, data: consumed } = await supabase
    .from("oauth_authorization_codes")
    .update({ consumed_at: new Date().toISOString() })
    .eq("id", row.id)
    .is("consumed_at", null)
    .select("id");

  if (consumeError) {
    return { ok: false, reason: "Kunne ikke merke koden som brukt" };
  }

  // Tom liste betyr at noen andre rakk å merke raden mellom oppslaget og
  // oppdateringen. Da er det den andre forespørselen som får tokenet.
  if (!consumed || consumed.length === 0) {
    return { ok: false, reason: "Koden er allerede brukt" };
  }

  return { ok: true, code: row };
}

// --- Tokens ---------------------------------------------------------------

export interface IssuedTokenPair {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  scope: string;
}

/**
 * Utsteder et access/refresh-par til en klient på vegne av en bruker.
 *
 * `replacesTokenId` settes ved fornyelse, slik at kjeden av refresh-tokens kan
 * følges bakover. Se `rotateRefreshToken()`.
 */
export async function issueTokenPair(params: {
  clientId: string;
  userId: string;
  scope: string;
  resource: string | null;
  replacesTokenId?: string | null;
}): Promise<IssuedTokenPair> {
  const accessToken = `${ACCESS_TOKEN_PREFIX}${randomBytes(32).toString("hex")}`;
  const refreshToken = `${REFRESH_TOKEN_PREFIX}${randomBytes(32).toString("hex")}`;
  const now = Date.now();

  const { error } = await supabase.from("oauth_tokens").insert([
    {
      token_hash: sha256(accessToken),
      kind: "access",
      client_id: params.clientId,
      user_id: params.userId,
      scope: params.scope,
      resource: params.resource,
      expires_at: new Date(now + ACCESS_TOKEN_TTL_SECONDS * 1000).toISOString(),
      replaces_token_id: params.replacesTokenId ?? null,
    },
    {
      token_hash: sha256(refreshToken),
      kind: "refresh",
      client_id: params.clientId,
      user_id: params.userId,
      scope: params.scope,
      resource: params.resource,
      expires_at: new Date(now + REFRESH_TOKEN_TTL_SECONDS * 1000).toISOString(),
      replaces_token_id: params.replacesTokenId ?? null,
    },
  ]);

  if (error) {
    throw new Error(`Kunne ikke utstede tokens: ${error.message}`);
  }

  return {
    accessToken,
    refreshToken,
    expiresIn: ACCESS_TOKEN_TTL_SECONDS,
    scope: params.scope,
  };
}

export function isOauthAccessToken(token: string): boolean {
  return token.startsWith(ACCESS_TOKEN_PREFIX);
}

/**
 * Slår opp et access-token og returnerer raden hvis det fortsatt gjelder.
 *
 * Oppslaget går på den unik-indekserte hashen, altså ett indeksoppslag. Samme
 * form som `verifyApiKey()`, og med vilje: `requireAuth` skal kunne behandle de
 * to legitimasjonstypene likt.
 */
export async function verifyAccessToken(token: string): Promise<OauthToken | null> {
  if (!isOauthAccessToken(token)) return null;

  const { data, error } = await supabase
    .from("oauth_tokens")
    .select("*")
    .eq("token_hash", sha256(token))
    .eq("kind", "access")
    .maybeSingle();

  if (error) {
    logger.error({ err: error }, "Kunne ikke slå opp access-token");
    return null;
  }

  const row = data as OauthToken | null;
  if (!row || row.revoked_at) return null;
  if (new Date(row.expires_at).getTime() < Date.now()) return null;

  return row;
}

/**
 * Oppdaterer `last_used_at` uten å vente på svaret – samme avveining som
 * `touchApiKey()`: feltet er til for at kunden skal se hvilke tilkoblinger som
 * faktisk er i bruk, og det er ikke verdt et rundturs-kall i hver forespørsel.
 */
export function touchToken(id: string): void {
  void supabase
    .from("oauth_tokens")
    .update({ last_used_at: new Date().toISOString() })
    .eq("id", id)
    .then(({ error }) => {
      if (error) logger.debug({ err: error, id }, "Kunne ikke oppdatere last_used_at");
    });
}

export type RefreshResult = { ok: true; tokens: IssuedTokenPair } | { ok: false; reason: string };

/**
 * Bytter et refresh-token i et nytt par, og trekker tilbake det gamle.
 *
 * Rotasjon i stedet for gjenbruk: et refresh-token som brukes to ganger er
 * enten en klient som prøver igjen etter et nettverksbrudd, eller et stjålet
 * token. Vi kan ikke se forskjellen, så vi antar det verste og trekker tilbake
 * hele familien. Klienten må da sende brukeren gjennom innloggingen på nytt –
 * ubeleilig, men det er den eneste responsen som faktisk stenger en tyv ute.
 */
export async function rotateRefreshToken(params: {
  refreshToken: string;
  clientId: string;
}): Promise<RefreshResult> {
  const { data, error } = await supabase
    .from("oauth_tokens")
    .select("*")
    .eq("token_hash", sha256(params.refreshToken))
    .eq("kind", "refresh")
    .maybeSingle();

  if (error) {
    logger.error({ err: error }, "Kunne ikke slå opp refresh-token");
    return { ok: false, reason: "Kunne ikke verifisere refresh-tokenet" };
  }

  const row = data as OauthToken | null;
  if (!row) return { ok: false, reason: "Ukjent refresh-token" };

  if (row.revoked_at) {
    logger.warn(
      { clientId: row.client_id, userId: row.user_id },
      "Tilbaketrukket refresh-token forsøkt brukt – trekker tilbake tokens for klienten",
    );
    await revokeClientTokens(row.user_id, row.client_id);
    return { ok: false, reason: "Refresh-tokenet er trukket tilbake" };
  }

  if (new Date(row.expires_at).getTime() < Date.now()) {
    return { ok: false, reason: "Refresh-tokenet er utløpt" };
  }

  if (!safeEqual(row.client_id, params.clientId)) {
    return { ok: false, reason: "Refresh-tokenet tilhører en annen klient" };
  }

  const tokens = await issueTokenPair({
    clientId: row.client_id,
    userId: row.user_id,
    scope: row.scope,
    resource: row.resource,
    replacesTokenId: row.id,
  });

  // Etter utstedelsen: feiler den, skal det gamle tokenet fortsatt virke.
  await supabase
    .from("oauth_tokens")
    .update({ revoked_at: new Date().toISOString() })
    .eq("id", row.id);

  return { ok: true, tokens };
}

/**
 * Trekker tilbake alt en klient har på vegne av en bruker.
 *
 * Dette er hva «Koble fra» i dashboardet gjør, og hva vi gjør av oss selv når en
 * kode eller et refresh-token blir gjenbrukt. Tidsstempling, ikke sletting: en
 * tilgang som har vært i bruk skal kunne spores i ettertid – samme prinsipp som
 * `api_keys.revoked_at`.
 */
export async function revokeClientTokens(userId: string, clientId: string): Promise<void> {
  const { error } = await supabase
    .from("oauth_tokens")
    .update({ revoked_at: new Date().toISOString() })
    .eq("user_id", userId)
    .eq("client_id", clientId)
    .is("revoked_at", null);

  if (error) {
    throw new Error(`Kunne ikke trekke tilbake tilgangen: ${error.message}`);
  }
}

/** Trekker tilbake ett enkelt token (RFC 7009). Ukjent token er ikke en feil. */
export async function revokeSingleToken(token: string): Promise<void> {
  await supabase
    .from("oauth_tokens")
    .update({ revoked_at: new Date().toISOString() })
    .eq("token_hash", sha256(token))
    .is("revoked_at", null);
}

export interface ConnectionSummary {
  clientId: string;
  clientName: string;
  connectedAt: string;
  lastUsedAt: string | null;
  expiresAt: string;
}

/**
 * Hvilke MCP-klienter har tilgang til denne kontoen akkurat nå?
 *
 * Én rad per klient, ikke per token: kunden tenker på det som «Claude har
 * tilgang», ikke som et access-token og et refresh-token med hver sin utløpstid.
 * Klienter der alt er trukket tilbake eller utløpt faller ut av listen.
 */
export async function listConnections(userId: string): Promise<ConnectionSummary[]> {
  const { data, error } = await supabase
    .from("oauth_tokens")
    .select("client_id, created_at, last_used_at, expires_at, oauth_clients(client_name)")
    .eq("user_id", userId)
    .eq("kind", "refresh")
    .is("revoked_at", null)
    .gt("expires_at", new Date().toISOString())
    .order("created_at", { ascending: false });

  if (error) {
    throw new Error(`Kunne ikke hente tilkoblinger: ${error.message}`);
  }

  const byClient = new Map<string, ConnectionSummary>();

  /**
   * Den innebygde joinen kommer som en liste når PostgREST ikke kan se at
   * relasjonen er én-til-én. Vi tar første treff uansett hvilken av de to
   * formene vi får – alternativet var å slå opp klientnavnene i en egen runde.
   */
  const clientName = (relation: unknown): string => {
    const row = Array.isArray(relation) ? relation[0] : relation;
    const name = (row as { client_name?: unknown } | null)?.client_name;
    return typeof name === "string" ? name : "Ukjent klient";
  };

  for (const row of (data ?? []) as unknown as Array<{
    client_id: string;
    created_at: string;
    last_used_at: string | null;
    expires_at: string;
    oauth_clients: unknown;
  }>) {
    const existing = byClient.get(row.client_id);

    // Fornyelse lager et nytt refresh-token, så en klient kan ha flere rader.
    // Vi viser den nyeste som «tilkoblet», men beholder det seneste sporet av
    // faktisk bruk – ellers ville en nettopp fornyet tilkobling sett ubrukt ut.
    if (!existing) {
      byClient.set(row.client_id, {
        clientId: row.client_id,
        clientName: clientName(row.oauth_clients),
        connectedAt: row.created_at,
        lastUsedAt: row.last_used_at,
        expiresAt: row.expires_at,
      });
      continue;
    }

    if (row.last_used_at && (!existing.lastUsedAt || row.last_used_at > existing.lastUsedAt)) {
      existing.lastUsedAt = row.last_used_at;
    }
    if (row.created_at < existing.connectedAt) existing.connectedAt = row.created_at;
  }

  return [...byClient.values()];
}
