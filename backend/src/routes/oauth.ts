import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { logger } from "../lib/logger.js";
import {
  MCP_SCOPE,
  consentExpiry,
  findClient,
  isRegisteredRedirectUri,
  issueAuthorizationCode,
  openConsentRequest,
  redeemAuthorizationCode,
  registerClient,
  revokeSingleToken,
  rotateRefreshToken,
  sealConsentRequest,
  issueTokenPair,
  type ConsentRequest,
} from "../lib/oauth.js";
import { dashboardUrl, mcpResourceUrl, publicApiUrl } from "../lib/public-url.js";
import { supabase } from "../lib/supabase.js";

/**
 * OAuth 2.1-autorisasjonsserveren MCP-connectoren hviler på.
 *
 * Flyten, sett fra kunden: hen limer connector-URL-en inn i Claude og trykker
 * «Connect». Så skjer alt dette uten at hen ser noe av det:
 *
 *   1. Claude kaller MCP-endepunktet uten token og får 401 med en
 *      `WWW-Authenticate`-header som peker hit (`routes/mcp.ts`).
 *   2. Claude henter `/.well-known/oauth-protected-resource` og deretter
 *      `/.well-known/oauth-authorization-server` for å finne endepunktene.
 *   3. Claude registrerer seg selv med `POST /oauth/register` og får en client_id.
 *   4. Kunden sendes til `GET /oauth/authorize`, som sender hen videre til
 *      samtykkesiden i dashboardet.
 *   5. Kunden logger inn (om hen ikke alt er innlogget) og trykker «Godkjenn».
 *      Dashboardet kaller `POST /oauth/approve` med sesjonen sin.
 *   6. Claude bytter koden i et token på `POST /oauth/token`.
 *
 * Det eneste kunden gjør er å lime inn en URL og trykke to knapper. Ingen
 * nøkkel, ingen JSON-fil, ingen lokal prosess.
 *
 * **Monteres utenfor `/api` med vilje.** `routes/api.ts` legger `requireAuth` på
 * alt under seg, og disse rutene er nettopp de som kalles *før* kalleren har en
 * legitimasjon. `/oauth/approve` er unntaket: den krever en innlogget bruker, og
 * verifiserer sesjonen selv.
 */
export const oauth = new Hono();

/** Feilformatet OAuth krever (RFC 6749 § 5.2) – ikke vårt vanlige `{ error }`. */
function oauthError(
  code:
    | "invalid_request"
    | "invalid_client"
    | "invalid_grant"
    | "unauthorized_client"
    | "unsupported_grant_type"
    | "invalid_scope"
    | "server_error",
  description: string,
  status: 400 | 401 | 500 = 400,
) {
  return { body: { error: code, error_description: description }, status } as const;
}

// --- Oppdagelse ------------------------------------------------------------

/**
 * Metadata om den beskyttede ressursen (RFC 9728).
 *
 * Claude finner denne via `WWW-Authenticate`-headeren på 401-svaret fra
 * MCP-endepunktet, og bruker den til å finne ut *hvem* som kan utstede tokens
 * for oss. At ressursen og autorisasjonsserveren er samme tjeneste her endrer
 * ikke at oppslaget må finnes – klienten vet det ikke på forhånd.
 */
function protectedResourceMetadata(c: Parameters<typeof mcpResourceUrl>[0]) {
  return {
    resource: mcpResourceUrl(c),
    authorization_servers: [publicApiUrl(c)],
    scopes_supported: [MCP_SCOPE],
    bearer_methods_supported: ["header"],
    resource_name: "Snoat MCP",
    resource_documentation: `${dashboardUrl()}/settings/mcp`,
  };
}

export const wellKnown = new Hono();

wellKnown.get("/oauth-protected-resource", (c) => c.json(protectedResourceMetadata(c)));

/**
 * Samme metadata, med ressursens sti hengt på.
 *
 * RFC 9728 § 3.1 sier at klienten skal sette inn stien til ressursen mellom
 * `/.well-known/…` og resten når ressursen ikke ligger på roten. Claude følger
 * spesifikasjonen; enklere klienter spør på den korte formen over. Vi svarer på
 * begge i stedet for å vedde på hvilken klienten velger.
 */
