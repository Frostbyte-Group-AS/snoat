import { Hono } from "hono";
import { logger } from "../lib/logger.js";
import { isApiKey, touchApiKey, verifyApiKey } from "../lib/api-keys.js";
import { isOauthAccessToken, touchToken, verifyAccessToken } from "../lib/oauth.js";
import { mcpResourceUrl, publicApiUrl } from "../lib/public-url.js";
import {
  MCP_INSTRUCTIONS,
  MCP_TOOLS,
  MCP_TOOLS_BY_NAME,
  type McpToolContext,
} from "../services/mcp-tools.js";
import { api } from "./api.js";

/**
 * MCP-endepunktet – én URL kunden limer inn i Claude.
 *
 * Transporten er «Streamable HTTP»: klienten POSTer JSON-RPC hit og får svaret i
 * kroppen. Vi holder ingen sesjon (ingen `Mcp-Session-Id`), og det er et bevisst
 * valg – hver forespørsel bærer sitt eget token, så to backend-instanser bak
 * Caddy kan svare på annenhver forespørsel uten å dele noe seg imellom. En
 * sesjonsbundet server ville krevd delt tilstand for å tåle mer enn én instans.
 *
 * **Monteres før `/api` med vilje.** `routes/api.ts` legger `requireAuth` på alt
 * under seg, og den kaster 401 med vårt eget JSON-format. Denne ruten må svare
 * med `WWW-Authenticate` i stedet – det er den headeren som forteller Claude hvor
 * OAuth-oppdagelsen begynner, og uten den kan connectoren aldri koble seg til.
 * Hono matcher i registreringsrekkefølge, så denne svarer først. Bytter du om på
 * de to linjene i `index.ts`, får kunden «Mangler Authorization-header» i stedet
 * for en innloggingsdialog.
 */
export const mcp = new Hono();

const SERVER_NAME = "snoat";
const SERVER_VERSION = "2.0.0";

/**
 * Protokollversjonene vi kan snakke.
 *
 * Klienten oppgir sin i `initialize`, og vi svarer med den dersom vi kjenner
 * den. Gjør vi ikke det, svarer vi med vår nyeste og lar klienten avgjøre om den
 * kan leve med det – det er slik MCP sin versjonsforhandling er ment å virke.
 */
const SUPPORTED_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const LATEST_PROTOCOL_VERSION = SUPPORTED_PROTOCOL_VERSIONS[0]!;

type JsonRpcId = string | number | null;

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: JsonRpcId;
  method?: string;
  params?: Record<string, unknown>;
}

/** JSON-RPC 2.0 sine standardkoder. */
const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;

function result(id: JsonRpcId, value: unknown) {
  return { jsonrpc: "2.0", id, result: value };
}

function failure(id: JsonRpcId, code: number, message: string) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

// --- Autentisering ---------------------------------------------------------

interface Caller {
  userId: string;
  /** Headeren vi videresender på interne kall, slik `requireAuth` ser det samme. */
  authorization: string;
  via: "oauth" | "api_key";
}

/**
 * Verifiserer tokenet, og sier hvor OAuth begynner hvis det mangler.
 *
 * Begge legitimasjonstyper godtas. OAuth-tokenet er det Claude og andre
 * connector-klienter får gjennom samtykkeflyten; `snoat_ak_…` er for klienter som
 * settes opp fra en kommandolinje og kan sende en header selv – Claude Code,
 * Cursor, et skript. Å støtte begge koster én ekstra gren her, og sparer kunden
 * for å velge oppsett før hen vet hvilken klient hen ender med.
 */
async function authenticate(authorization: string | undefined): Promise<Caller | null> {
  const token = authorization?.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length).trim()
    : null;

  if (!token) return null;

  if (isOauthAccessToken(token)) {
    const accessToken = await verifyAccessToken(token);
    if (!accessToken) return null;

    touchToken(accessToken.id);
    return { userId: accessToken.user_id, authorization: `Bearer ${token}`, via: "oauth" };
  }

  if (isApiKey(token)) {
    const key = await verifyApiKey(token);
    if (!key) return null;

    touchApiKey(key.id);
    return { userId: key.user_id, authorization: `Bearer ${token}`, via: "api_key" };
  }

  return null;
}

