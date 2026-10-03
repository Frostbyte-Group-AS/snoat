import https from "node:https";
import tls from "node:tls";
import { config } from "../config.js";
import { logger } from "../lib/logger.js";

/**
 * VPS-er for eierkontoen, som LXC-containere på Proxmox-verten.
 *
 * Hvorfor LXC og ikke KVM: en LXC-container bruker bare minnet prosessene faktisk
 * bruker, og sidebufferen den fyller kan kjernen ta tilbake. En KVM-gjest holder på
 * minnet den en gang har rørt. Kravet er at VPS-ene skal kunne bruke alt ledig
 * minne, men aldri mer enn et tak som lar resten av serveren leve – det er nøyaktig
 * det cgroup v2 gir for containere, og det KVM bare kan tilnærme med ballong.
 *
 * Minnemodellen (samme idé som Kubernetes' `system-reserved` og Incus' myke grenser):
 *
 *  - **Reservert** (`ram-reservert-mb=` i poolens kommentar): RAM som alltid er igjen
 *    til resten av verten – Snoat-VM-en, Proxmox og kjernen.
 *  - **Gruppetak** = verts-RAM − reservert. Settes som `memory.max` på foreldre-
 *    cgroupen `/sys/fs/cgroup/lxc`, så alle VPS-ene *til sammen* aldri kan ta mer.
 *  - **Maks per VPS** (Proxmox' `memory`): standard er hele verts-RAM-en, altså
 *    «ingen egen grense» – gruppetaket bestemmer. Kan settes lavere.
 *  - **Garantert per VPS** (`snoat-ram-min-mb=` i beskrivelsen) blir `memory.low`:
 *    minnet VPS-en beholder når de andre presser.
 *
 * API-tokenet er ikke root og kan derfor ikke skrive cgroups selv. Det skriver bare
 * ønsket tilstand (poolkommentar, beskrivelse), og tjenesten `snoat-vps-avstem` på
 * verten oversetter hvert 15. sekund. Se CONTEXT_FOR_AI/14_vps.md.
 */

export class VpsError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code: string,
  ) {
    super(message);
  }
}

export interface Vps {
  vmid: number;
  name: string;
  status: string;
  ip: string | null;
  ssh: { host: string; port: number; command: string } | null;
  cores: number | null;
  memoryMaxMb: number | null;
  memoryMinMb: number;
  memoryUsedMb: number | null;
  diskGb: number | null;
  diskUsedGb: number | null;
  uptimeS: number | null;
}

export interface RamPool {
  totalMb: number;
  reservertMb: number;
  takMb: number;
  iBrukMb: number;
  garantertMb: number;
  ledigITaketMb: number;
}

export const VPS_TEMPLATES = {
  "debian-12": "debian-12-standard",
  "debian-13": "debian-13-standard",
  "ubuntu-24.04": "ubuntu-24.04-standard",
} as const;
export type VpsTemplate = keyof typeof VPS_TEMPLATES;

export const MIN_RESERVERT_MB = 8192;
const STANDARD_RESERVERT_MB = 57344;

// --- Rene hjelpere (testes i vps.test.ts) -----------------------------------

export function parseReservert(comment: string | null | undefined): number {
  const match = /ram-reservert-mb=(\d+)/.exec(comment ?? "");
  return Math.max(match ? Number(match[1]) : STANDARD_RESERVERT_MB, MIN_RESERVERT_MB);
}

export function medReservert(comment: string | null | undefined, mb: number): string {
  const tekst = comment ?? "";
  return /ram-reservert-mb=\d+/.test(tekst)
    ? tekst.replace(/ram-reservert-mb=\d+/, `ram-reservert-mb=${mb}`)
    : `${tekst}${tekst ? " " : ""}ram-reservert-mb=${mb}`;
}

export function parseMinRam(description: string | null | undefined): number {
  const match = /snoat-ram-min-mb=(\d+)/.exec(description ?? "");
  return match ? Number(match[1]) : 0;
}

