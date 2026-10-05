import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type { AuthVariables } from "../middleware/auth.js";
import { checkRedirectDomain } from "../services/domain-status.js";
import * as redirects from "../services/redirects.js";
import type { ErrorDetail } from "../types.js";

/**
 * Omdirigeringer: `GET/POST /api/redirects`, `GET/PATCH/DELETE /api/redirects/:id`
 * og `GET /api/redirects/:id/status`.
 *
 * Monteres under `/api`, så `requireAuth` har allerede kjørt. Dette er også det
 * eneste området en nøkkel med `scopes = {redirects}` slipper inn i.
 */
export const redirectsApi = new Hono<{ Variables: AuthVariables }>();

function translate(error: unknown): never {
  if (error instanceof redirects.RedirectError) {
    throw new HTTPException(error.status, {
      message: error.message,
      cause: { code: error.code } satisfies ErrorDetail,
    });
  }
  if (error instanceof z.ZodError) {
    throw new HTTPException(400, {
      message: error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; "),
      cause: { code: "redirect.invalid_input" } satisfies ErrorDetail,
    });
  }
  throw error;
}

const statusCode = z.union([z.literal(301), z.literal(302), z.literal(307), z.literal(308)]);

const createSchema = z.object({
  name: z.string().max(100).nullable().optional(),
  targetUrl: z.string().min(1).max(2048),
  domains: z.array(z.string().min(1).max(253)).min(1).max(redirects.MAX_DOMAINS_PER_REDIRECT),
  statusCode: statusCode.optional(),
  preservePath: z.boolean().optional(),
  externalRef: z.string().max(200).nullable().optional(),
});

const patchSchema = createSchema.omit({ externalRef: true }).partial();

async function body(c: { req: { json: () => Promise<unknown> } }): Promise<unknown> {
  return await c.req.json().catch(() => {
    throw new HTTPException(400, { message: "Forventet en JSON-kropp." });
  });
}

redirectsApi.get("/", async (c) => {
  try {
    const externalRef = c.req.query("externalRef") || undefined;
    return c.json({ redirects: await redirects.listRedirects(c.get("userId"), externalRef) });
  } catch (error) {
    translate(error);
  }
});

redirectsApi.post("/", async (c) => {
  try {
    const input = createSchema.parse(await body(c));
    const result = await redirects.createRedirect(c.get("userId"), input);
    return c.json(result, result.created ? 201 : 200);
  } catch (error) {
    translate(error);
  }
});

redirectsApi.get("/:redirectId", async (c) => {
  try {
    return c.json({ redirect: await redirects.getOwnedRedirect(c.get("userId"), c.req.param("redirectId")) });
  } catch (error) {
    translate(error);
  }
});

redirectsApi.patch("/:redirectId", async (c) => {
  try {
    const patch = patchSchema.parse(await body(c));
    const redirect = await redirects.updateRedirect(c.get("userId"), c.req.param("redirectId"), patch);
    return c.json({ redirect });
  } catch (error) {
    translate(error);
  }
});

redirectsApi.delete("/:redirectId", async (c) => {
  try {
    await redirects.deleteRedirect(c.get("userId"), c.req.param("redirectId"));
    return c.json({ success: true });
  } catch (error) {
    translate(error);
  }
});

/**
 * DNS, rute og sertifikat for hvert domene. Samme måling som DNS-fanen for et
 * prosjekt (`services/domain-status.ts`); sertifikatsjekken kjøres bare når DNS
 * og rute allerede stemmer.
 */
redirectsApi.get("/:redirectId/status", async (c) => {
  try {
    const redirect = await redirects.getOwnedRedirect(c.get("userId"), c.req.param("redirectId"));
    const domains = await Promise.all(redirect.domains.map((domain) => checkRedirectDomain(redirect.id, domain)));
    return c.json({ redirectId: redirect.id, ready: domains.every((d) => d.ready), domains });
  } catch (error) {
    translate(error);
  }
});
