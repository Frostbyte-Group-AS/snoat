import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type { AuthVariables } from "../middleware/auth.js";
import { erEierkonto } from "../services/plans.js";
import * as selv from "../services/selvoppdatering.js";
import type { ErrorDetail } from "../types.js";

/**
 * Snoat selv: hvilken commit som kjører, byggene fra main, og «deploy nå».
 *
 * Kun eierkontoen, som VPS-ene. Plattformen er ikke et prosjekt i databasen –
 * den har ingen container Snoat styrer, ingen rute og ingen plan – men den vises
 * ved siden av prosjektene, så den som eier Snoat kan følge med på den samme sted.
 *
 * Monteres under `/api`, så `requireAuth` har allerede kjørt.
 */
export const plattformApi = new Hono<{ Variables: AuthVariables }>();

plattformApi.use("*", async (c, next) => {
  if (!(await erEierkonto(c.get("userId")))) {
    throw new HTTPException(403, {
      message: "Plattformen er bare tilgjengelig for eierkontoen",
      cause: { code: "plattform.owner_only" } satisfies ErrorDetail,
    });
  }
  await next();
});

function oversett(error: unknown): never {
  if (error instanceof selv.SelvoppdateringError) {
    throw new HTTPException(error.status, { message: error.message, cause: { code: error.code } satisfies ErrorDetail });
  }
  if (error instanceof z.ZodError) {
    throw new HTTPException(400, {
      message: error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; "),
      cause: { code: "plattform.invalid_input" } satisfies ErrorDetail,
    });
  }
  throw error;
}

plattformApi.get("/", async (c) => {
  try {
    return c.json(await selv.hentStatus());
  } catch (error) {
    oversett(error);
  }
});

plattformApi.get("/bygg/:byggId/logg", async (c) => {
  try {
    return c.json({ logg: await selv.hentLogg(c.req.param("byggId")) });
  } catch (error) {
    oversett(error);
  }
});

plattformApi.post("/deploy", async (c) => {
  try {
    const { commit } = z
      .object({ commit: z.string().trim().toLowerCase().nullable().optional() })
      .parse(await c.req.json().catch(() => ({})));
    const via = c.get("authKind") === "session" ? "dashboard" : c.get("authKind") === "oauth" ? "mcp" : "api";
    return c.json(await selv.bestill(commit || null, `${via}:${c.get("userEmail") ?? c.get("userId")}`), 202);
  } catch (error) {
    oversett(error);
  }
});

plattformApi.post("/pause", async (c) => {
  try {
    const { pause } = z.object({ pause: z.boolean() }).parse(await c.req.json().catch(() => ({})));
    return c.json(await selv.settPause(pause));
  } catch (error) {
    oversett(error);
  }
});
