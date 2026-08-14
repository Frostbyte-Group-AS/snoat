import { Resolver } from "node:dns/promises";
import { connect as tlsConnect } from "node:tls";
import { config } from "../config.js";
import * as caddy from "../lib/caddy.js";
import type { Project } from "../types.js";

/**
 * Svarer på det kunden faktisk lurer på: virker domenet mitt, og hvis ikke – hva
 * mangler?
 *
 * Tre uavhengige ting må stemme før et eget domene svarer:
 *
 *   1. DNS peker hit. Kundens ansvar, og det eneste som tar tid (propagering).
 *   2. Caddy har en rute for vertsnavnet. Vårt ansvar.
 *   3. Et sertifikat er utstedt. Skjer av seg selv når 1 og 2 er på plass, men
 *      først ved det første besøket – on-demand utsteder under handshaken.
 *
 * De ble tidligere aldri målt, bare beskrevet, og kunden satt igjen med en
 * `dig`-kommando og en gjetning. Verre: TLS-sjekken leser databasen mens
 * rutingen leser Caddys minne, så de to kunne peke hver sin vei uten at noe sa
 * fra. Da får man et gyldig sertifikat for et domene som svarer «ingen
 * applikasjon er rutet til dette domenet» – nøyaktig den forvirrende tilstanden
 * denne modulen finnes for å avsløre.
 */

export type CheckState = "ok" | "pending" | "failed";

export interface DomainCheck {
  state: CheckState;
  /** Kort forklaring på norsk, klar til å vises som den er. */
  detail: string;
}

export interface DomainStatus {
  domain: string;
  /** Alle tre stemmer – domenet svarer. */
  ready: boolean;
  dns: DomainCheck & { expected: string; found: string[] };
  route: DomainCheck;
  certificate: DomainCheck;
}

/**
 * Oppslag mot offentlige resolvere, ikke systemets egen.
 *
 * Serveren kan ha en cache eller en intern sone som svarer noe annet enn det
 * kundens besøkende ser, og da hjelper det ikke å spørre den. To uavhengige
 * resolvere gjør også at ett tregt svar ikke låser hele sjekken.
 */
const PUBLIC_RESOLVERS = ["1.1.1.1", "8.8.8.8"];
const DNS_TIMEOUT_MS = 4000;
const TLS_TIMEOUT_MS = 4000;

async function resolveTarget(domain: string): Promise<string[]> {
  const resolver = new Resolver({ timeout: DNS_TIMEOUT_MS, tries: 1 });
  resolver.setServers(PUBLIC_RESOLVERS);

  // A-recorden er fasiten: en CNAME mot <slug>.snoat.com ender uansett på samme
  // IP, så vi slipper å følge kjeden selv.
  try {
    return await resolver.resolve4(domain);
  } catch {
    return [];
  }
}

/**
 * Har Caddy en rute som svarer på dette vertsnavnet?
 *
 * Leser den faktiske kjørende konfigurasjonen framfor å stole på databasen.
 * Hele poenget er å avdekke når de to spriker.
 */
async function hasRouteFor(project: Project, domain: string): Promise<boolean> {
  const route = await caddy.getAppRoute(project.name);
  if (!route) return false;

  const hosts = route.match?.[0]?.host ?? [];
  return hosts.some((host) => {
    if (host === domain) return true;
    // `*.example.com` dekker én etikett foran, akkurat som Caddys egen matcher.
    if (!host.startsWith("*.")) return false;
    const suffix = host.slice(1);
    if (!domain.endsWith(suffix)) return false;
    return !domain.slice(0, -suffix.length).includes(".");
  });
}

/**
 * Har Caddy et sertifikat den kan presentere for vertsnavnet?
 *
 * Caddys admin-API har ingen ren spørring for dette, så vi gjør en TLS-handshake
 * mot den med domenet som SNI – nøyaktig det en besøkende gjør. Svaret er derfor
 * det samme som kunden vil oppleve, ikke vår tolkning av en intern tilstand.
 *
 * `rejectUnauthorized: false` fordi vi spør om et sertifikat *finnes*, ikke om
 * vi stoler på det: kjeden er uansett utstedt til kundens domene, og vi kobler
 * til over det interne nettverket.
 */
function probeCertificate(domain: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = tlsConnect({
      host: "caddy",
      port: 443,
      servername: domain,
      rejectUnauthorized: false,
      timeout: TLS_TIMEOUT_MS,
    });

    const finish = (result: boolean) => {
      socket.destroy();
      resolve(result);
    };

    socket.once("secureConnect", () => {
      const cert = socket.getPeerCertificate();
      finish(Boolean(cert && Object.keys(cert).length > 0));
    });
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

export async function checkDomain(project: Project, domain: string): Promise<DomainStatus> {
  const expected = config.SNOAT_SERVER_IP;

  const [found, routed] = await Promise.all([resolveTarget(domain), hasRouteFor(project, domain)]);

  const dnsOk = found.includes(expected);
  const dns: DomainStatus["dns"] = {
    expected,
    found,
    state: dnsOk ? "ok" : "pending",
    detail: dnsOk
      ? "Domenet peker hit."
      : found.length === 0
        ? "Fant ingen A-record ennå. Propagering kan ta opptil en time."
        : `Peker på ${found.join(", ")}, forventet ${expected}.`,
  };

  const route: DomainCheck = routed
    ? { state: "ok", detail: "Caddy ruter dette vertsnavnet til appen din." }
    : {
        state: "failed",
        detail: "Ingen rute for vertsnavnet. Deploy prosjektet på nytt for å opprette den.",
      };

  // Handshaken utløser on-demand-utstedelse hos Caddy. Peker ikke DNS hit ennå,
  // kan ikke ACME-utfordringen løses, og forsøket teller mot Let's Encrypts
  // grense på fem mislykkede valideringer per vertsnavn per time. Derfor prøver
  // vi ikke før de to andre stemmer – uten DNS er «mangler sertifikat» uansett
  // forventet, ikke en feil.
  const certOk = dnsOk && routed ? await probeCertificate(domain) : false;
  const certificate: DomainCheck = certOk
    ? { state: "ok", detail: "Sertifikat utstedt." }
    : {
        state: "pending",
        detail: dnsOk && routed
          ? "Utstedes ved første besøk. Last domenet i nettleseren."
          : "Utstedes automatisk når de to punktene over stemmer.",
      };

  return {
    domain,
    ready: dnsOk && routed && certOk,
    dns,
    route,
    certificate,
  };
}
