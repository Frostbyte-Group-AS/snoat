import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type { AuthVariables } from "../middleware/auth.js";
import { erEierkonto } from "../services/plans.js";
import * as vps from "../services/vps.js";
import type { ErrorDetail } from "../types.js";

/**
 * VPS-er på Proxmox – kun for eierkontoen (`SNOAT_OWNER_ACCOUNTS`).
 *
 * For alle andre er Snoat et Vercel-alternativ og ingenting mer: de får 403 her,
 * verktøyene skjules i MCP, og dashboardet viser ikke menyen. Grensen sitter i
 * backend, ikke i frontend – skjulte knapper er ingen tilgangskontroll.
 *
 * Monteres under `/api`, så `requireAuth` har allerede kjørt.
 */
export const vpsApi = new Hono<{ Variables: AuthVariables }>();

/** Dashboardet spør her om menyen skal vises. Svarer alltid 200. */
vpsApi.get("/tilgang", async (c) => {
  const eier = await erEierkonto(c.get("userId"));
  return c.json({ eier, konfigurert: eier && vps.vpsKonfigurert() });
});

vpsApi.use("*", async (c, next) => {
  if (!(await erEierkonto(c.get("userId")))) {
    throw new HTTPException(403, {
      message: "VPS-er er ikke tilgjengelig for denne kontoen",
      cause: { code: "vps.owner_only" } satisfies ErrorDetail,
    });
  }
  await next();
});

function oversett(error: unknown): never {
  if (error instanceof vps.VpsError) {
    throw new HTTPException(error.status as 400, { message: error.message, cause: { code: error.code } satisfies ErrorDetail });
  }
  if (error instanceof z.ZodError) {
    throw new HTTPException(400, {
      message: error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; "),
      cause: { code: "vps.invalid_input" } satisfies ErrorDetail,
    });
  }
  throw error;
}

const vmidParam = (raw: string) => {
  const vmid = Number(raw);
  if (!Number.isInteger(vmid) || vmid <= 0) {
    throw new HTTPException(400, { message: "Ugyldig VPS-ID", cause: { code: "vps.invalid_id" } satisfies ErrorDetail });
  }
  return vmid;
};

const templateSchema = z.enum(Object.keys(vps.VPS_TEMPLATES) as [vps.VpsTemplate, ...vps.VpsTemplate[]]);

const nySchema = z.object({
  name: z.string().min(2).max(40),
  template: templateSchema.optional(),
  cores: z.number().int().min(1).max(256).optional(),
  diskGb: z.number().int().min(4).max(300).optional(),
  memoryMaxMb: z.number().int().min(256).optional(),
  memoryMinMb: z.number().int().min(0).optional(),
  sshPublicKeys: z.array(z.string().min(20).max(4096)).max(20).optional(),
});

const endreSchema = z.object({
  cores: z.number().int().min(1).max(256).optional(),
  memoryMaxMb: z.number().int().min(256).optional(),
  memoryMinMb: z.number().int().min(0).optional(),
});

vpsApi.get("/", async (c) => {
  try {
    const [liste, ram] = await Promise.all([vps.listVps(), vps.getRamPool()]);
    return c.json({ vps: liste, ram, templates: Object.keys(vps.VPS_TEMPLATES) });
  } catch (error) {
    oversett(error);
  }
});

vpsApi.post("/", async (c) => {
  try {
    const input = nySchema.parse(await c.req.json());
    return c.json({ vps: await vps.createVps(input) }, 201);
  } catch (error) {
    oversett(error);
  }
});

/** Ledig CPU, RAM og disk, og grensene «Ny VPS»-menyen skal holde seg innenfor. */
vpsApi.get("/ressurser", async (c) => {
  try {
    return c.json({ ressurser: await vps.getRessurser(), templates: Object.keys(vps.VPS_TEMPLATES) });
  } catch (error) {
    oversett(error);
  }
});

vpsApi.get("/ram", async (c) => {
  try {
    return c.json({ ram: await vps.getRamPool() });
  } catch (error) {
    oversett(error);
  }
});

vpsApi.patch("/ram", async (c) => {
  try {
    const { reservertMb } = z.object({ reservertMb: z.number().int() }).parse(await c.req.json());
    return c.json({ ram: await vps.setRamPool(reservertMb) });
  } catch (error) {
    oversett(error);
  }
});

vpsApi.get("/:vmid", async (c) => {
  try {
    return c.json({ vps: await vps.getVps(vmidParam(c.req.param("vmid"))) });
  } catch (error) {
    oversett(error);
  }
});

vpsApi.patch("/:vmid", async (c) => {
  try {
    const endring = endreSchema.parse(await c.req.json());
    return c.json({ vps: await vps.oppdaterVps(vmidParam(c.req.param("vmid")), endring) });
  } catch (error) {
    oversett(error);
  }
});

vpsApi.post("/:vmid/:handling{start|shutdown|stop|reboot}", async (c) => {
  try {
    const handling = c.req.param("handling") as vps.VpsHandling;
    return c.json({ vps: await vps.vpsHandling(vmidParam(c.req.param("vmid")), handling) });
  } catch (error) {
    oversett(error);
  }
});

vpsApi.delete("/:vmid", async (c) => {
  try {
    const { confirmName } = z.object({ confirmName: z.string().min(1) }).parse(await c.req.json().catch(() => ({})));
    await vps.slettVps(vmidParam(c.req.param("vmid")), confirmName);
    return c.json({ deleted: true });
  } catch (error) {
    oversett(error);
  }
});