/**
 * 401 med veien videre.
 *
 * `resource_metadata` er det RFC 9728 foreskriver, og det Claude leser for å
 * finne autorisasjonsserveren. Uten den vet klienten bare at den ble avvist –
 * ikke at det finnes en innlogging å gjennomføre.
 */
function unauthorized(c: Parameters<typeof mcpResourceUrl>[0], detail: string) {
  const metadataUrl = `${publicApiUrl(c)}/.well-known/oauth-protected-resource`;

  c.header(
    "WWW-Authenticate",
    `Bearer realm="Snoat MCP", resource_metadata="${metadataUrl}", error="invalid_token", error_description="${detail}"`,
  );

  return c.json(failure(null, INVALID_REQUEST, detail), 401);
}

// --- Interne kall ---------------------------------------------------------

/**
 * Lar et verktøy kalle vårt eget REST-API med kallerens legitimasjon.
 *
 * `api.fetch()` kjører hele kjeden i `routes/api.ts`: `requireAuth`,
 * `loadOwnedProject`, plangrenser, opprydding. Verktøyene arver dermed
 * tilgangskontrollen i stedet for å gjenskape den, og et nytt sperrepunkt i et
 * endepunkt gjelder automatisk for Claude også.
 *
 * Merk at feilene må hentes ut av kroppen her. `app.onError` i `index.ts` gjør
 * en `HTTPException` til vårt JSON-format, men den kjører på ytterste app – en
 * `api.fetch()` går ikke gjennom den, så svaret kan være enten JSON eller
 * Hono sin egen tekst. Vi tåler begge.
 */
function toolContext(caller: Caller): McpToolContext {
  return {
    async call(method, path, body) {
      const request = new Request(`http://internal${path}`, {
        method,
        headers: {
          Authorization: caller.authorization,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });

      const response = await api.fetch(request);
      const text = await response.text();

      let data: unknown = null;
      let errorMessage: string | null = null;

      if (text) {
        try {
          data = JSON.parse(text);
          if (!response.ok) {
            errorMessage = (data as { error?: string }).error ?? null;
          }
        } catch {
          // Ikke JSON: da er det Hono sin egen feiltekst, som er bedre enn
          // ingenting.
          if (!response.ok) errorMessage = text.slice(0, 500);
        }
      }

      return {
        ok: response.ok,
        status: response.status,
        data,
        error: response.ok
          ? null
          : (errorMessage ?? `Kallet mot ${path} feilet med status ${response.status}`),
      };
    },
  };
}

// --- JSON-RPC-metodene ---------------------------------------------------

async function handleRequest(
  message: JsonRpcRequest,
  caller: Caller,
): Promise<Record<string, unknown> | null> {
  const id = message.id ?? null;

  switch (message.method) {
    case "initialize": {
      const requested = message.params?.protocolVersion;
      const version =
        typeof requested === "string" && SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
          ? requested
          : LATEST_PROTOCOL_VERSION;

      return result(id, {
        protocolVersion: version,
        // Kun `tools`. Vi har ingen resources eller prompts, og en klient som får
        // dem oppgitt vil kalle `resources/list` og få en feil tilbake.
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: SERVER_NAME, title: "Snoat", version: SERVER_VERSION },
        instructions: MCP_INSTRUCTIONS,
      });
    }

    case "ping":
      return result(id, {});

    case "tools/list":
      return result(id, {
        tools: MCP_TOOLS.map((tool) => ({
          name: tool.name,
          title: tool.title,
          description: tool.description,
          inputSchema: tool.inputSchema,
          annotations: { title: tool.title, ...tool.annotations },
        })),
      });

    case "tools/call": {
      const name = message.params?.name;

      if (typeof name !== "string") {
        return failure(id, INVALID_PARAMS, "params.name mangler");
      }

      const tool = MCP_TOOLS_BY_NAME.get(name);

      if (!tool) {
        return failure(id, METHOD_NOT_FOUND, `Ukjent verktøy: ${name}`);
      }

      try {
        const outcome = await tool.run(message.params?.arguments ?? {}, toolContext(caller));

        const content: Array<{ type: "text"; text: string }> = [
          { type: "text", text: outcome.summary },
        ];

        if (outcome.data !== undefined) {
          content.push({ type: "text", text: JSON.stringify(outcome.data, null, 2) });
        }

        return result(id, { content, isError: false });
      } catch (error) {
        /**
         * Verktøyfeil hører i innholdet, ikke i `error`-feltet.
         *
         * En JSON-RPC-feil betyr at *protokollen* gikk galt, og klienten skjuler
         * den for modellen. «Du har brukt opp byggeminuttene dine» er derimot noe
         * modellen skal få lese og kunne svare kunden på – derfor `isError: true`
         * på et ellers vellykket svar, slik MCP-spesifikasjonen foreskriver.
         */
        const detail = error instanceof Error ? error.message : String(error);

        logger.warn(
          { err: error, tool: name, userId: caller.userId },
          "MCP-verktøy feilet",
        );

        return result(id, {
          content: [{ type: "text", text: `Verktøyet «${name}» feilet: ${detail}` }],
          isError: true,
        });
      }
    }

    // Klienter spør etter disse selv om vi ikke oppgir dem i `capabilities`.
    // Et tomt svar er mer presist enn en feil, og hindrer at en klient som ikke
    // leser capabilities skriver «server error» i loggen sin ved oppkobling.
    case "resources/list":
      return result(id, { resources: [] });
    case "resources/templates/list":
      return result(id, { resourceTemplates: [] });
    case "prompts/list":
      return result(id, { prompts: [] });

    default:
      // Notifikasjoner har ingen `id` og skal aldri besvares – heller ikke med en
      // feil. `notifications/initialized` er den vi faktisk får.
      if (message.id === undefined || message.id === null) return null;

      return failure(id, METHOD_NOT_FOUND, `Ukjent metode: ${message.method}`);
  }
}

