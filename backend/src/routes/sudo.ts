import type { Context } from "hono";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { AuthVariables } from "../middleware/auth.js";
import { erEierkonto } from "../services/plans.js";
import * as sudo from "../services/sudo.js";
import type { ErrorDetail } from "../types.js";

/**
 * Sudo-panelet: alle brukere og alle prosjekter på plattformen.
 *
 * To krav, begge i backend:
 *
 * 1. **Eierkontoen** (`SNOAT_OWNER_ACCOUNTS`), som VPS-ene og plattformen.
 * 2. **Innlogget i dashboardet** (`authKind === "session"`). En API-nøkkel eller
 *    en MCP-tilkobling på eierkontoen får ikke se andre kunders data. VPS-er og
 *    plattformen er eierens egne ting; dette er alle andres, og en lekket nøkkel
 *    skal ikke være nok til å liste dem.
 *
 * Monteres under `/api`, så `requireAuth` har allerede kjørt.
 */
export const sudoApi = new Hono<{ Variables: AuthVariables }>();

async function harSudo(c: Context<{ Variables: AuthVariables }>): Promise<boolean> {
  return c.get("authKind") === "session" && (await erEierkonto(c.get("userId")));
}

/** Dashboardet spør her om menyen skal vises. Svarer alltid 200. */
sudoApi.get("/tilgang", async (c) => c.json({ sudo: await harSudo(c) }));

sudoApi.use("*", async (c, next) => {
  if (!(await harSudo(c))) {
    throw new HTTPException(403, {
      message: "Sudo er bare tilgjengelig for eierkontoen, innlogget i dashboardet",
      cause: { code: "sudo.owner_only" } satisfies ErrorDetail,
    });
  }
  await next();
});

sudoApi.get("/", async (c) => c.json(await sudo.hentOversikt()));