wellKnown.get("/oauth-protected-resource/api/mcp", (c) => c.json(protectedResourceMetadata(c)));

/**
 * Metadata om autorisasjonsserveren (RFC 8414).
 *
 * `token_endpoint_auth_methods_supported: ["none"]` er ikke en forglemmelse:
 * klientene er offentlige og har ingen `client_secret` å autentisere seg med.
 * PKCE er det som binder token-innbyttet til den som startet innloggingen, og
 * `code_challenge_methods_supported: ["S256"]` sier at den er påkrevd – vi
 * støtter ikke `plain`.
 */
wellKnown.get("/oauth-authorization-server", (c) => {
  const base = publicApiUrl(c);

  return c.json({
    issuer: base,
    authorization_endpoint: `${base}/oauth/authorize`,
    token_endpoint: `${base}/oauth/token`,
    registration_endpoint: `${base}/oauth/register`,
    revocation_endpoint: `${base}/oauth/revoke`,
    scopes_supported: [MCP_SCOPE],
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    revocation_endpoint_auth_methods_supported: ["none"],
    service_documentation: `${dashboardUrl()}/settings/mcp`,
  });
});

/**
 * Samme dokument på OpenID Connect sin sti.
 *
 * Vi er ingen OIDC-leverandør – det utstedes ingen id_token her – men flere
 * MCP-klienter prøver denne stien først, eller *bare* denne. Å svare koster ett
 * alias; å ikke svare koster en connector som ikke kobler seg til.
 */
wellKnown.get("/openid-configuration", (c) => {
  const base = publicApiUrl(c);

  return c.json({
    issuer: base,
    authorization_endpoint: `${base}/oauth/authorize`,
    token_endpoint: `${base}/oauth/token`,
    registration_endpoint: `${base}/oauth/register`,
    revocation_endpoint: `${base}/oauth/revoke`,
    scopes_supported: [MCP_SCOPE],
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
  });
});

// --- Dynamisk klientregistrering (RFC 7591) --------------------------------

oauth.post("/register", async (c) => {
  const body = await c.req.json<{
    client_name?: unknown;
    redirect_uris?: unknown;
    grant_types?: unknown;
    token_endpoint_auth_method?: unknown;
  }>().catch(() => null);

  if (!body) {
    const { body: error, status } = oauthError("invalid_request", "Kroppen må være gyldig JSON");
    return c.json(error, status);
  }

  const redirectUris = Array.isArray(body.redirect_uris)
    ? body.redirect_uris.filter((uri): uri is string => typeof uri === "string" && uri.length > 0)
    : [];

  if (redirectUris.length === 0) {
    const { body: error, status } = oauthError(
      "invalid_request",
      "redirect_uris må inneholde minst én URI",
    );
    return c.json(error, status);
  }

  /**
   * Bare https, og ingen fragment-del.
   *
   * En kode sendt til en http-URI kan leses av hvem som helst på veien.
   * Unntaket er loopback, som MCP-klienter som kjører lokalt trenger – der er
   * det ingen nettverksvei å avlytte.
   */
  for (const uri of redirectUris) {
    let parsed: URL;
    try {
      parsed = new URL(uri);
    } catch {
      const { body: error, status } = oauthError("invalid_request", `Ugyldig redirect_uri: ${uri}`);
      return c.json(error, status);
    }

    const isLoopback = parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost";

    if (parsed.protocol !== "https:" && !isLoopback) {
      const { body: error, status } = oauthError(
        "invalid_request",
        `redirect_uri må bruke https (eller loopback): ${uri}`,
      );
      return c.json(error, status);
    }

    if (parsed.hash) {
      const { body: error, status } = oauthError(
        "invalid_request",
        `redirect_uri kan ikke ha fragment: ${uri}`,
      );
      return c.json(error, status);
    }
  }

  const clientName =
    typeof body.client_name === "string" && body.client_name.trim()
      ? body.client_name.trim()
      : "MCP-klient";

  try {
    const client = await registerClient({ clientName, redirectUris });

    return c.json(
      {
        client_id: client.client_id,
        client_id_issued_at: Math.floor(new Date(client.created_at).getTime() / 1000),
        client_name: client.client_name,
        redirect_uris: client.redirect_uris,
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
        scope: MCP_SCOPE,
      },
      201,
    );
  } catch (error) {
    logger.error({ err: error }, "Klientregistrering feilet");
    const { body: payload, status } = oauthError(
      "server_error",
      "Kunne ikke registrere klienten",
      500,
    );
    return c.json(payload, status);
  }
});