export function medMinRam(description: string | null | undefined, mb: number): string {
  const tekst = description ?? "";
  return /snoat-ram-min-mb=\d+/.test(tekst)
    ? tekst.replace(/snoat-ram-min-mb=\d+/, `snoat-ram-min-mb=${mb}`)
    : `${tekst}${tekst ? "\n" : ""}snoat-ram-min-mb=${mb}`;
}

export function ipFraNet0(net0: string | null | undefined): string | null {
  const match = /ip=(\d+\.\d+\.\d+\.\d+)\//.exec(net0 ?? "");
  return match?.[1] ?? null;
}

export function ledigIp(brukt: ReadonlySet<string>, subnet: string, forste: number, siste: number): string | null {
  for (let i = forste; i <= siste; i++) {
    const ip = `${subnet}.${i}`;
    if (!brukt.has(ip)) return ip;
  }
  return null;
}

export function sshPortFor(vmid: number, vmidBase: number, portBase: number): number | null {
  const offset = vmid - vmidBase;
  return offset >= 0 && offset < 1000 ? portBase + offset : null;
}

/** Ett DNS-label, som også er gyldig som Proxmox-hostname. */
export function gyldigVpsNavn(navn: string): boolean {
  return /^[a-z][a-z0-9-]{0,38}[a-z0-9]$/.test(navn);
}

// --- Proxmox-klient ---------------------------------------------------------

export function vpsKonfigurert(): boolean {
  return Boolean(
    config.SNOAT_PROXMOX_URL &&
      config.SNOAT_PROXMOX_TOKEN_ID &&
      config.SNOAT_PROXMOX_TOKEN_SECRET &&
      config.SNOAT_PROXMOX_CA_PEM_B64,
  );
}

function kreverKonfigurasjon(): void {
  if (!vpsKonfigurert()) {
    throw new VpsError(503, "VPS-er er ikke konfigurert på denne Snoat-instansen", "vps.not_configured");
  }
}

let agent: https.Agent | null = null;
function proxmoxAgent(): https.Agent {
  if (!agent) {
    const ca = Buffer.from(config.SNOAT_PROXMOX_CA_PEM_B64 ?? "", "base64").toString("utf8");
    agent = new https.Agent({
      ca,
      keepAlive: true,
      servername: config.SNOAT_PROXMOX_TLS_NAME,
      // Kjeden verifiseres mot Proxmox-CA-en over; navnet sjekkes mot det som
      // faktisk står i sertifikatet, ikke mot IP-en vi kobler til.
      checkServerIdentity: (_host, cert) => tls.checkServerIdentity(config.SNOAT_PROXMOX_TLS_NAME, cert),
    });
  }
  return agent;
}

type Params = Record<string, string | number | boolean | undefined>;

function encode(params: Params): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue;
    search.append(key, typeof value === "boolean" ? (value ? "1" : "0") : String(value));
  }
  return search.toString();
}