// --- Rutene --------------------------------------------------------------

mcp.post("/", async (c) => {
  const caller = await authenticate(c.req.header("Authorization"));

  if (!caller) {
    return unauthorized(
      c,
      c.req.header("Authorization")
        ? "Tilgangen er ugyldig, utløpt eller trukket tilbake."
        : "Denne MCP-serveren krever innlogging.",
    );
  }

  const payload = await c.req.json<unknown>().catch(() => undefined);

  if (payload === undefined) {
    return c.json(failure(null, PARSE_ERROR, "Kroppen må være gyldig JSON"), 400);
  }

  /**
   * Batch: en liste av meldinger skal besvares med en liste av svar – men bare
   * de som faktisk har en `id`. Er alt notifikasjoner, er riktig svar 202 uten
   * kropp.
   */
  if (Array.isArray(payload)) {
    const responses: Array<Record<string, unknown>> = [];

    for (const message of payload as JsonRpcRequest[]) {
      const response = await handleRequest(message, caller);
      if (response) responses.push(response);
    }

    if (responses.length === 0) return c.body(null, 202);
    return c.json(responses);
  }

  const message = payload as JsonRpcRequest;

  if (!message || typeof message !== "object" || typeof message.method !== "string") {
    return c.json(failure(null, INVALID_REQUEST, "Meldingen mangler «method»"), 400);
  }

  try {
    const response = await handleRequest(message, caller);

    // Notifikasjon: mottatt, ingenting å svare.
    if (!response) return c.body(null, 202);

    return c.json(response);
  } catch (error) {
    logger.error({ err: error, method: message.method }, "Ubehandlet feil i MCP-endepunktet");
    return c.json(failure(message.id ?? null, INTERNAL_ERROR, "Intern feil"), 500);
  }
});

/**
 * GET er for serverinitiert strømming, som vi ikke har.
 *
 * 405 er det spesifikasjonen ber om når serveren ikke tilbyr en SSE-strøm, og
 * klienten skal da bare la være. Vi tar likevel autentiseringen først: en klient
 * som prøver GET før POST skal få innloggingsdialogen, ikke et blankt avslag.
 */
mcp.get("/", async (c) => {
  const caller = await authenticate(c.req.header("Authorization"));

  if (!caller) {
    return unauthorized(c, "Denne MCP-serveren krever innlogging.");
  }

  c.header("Allow", "POST, DELETE");
  return c.json(failure(null, INVALID_REQUEST, "Denne serveren tilbyr ingen SSE-strøm"), 405);
});

/**
 * Avslutning av sesjon. Vi har ingen tilstand å rydde, men svarer pent:
 * en klient som får 404 her viser gjerne en feil ved frakobling.
 */
mcp.delete("/", (c) => c.body(null, 204));