// --- Autorisasjon ----------------------------------------------------------

/**
 * Starter innloggingen. Brukeren står i nettleseren når dette kalles.
 *
 * Feilhåndteringen er delt i to, og skillet er viktig: er `client_id` eller
 * `redirect_uri` ugyldig, kan vi **ikke** omdirigere – da ville vi sendt en
 * feilmelding, og senere en kode, til en URI vi ikke har verifisert. Da vises
 * feilen her i stedet. Er de gyldige, hører alle øvrige feil hjemme hos klienten
 * som en `error`-parameter på redirect-URI-en, slik RFC 6749 § 4.1.2.1 sier.
 */
oauth.get("/authorize", async (c) => {
  const query = c.req.query();
  const clientId = query.client_id;
  const redirectUri = query.redirect_uri;

  if (!clientId || !redirectUri) {
    throw new HTTPException(400, {
      message: "Forespørselen mangler client_id eller redirect_uri.",
    });
  }

  const client = await findClient(clientId);

  if (!client) {
    throw new HTTPException(400, {
      message: "Ukjent client_id. Klienten må registrere seg på nytt.",
    });
  }

  if (!isRegisteredRedirectUri(client, redirectUri)) {
    throw new HTTPException(400, {
      message: "redirect_uri er ikke registrert på denne klienten.",
    });
  }

  // Herfra er redirect_uri verifisert, og feil kan sendes til klienten.
  const fail = (error: string, description: string) => {
    const target = new URL(redirectUri);
    target.searchParams.set("error", error);
    target.searchParams.set("error_description", description);
    if (query.state) target.searchParams.set("state", query.state);
    return c.redirect(target.toString(), 302);
  };

  if (query.response_type !== "code") {
    return fail("unsupported_response_type", "Kun response_type=code støttes.");
  }

  if (!query.code_challenge) {
    return fail("invalid_request", "code_challenge er påkrevd (PKCE).");
  }

  if (query.code_challenge_method !== "S256") {
    return fail("invalid_request", "code_challenge_method må være S256.");
  }

  // Vi har bare ett scope. Ber klienten om noe annet, sier vi det nå i stedet
  // for å utstede et token som ikke gjør det klienten tror.
  if (query.scope && !query.scope.split(/\s+/).includes(MCP_SCOPE)) {
    return fail("invalid_scope", `Ukjent scope. Støttet: ${MCP_SCOPE}.`);
  }

  const sealed = sealConsentRequest({
    clientId,
    redirectUri,
    state: query.state ?? null,
    codeChallenge: query.code_challenge,
    scope: MCP_SCOPE,
    resource: query.resource ?? null,
    expiresAt: consentExpiry(),
  });

  /**
   * Videre til samtykkesiden i dashboardet.
   *
   * Samtykket kan ikke innhentes her: brukeren beviser hvem hen er med en
   * Supabase-sesjon, og den lever i dashboardets nettleserkontekst – ikke i en
   * header på denne omdirigeringen. Siden der kan dessuten sende en uinnlogget
   * bruker gjennom vanlig innlogging først og komme rett tilbake hit.
   */
  const consentUrl = new URL(`${dashboardUrl()}/oauth/consent`);
  consentUrl.searchParams.set("request", sealed);

  return c.redirect(consentUrl.toString(), 302);
});