async function pve<T>(method: "GET" | "POST" | "PUT" | "DELETE", path: string, params: Params = {}): Promise<T> {
  kreverKonfigurasjon();
  const base = new URL(config.SNOAT_PROXMOX_URL as string);
  const query = method === "GET" || method === "DELETE" ? encode(params) : "";
  const body = method === "POST" || method === "PUT" ? encode(params) : "";

  return await new Promise<T>((resolve, reject) => {
    const req = https.request(
      {
        method,
        host: base.hostname,
        port: base.port || 8006,
        path: `/api2/json${path}${query ? `?${query}` : ""}`,
        agent: proxmoxAgent(),
        timeout: 30_000,
        headers: {
          Authorization: `PVEAPIToken=${config.SNOAT_PROXMOX_TOKEN_ID}=${config.SNOAT_PROXMOX_TOKEN_SECRET}`,
          ...(body ? { "Content-Type": "application/x-www-form-urlencoded", "Content-Length": Buffer.byteLength(body) } : {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let json: { data?: T; message?: string; errors?: Record<string, string> } = {};
          try {
            json = text ? JSON.parse(text) : {};
          } catch {
            /* Proxmox svarer av og til med ren tekst ved feil. */
          }
          const status = res.statusCode ?? 500;
          if (status >= 200 && status < 300) return resolve(json.data as T);
          const detaljer = json.errors ? ` (${Object.entries(json.errors).map(([k, v]) => `${k}: ${v}`).join("; ")})` : "";
          const melding = `${(json.message ?? text ?? "").trim() || `HTTP ${status}`}${detaljer}`;
          reject(new VpsError(status === 401 || status === 403 ? 502 : status >= 500 ? 502 : 400, `Proxmox: ${melding}`, "vps.proxmox"));
        });
      },
    );
    req.on("timeout", () => req.destroy(new Error("tidsavbrudd mot Proxmox")));
    req.on("error", (error) => reject(new VpsError(502, `Proxmox svarer ikke: ${error.message}`, "vps.unreachable")));
    if (body) req.write(body);
    req.end();
  });
}

const node = () => encodeURIComponent(config.SNOAT_PROXMOX_NODE);

/** Venter på en Proxmox-oppgave (UPID) og kaster hvis den ikke endte med OK. */
async function ventPaOppgave(upid: string, maksMs = 180_000): Promise<void> {
  const slutt = Date.now() + maksMs;
  while (Date.now() < slutt) {
    const status = await pve<{ status: string; exitstatus?: string }>(
      "GET",
      `/nodes/${node()}/tasks/${encodeURIComponent(upid)}/status`,
    );
    if (status.status === "stopped") {
      if (status.exitstatus === "OK" || status.exitstatus?.startsWith("WARNINGS")) return;
      throw new VpsError(502, `Proxmox-oppgaven feilet: ${status.exitstatus ?? "ukjent"}`, "vps.task_failed");
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new VpsError(504, "Proxmox-oppgaven ble ikke ferdig i tide", "vps.task_timeout");
}

interface PoolMember {
  vmid: number;
  type: string;
  name?: string;
  status?: string;
  maxmem?: number;
  mem?: number;
  maxdisk?: number;
  disk?: number;
  uptime?: number;
  maxcpu?: number;
}

interface Pool {
  poolid: string;
  comment?: string;
  members: PoolMember[];
}

async function hentPool(): Promise<Pool> {
  const pool = config.SNOAT_PROXMOX_POOL;
  try {
    const liste = await pve<Pool[] | Pool>("GET", "/pools", { poolid: pool });
    const funnet = Array.isArray(liste) ? liste.find((p) => p.poolid === pool) : liste;
    if (funnet && Array.isArray(funnet.members)) return funnet;
  } catch (error) {
    logger.debug({ err: error }, "GET /pools?poolid feilet, prøver eldre form");
  }
  const eldre = await pve<Omit<Pool, "poolid">>("GET", `/pools/${encodeURIComponent(pool)}`);
  return { poolid: pool, ...eldre, members: eldre.members ?? [] };
}

async function lagrePoolKommentar(comment: string): Promise<void> {
  const pool = config.SNOAT_PROXMOX_POOL;
  try {
    await pve("PUT", "/pools", { poolid: pool, comment });
  } catch {
    await pve("PUT", `/pools/${encodeURIComponent(pool)}`, { comment });
  }
}

interface LxcConfig {
  hostname?: string;
  net0?: string;
  description?: string;
  cores?: number;
  memory?: number;
}

const lxcConfig = (vmid: number) => pve<LxcConfig>("GET", `/nodes/${node()}/lxc/${vmid}/config`);

function sshFor(vmid: number): Vps["ssh"] {
  const host = config.SNOAT_VPS_PUBLIC_HOST;
  const port = sshPortFor(vmid, config.SNOAT_VPS_VMID_BASE, config.SNOAT_VPS_SSH_PORT_BASE);
  if (!host || port === null) return null;
  return { host, port, command: `ssh -p ${port} root@${host}` };
}

function tilVps(member: PoolMember, cfg: LxcConfig): Vps {
  const mb = (bytes?: number) => (bytes === undefined ? null : Math.round(bytes / 2 ** 20));
  const gb = (bytes?: number) => (bytes === undefined ? null : Math.round((bytes / 2 ** 30) * 10) / 10);
  return {
    vmid: member.vmid,
    name: cfg.hostname ?? member.name ?? `ct${member.vmid}`,
    status: member.status ?? "ukjent",
    ip: ipFraNet0(cfg.net0),
    ssh: sshFor(member.vmid),
    cores: cfg.cores ?? member.maxcpu ?? null,
    memoryMaxMb: cfg.memory ?? mb(member.maxmem),
    memoryMinMb: parseMinRam(cfg.description),
    memoryUsedMb: mb(member.mem),
    diskGb: gb(member.maxdisk),
    diskUsedGb: gb(member.disk),
    uptimeS: member.uptime ?? null,
  };
}

/**
 * Poolens medlemsliste kommer fra klyngens ressursoversikt, som henger noen
 * sekunder etter: en VPS som nettopp er laget står som uten status. Status og
 * forbruk hentes derfor fra containeren selv og legges over.
 */
async function medStatus(member: PoolMember): Promise<PoolMember> {
  try {
    const naa = await pve<Partial<PoolMember>>("GET", `/nodes/${node()}/lxc/${member.vmid}/status/current`);
    return { ...member, ...naa, vmid: member.vmid, type: member.type };
  } catch {
    return member;
  }
}

async function medlemmerMedConfig(): Promise<Array<{ member: PoolMember; cfg: LxcConfig }>> {
  const pool = await hentPool();
  const lxc = pool.members.filter((m) => m.type === "lxc");
  return await Promise.all(
    lxc.map(async (m) => {
      const [member, cfg] = await Promise.all([medStatus(m), lxcConfig(m.vmid)]);
      return { member, cfg };
    }),
  );
}

export async function listVps(): Promise<Vps[]> {
  const rader = await medlemmerMedConfig();
  return rader.map(({ member, cfg }) => tilVps(member, cfg)).sort((a, b) => a.vmid - b.vmid);
}

async function hentVpsIPool(vmid: number): Promise<{ member: PoolMember; cfg: LxcConfig }> {
  const pool = await hentPool();
  const funnet = pool.members.find((m) => m.type === "lxc" && Number(m.vmid) === vmid);
  if (!funnet) throw new VpsError(404, `Fant ingen VPS med ID ${vmid}`, "vps.not_found");
  const [member, cfg] = await Promise.all([medStatus(funnet), lxcConfig(vmid)]);
  return { member, cfg };
}

export async function getVps(vmid: number): Promise<Vps> {
  const { member, cfg } = await hentVpsIPool(vmid);
  return tilVps(member, cfg);
}

async function vertsRamMb(): Promise<{ totalMb: number; bruktMb: number }> {
  const status = await pve<{ memory: { total: number; used: number } }>("GET", `/nodes/${node()}/status`);
  return { totalMb: Math.floor(status.memory.total / 2 ** 20), bruktMb: Math.floor(status.memory.used / 2 ** 20) };
}

export async function getRamPool(): Promise<RamPool> {
  const [pool, vert] = await Promise.all([hentPool(), vertsRamMb()]);
  const reservertMb = parseReservert(pool.comment);
  const takMb = Math.max(vert.totalMb - reservertMb, 1024);
  const lxc = await Promise.all(pool.members.filter((m) => m.type === "lxc").map(medStatus));
  const iBrukMb = Math.round(lxc.reduce((sum, m) => sum + (m.mem ?? 0), 0) / 2 ** 20);
  const garantertMb = (
    await Promise.all(lxc.map(async (m) => parseMinRam((await lxcConfig(m.vmid)).description)))
  ).reduce((a, b) => a + b, 0);
  return { totalMb: vert.totalMb, reservertMb, takMb, iBrukMb, garantertMb, ledigITaketMb: Math.max(takMb - iBrukMb, 0) };
}

export async function setRamPool(reservertMb: number): Promise<RamPool> {
  const naa = await getRamPool();
  if (!Number.isInteger(reservertMb) || reservertMb < MIN_RESERVERT_MB || reservertMb > naa.totalMb - 2048) {
    throw new VpsError(
      400,
      `Reservert RAM må være et heltall mellom ${MIN_RESERVERT_MB} og ${naa.totalMb - 2048} MB`,
      "vps.ram_out_of_range",
    );
  }
  const nyttTak = naa.totalMb - reservertMb;
  if (nyttTak < naa.iBrukMb + 1024 || nyttTak < naa.garantertMb) {
    throw new VpsError(
      409,
      `Det nye taket (${nyttTak} MB) er lavere enn det VPS-ene allerede bruker (${naa.iBrukMb} MB) eller er garantert (${naa.garantertMb} MB). Stopp eller krymp en VPS først.`,
      "vps.ram_below_usage",
    );
  }
  const pool = await hentPool();
  await lagrePoolKommentar(medReservert(pool.comment, reservertMb));
  return { ...naa, reservertMb, takMb: nyttTak, ledigITaketMb: Math.max(nyttTak - naa.iBrukMb, 0) };
}

async function finnMal(template: VpsTemplate): Promise<string> {
  const prefiks = VPS_TEMPLATES[template];
  const innhold = await pve<Array<{ volid: string }>>(
    "GET",
    `/nodes/${node()}/storage/${encodeURIComponent(config.SNOAT_VPS_STORAGE)}/content`,
    { content: "vztmpl" },
  );
  const treff = innhold.map((i) => i.volid).filter((v) => v.includes(`/${prefiks}_`)).sort().pop();
  if (!treff) throw new VpsError(400, `Malen «${template}» er ikke lastet ned på verten`, "vps.template_missing");
  return treff;
}

async function ledigVmid(): Promise<number> {
  for (let vmid = config.SNOAT_VPS_VMID_BASE; vmid < config.SNOAT_VPS_VMID_BASE + 1000; vmid++) {
    try {
      await pve("GET", "/cluster/nextid", { vmid });
      return vmid;
    } catch {
      /* opptatt – prøv neste */
    }
  }
  throw new VpsError(409, "Ingen ledige VPS-ID-er igjen", "vps.no_vmid");
}

export interface NyVps {
  name: string;
  template?: VpsTemplate;
  cores?: number;
  diskGb?: number;
  memoryMaxMb?: number;
  memoryMinMb?: number;
  sshPublicKeys?: string[];
}

function standardNokler(): string[] {
  const raw = config.SNOAT_VPS_DEFAULT_SSH_KEYS_B64;
  if (!raw) return [];
  return Buffer.from(raw, "base64")
    .toString("utf8")
    .split("\n")
    .map((linje) => linje.trim())
    .filter(Boolean);
}

export async function createVps(input: NyVps): Promise<Vps> {
  kreverKonfigurasjon();
  const navn = input.name.trim().toLowerCase();
  if (!gyldigVpsNavn(navn)) {
    throw new VpsError(400, "Navnet må være 2–40 tegn: små bokstaver, tall og bindestrek, og starte med en bokstav", "vps.invalid_name");
  }

  const [rader, vert, mal, vmid] = await Promise.all([
    medlemmerMedConfig(),
    vertsRamMb(),
    finnMal(input.template ?? "debian-12"),
    ledigVmid(),
  ]);

  if (rader.some(({ member, cfg }) => (cfg.hostname ?? member.name) === navn)) {
    throw new VpsError(409, `Det finnes allerede en VPS som heter «${navn}»`, "vps.name_taken");
  }

  const brukt = new Set([config.SNOAT_VPS_GATEWAY, ...rader.map(({ cfg }) => ipFraNet0(cfg.net0)).filter((ip): ip is string => Boolean(ip))]);
  const ip = ledigIp(brukt, config.SNOAT_VPS_SUBNET, config.SNOAT_VPS_IP_FIRST, config.SNOAT_VPS_IP_LAST);
  if (!ip) throw new VpsError(409, "Ingen ledige IP-adresser igjen i VPS-nettet", "vps.no_ip");

  const nokler = [...new Set([...standardNokler(), ...(input.sshPublicKeys ?? []).map((k) => k.trim()).filter(Boolean)])];
  if (nokler.length === 0) {
    throw new VpsError(400, "Ingen SSH-nøkkel: oppgi sshPublicKeys eller sett SNOAT_VPS_DEFAULT_SSH_KEYS_B64", "vps.no_ssh_key");
  }

  const cores = Math.min(Math.max(input.cores ?? 2, 1), 12);
  const diskGb = Math.min(Math.max(input.diskGb ?? 20, 4), 300);
  const memoryMaxMb = Math.min(Math.max(input.memoryMaxMb ?? vert.totalMb, 256), vert.totalMb);
  const memoryMinMb = Math.min(Math.max(input.memoryMinMb ?? 0, 0), memoryMaxMb);

  const beskrivelse = medMinRam(`Snoat-VPS «${navn}», laget ${new Date().toISOString()} via Snoat.`, memoryMinMb);

  const upid = await pve<string>("POST", `/nodes/${node()}/lxc`, {
    vmid,
    hostname: navn,
    ostemplate: mal,
    storage: config.SNOAT_VPS_STORAGE,
    rootfs: `${config.SNOAT_VPS_STORAGE}:${diskGb}`,
    memory: memoryMaxMb,
    swap: 0,
    cores,
    net0: `name=eth0,bridge=${config.SNOAT_VPS_BRIDGE},ip=${ip}/24,gw=${config.SNOAT_VPS_GATEWAY}`,
    nameserver: config.SNOAT_VPS_NAMESERVERS,
    unprivileged: true,
    // Bare nesting: det er nok for Docker i en uprivilegert container på PVE 8, og
    // keyctl kan bare root@pam slå på.
    features: "nesting=1",
    pool: config.SNOAT_PROXMOX_POOL,
    "ssh-public-keys": nokler.join("\n"),
    onboot: true,
    start: true,
    description: beskrivelse,
  });
  await ventPaOppgave(upid);
  logger.info({ vmid, navn, ip, memoryMaxMb, memoryMinMb, cores, diskGb }, "VPS opprettet");
  return await getVps(vmid);
}

export type VpsHandling = "start" | "shutdown" | "stop" | "reboot";

export async function vpsHandling(vmid: number, handling: VpsHandling): Promise<Vps> {
  await hentVpsIPool(vmid);
  const upid = await pve<string>("POST", `/nodes/${node()}/lxc/${vmid}/status/${handling}`);
  await ventPaOppgave(upid);
  return await getVps(vmid);
}

export async function oppdaterVps(
  vmid: number,
  endring: { cores?: number; memoryMaxMb?: number; memoryMinMb?: number },
): Promise<Vps> {
  const { cfg } = await hentVpsIPool(vmid);
  const vert = await vertsRamMb();
  const params: Params = {};
  if (endring.cores !== undefined) params.cores = Math.min(Math.max(endring.cores, 1), 12);
  if (endring.memoryMaxMb !== undefined) params.memory = Math.min(Math.max(endring.memoryMaxMb, 256), vert.totalMb);
  if (endring.memoryMinMb !== undefined) {
    const maks = Number(params.memory ?? cfg.memory ?? vert.totalMb);
    params.description = medMinRam(cfg.description, Math.min(Math.max(endring.memoryMinMb, 0), maks));
  }
  if (Object.keys(params).length === 0) return await getVps(vmid);
  await pve("PUT", `/nodes/${node()}/lxc/${vmid}/config`, params);
  return await getVps(vmid);
}

export async function slettVps(vmid: number, bekreftNavn: string): Promise<void> {
  const { member, cfg } = await hentVpsIPool(vmid);
  const navn = cfg.hostname ?? member.name;
  if (!navn || bekreftNavn.trim().toLowerCase() !== navn.toLowerCase()) {
    throw new VpsError(400, `Navnet «${bekreftNavn}» stemmer ikke med VPS-en «${navn}»`, "vps.confirm_mismatch");
  }
  if (member.status === "running") {
    await ventPaOppgave(await pve<string>("POST", `/nodes/${node()}/lxc/${vmid}/status/stop`));
  }
  await ventPaOppgave(
    await pve<string>("DELETE", `/nodes/${node()}/lxc/${vmid}`, { purge: true, "destroy-unreferenced-disks": true }),
  );
  logger.info({ vmid, navn }, "VPS slettet");
}
