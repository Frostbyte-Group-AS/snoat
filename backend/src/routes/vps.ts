import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { logger } from "../lib/logger.js";
import type { AuthVariables } from "../middleware/auth.js";
import { checkVpsDomain } from "../services/domain-status.js";
import { erEierkonto } from "../services/plans.js";
import * as vpsDomener from "../services/vps-domener.js";
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
    // Domenene er pynt på lista, ikke en forutsetning: feiler oppslaget (f.eks.
    // før migrasjon 0019 er kjørt), vises VPS-ene uten dem.
    const [liste, ram, domener] = await Promise.all([
      vps.listVps(),
      vps.getRamPool(),
      vpsDomener.listVpsDomener(c.get("userId")).catch((error: unknown) => {
        logger.warn({ err: error }, "Kunne ikke hente VPS-domenene til lista");
        return [];
      }),
    ]);
    const medDomener = liste.map((v) => ({
      ...v,
      domener: domener
        .filter((d) => d.vmid === v.vmid)
        .map((d) => ({ domain: d.domain, port: d.port, url: d.url })),
    }));
    return c.json({ vps: medDomener, ram, templates: Object.keys(vps.VPS_TEMPLATES) });
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
    const vmid = vmidParam(c.req.param("vmid"));
    await vps.slettVps(vmid, confirmName);
    // IP-en kan gå til en ny VPS senere. Et domene som sto igjen ville da pekt dit.
    const domenerFjernet = await vpsDomener.fjernDomenerForVmid(vmid);
    return c.json({ deleted: true, domenerFjernet });
  } catch (error) {
    oversett(error);
  }
});

// --- Domener: https://<domene> → <vps-ip>:<port> ----------------------------
//
// Tvillingen til `/api/redirects` (se `services/vps-domener.ts`). `POST` lager
// eller endrer – domenet er unikt på tvers av alle kontoer, så samme kall to
// ganger gir samme rad. Sletting og status har domenet i stien.

/** Hono har allerede dekodet stien, så `von.osia.no` kommer som det er. */
const domeneParam = (raw: string) => {
  const domene = raw.trim();
  if (domene === "" || domene.length > 253) {
    throw new HTTPException(400, { message: "Ugyldig domene", cause: { code: "vps.invalid_domain" } satisfies ErrorDetail });
  }
  return domene;
};

const domeneSchema = z.object({
  domain: z.string().min(1).max(253),
  port: z.number().int().min(1).max(65535),
});

vpsApi.get("/:vmid/domener", async (c) => {
  try {
    const vmid = vmidParam(c.req.param("vmid"));
    return c.json({ domener: await vpsDomener.listVpsDomener(c.get("userId"), vmid) });
  } catch (error) {
    oversett(error);
  }
});

vpsApi.post("/:vmid/domener", async (c) => {
  try {
    const { domain, port } = domeneSchema.parse(await c.req.json().catch(() => ({})));
    const result = await vpsDomener.settVpsDomene(c.get("userId"), vmidParam(c.req.param("vmid")), domain, port);
    return c.json(result, result.opprettet ? 201 : 200);
  } catch (error) {
    oversett(error);
  }
});

vpsApi.delete("/:vmid/domener/:domene", async (c) => {
  try {
    await vpsDomener.fjernVpsDomene(
      c.get("userId"),
      vmidParam(c.req.param("vmid")),
      domeneParam(c.req.param("domene")),
    );
    return c.json({ deleted: true });
  } catch (error) {
    oversett(error);
  }
});

/**
 * DNS, rute, sertifikat og om VPS-en svarer på porten. Samme måling som for en
 * omdirigering (`services/domain-status.ts`), pluss upstream-sjekken.
 */
vpsApi.get("/:vmid/domener/:domene/status", async (c) => {
  try {
    const domene = await vpsDomener.getVpsDomene(
      c.get("userId"),
      vmidParam(c.req.param("vmid")),
      domeneParam(c.req.param("domene")),
    );
    const upstream = domene.ip ? vpsDomener.upstreamFor(domene.ip, domene.port) : null;
    return c.json({ vmid: domene.vmid, ...(await checkVpsDomain(domene.id, domene.domain, upstream)) });
  } catch (error) {
    oversett(error);
  }
});