/**
 * Kunden trykket «Godkjenn».
 *
 * Kalles av samtykkesiden med brukerens Supabase-token, ikke av Claude. Vi
 * verifiserer sesjonen her i stedet for å bruke `requireAuth`, fordi ruten
 * ligger utenfor `/api` – og fordi det bare er *sesjoner* som kan godkjenne noe:
 * en API-nøkkel eller et eksisterende connector-token skal ikke kunne utstede
 * tilgang til seg selv eller andre.
 */
oauth.post("/approve", async (c) => {
  const header = c.req.header("Authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : null;

  if (!token) throw new HTTPException(401, { message: "Du må være innlogget for å godkjenne." });

  const { data, error } = await supabase.auth.getUser(token);

  if (error || !data.user) {
    throw new HTTPException(401, { message: "Ugyldig eller utløpt sesjon." });
  }

  const body = await c.req.json<{ request?: unknown }>().catch(() => null);
  const sealed = typeof body?.request === "string" ? body.request : null;

  if (!sealed) throw new HTTPException(400, { message: "Forespørselen mangler «request»." });

  const request: ConsentRequest | null = openConsentRequest(sealed);

  if (!request) {
    throw new HTTPException(400, {
      message: "Forespørselen er ugyldig eller utløpt. Start tilkoblingen på nytt fra Claude.",
    });
  }

  // Klienten kan ha blitt slettet mens brukeren sto på samtykkesiden, og
  // `redirect_uris` kan i prinsippet være endret. Vi verifiserer på nytt mot
  // databasen framfor å stole på den signerte kopien alene.
  const client = await findClient(request.clientId);

  if (!client || !isRegisteredRedirectUri(client, request.redirectUri)) {
    throw new HTTPException(400, { message: "Klienten er ikke lenger registrert." });
  }

  const code = await issueAuthorizationCode({
    clientId: request.clientId,
    userId: data.user.id,
    redirectUri: request.redirectUri,
    codeChallenge: request.codeChallenge,
    scope: request.scope,
    resource: request.resource,
  });

  const target = new URL(request.redirectUri);
  target.searchParams.set("code", code);
  if (request.state) target.searchParams.set("state", request.state);

  logger.info(
    { userId: data.user.id, clientId: request.clientId, clientName: client.client_name },
    "MCP-tilkobling godkjent",
  );

  // Nettleseren gjør omdirigeringen, ikke oss: en 302 herfra ville blitt fulgt
  // av `fetch()` i dashboardet, og koden ville havnet i et svar ingen leser.
  return c.json({ redirect_to: target.toString() });
});

/**
 * Kunden avslo, eller lukket siden.
 *
 * Vi sier det til klienten i stedet for å la den vente: `access_denied` er svaret
 * som får Claude til å vise «tilkobling avbrutt» framfor å henge i «kobler til».
 */
oauth.post("/deny", async (c) => {
  const body = await c.req.json<{ request?: unknown }>().catch(() => null);
  const sealed = typeof body?.request === "string" ? body.request : null;
  const request = sealed ? openConsentRequest(sealed) : null;

  if (!request) throw new HTTPException(400, { message: "Ugyldig eller utløpt forespørsel." });

  const target = new URL(request.redirectUri);
  target.searchParams.set("error", "access_denied");
  target.searchParams.set("error_description", "Brukeren avslo tilgangen.");
  if (request.state) target.searchParams.set("state", request.state);

  return c.json({ redirect_to: target.toString() });
});

// --- Token ----------------------------------------------------------------

/**
 * Bytter en kode – eller et refresh-token – i et access-token.
 *
 * Claude sender `application/x-www-form-urlencoded`, som er det RFC 6749
 * foreskriver. Noen klienter sender JSON likevel, så vi tar imot begge: å avvise
 * en ellers gyldig forespørsel på formatet ville vært en connector som feiler av
 * en grunn kunden ikke kan se.
 */
oauth.post("/token", async (c) => {
  const contentType = c.req.header("Content-Type") ?? "";
  let form: Record<string, string> = {};

  if (contentType.includes("application/json")) {
    const body = await c.req.json<Record<string, unknown>>().catch(() => null);
    if (body) {
      for (const [key, value] of Object.entries(body)) {
        if (typeof value === "string") form[key] = value;
      }
    }
  } else {
    const parsed = await c.req.parseBody().catch(() => null);
    if (parsed) {
      for (const [key, value] of Object.entries(parsed)) {
        if (typeof value === "string") form[key] = value;
      }
    }
  }

  /**
   * `client_id` kan komme i kroppen eller som Basic-auth.
   *
   * Klientene våre er offentlige og har ingen hemmelighet, men noen
   * OAuth-biblioteker sender `client_id` som brukernavn i en Basic-header av
   * vane. Vi leser den derfra dersom kroppen ikke har den, framfor å svare
   * `invalid_client` på en forespørsel som er helt i orden.
   */
  let clientId = form.client_id;

  if (!clientId) {
    const auth = c.req.header("Authorization") ?? "";
    if (auth.startsWith("Basic ")) {
      const decoded = Buffer.from(auth.slice("Basic ".length), "base64").toString("utf8");
      clientId = decoded.split(":")[0] ?? "";
    }
  }

  if (!clientId) {
    const { body, status } = oauthError("invalid_client", "client_id mangler", 401);
    return c.json(body, status);
  }

  const client = await findClient(clientId);

  if (!client) {
    const { body, status } = oauthError("invalid_client", "Ukjent client_id", 401);
    return c.json(body, status);
  }

  if (form.grant_type === "refresh_token") {
    if (!form.refresh_token) {
      const { body, status } = oauthError("invalid_request", "refresh_token mangler");
      return c.json(body, status);
    }

    const result = await rotateRefreshToken({
      refreshToken: form.refresh_token,
      clientId,
    });

    if (!result.ok) {
      const { body, status } = oauthError("invalid_grant", result.reason);
      return c.json(body, status);
    }

    return c.json({
      access_token: result.tokens.accessToken,
      token_type: "Bearer",
      expires_in: result.tokens.expiresIn,
      refresh_token: result.tokens.refreshToken,
      scope: result.tokens.scope,
    });
  }

  if (form.grant_type !== "authorization_code") {
    const { body, status } = oauthError(
      "unsupported_grant_type",
      "Støttede grant_type: authorization_code, refresh_token",
    );
    return c.json(body, status);
  }

  if (!form.code || !form.redirect_uri || !form.code_verifier) {
    const { body, status } = oauthError(
      "invalid_request",
      "code, redirect_uri og code_verifier er påkrevd",
    );
    return c.json(body, status);
  }

  const redemption = await redeemAuthorizationCode({
    code: form.code,
    clientId,
    redirectUri: form.redirect_uri,
    codeVerifier: form.code_verifier,
  });

  if (!redemption.ok) {
    const { body, status } = oauthError("invalid_grant", redemption.reason);
    return c.json(body, status);
  }

  try {
    const tokens = await issueTokenPair({
      clientId,
      userId: redemption.code.user_id,
      scope: redemption.code.scope,
      resource: redemption.code.resource,
    });

    logger.info(
      { userId: redemption.code.user_id, clientId, clientName: client.client_name },
      "MCP-token utstedt",
    );

    return c.json({
      access_token: tokens.accessToken,
      token_type: "Bearer",
      expires_in: tokens.expiresIn,
      refresh_token: tokens.refreshToken,
      scope: tokens.scope,
    });
  } catch (error) {
    logger.error({ err: error }, "Kunne ikke utstede token");
    const { body, status } = oauthError("server_error", "Kunne ikke utstede token", 500);
    return c.json(body, status);
  }
});

/**
 * Tilbaketrekking (RFC 7009).
 *
 * Svarer 200 også for et ukjent token, slik spesifikasjonen krever: et 404 her
 * ville gjort endepunktet til et orakel som kan brukes til å avgjøre om en
 * gjettet tokenverdi finnes.
 */
oauth.post("/revoke", async (c) => {
  const parsed = await c.req.parseBody().catch(() => null);
  const token = typeof parsed?.token === "string" ? parsed.token : null;

  if (token) await revokeSingleToken(token);

  return c.body(null, 200);
});
