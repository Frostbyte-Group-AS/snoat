import { appUrl } from "../lib/caddy.js";
import { logger } from "../lib/logger.js";
import { supabase } from "../lib/supabase.js";
import type { DeploymentStatus, SubscriptionStatus, SubscriptionTier } from "../types.js";
import * as containers from "./containers.js";
import { erEierkonto } from "./plans.js";

/**
 * Sudo: hele plattformen sett ovenfra – alle brukere og alle prosjekter.
 *
 * Alt annet i backend svarer bare om kalleren selv, og eierskapet håndheves i
 * WHERE-setningen. Her er det motsatt: spørringene går med service-nøkkelen og
 * uten filter på `user_id`. Derfor ligger tilgangssjekken i `routes/sudo.ts`, og
 * denne filen skal aldri importeres fra en rute som ikke har kjørt den.
 *
 * Første utgave er bare lesing. Det er bevisst: å stoppe eller slette en annen
 * kundes prosjekt er en handling som bør ha sin egen knapp, sin egen bekreftelse
 * og en logg over hvem som gjorde det – ikke komme på kjøpet med en oversikt.
 */

export interface SudoBruker {
  id: string;
  epost: string | null;
  /** GitHub-brukernavnet fra innloggingen, når kontoen er laget med GitHub. */
  brukernavn: string | null;
  opprettet: string;
  sistInnlogget: string | null;
  plan: SubscriptionTier;
  planStatus: SubscriptionStatus | null;
  eier: boolean;
  antallProsjekter: number;
  antallKjorende: number;
  antallOmdirigeringer: number;
}

export interface SudoProsjekt {
  id: string;
  navn: string;
  brukerId: string;
  epost: string | null;
  repoUrl: string;
  branch: string | null;
  url: string;
  customDomain: string | null;
  statisk: boolean;
  devSide: boolean;
  stoppet: boolean;
  /** `null` når Docker ikke svarte – ukjent, ikke «nei». */
  kjorer: boolean | null;
  opprettet: string;
  sisteDeploy: { status: DeploymentStatus; tidspunkt: string } | null;
}

export interface SudoOversikt {
  brukere: SudoBruker[];
  prosjekter: SudoProsjekt[];
}

interface AuthBruker {
  id: string;
  email?: string;
  created_at: string;
  last_sign_in_at?: string;
  user_metadata?: Record<string, unknown>;
}

/** Samme bla-løkke som `scripts/issue-api-key.ts`; GoTrue har ingen «hent alle». */
async function alleBrukere(): Promise<AuthBruker[]> {
  const brukere: AuthBruker[] = [];
  for (let page = 1; page <= 50; page++) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw new Error(`Kunne ikke liste brukere: ${error.message}`);
    brukere.push(...data.users);
    if (data.users.length < 200) break;
  }
  return brukere;
}

interface ProsjektRad {
  id: string;
  user_id: string;
  name: string;
  repo_url: string;
  branch: string | null;
  custom_domain: string | null;
  static_output_dir: string | null;
  parent_project_id: string | null;
  stopped_at: string | null;
  created_at: string;
  deployments: { status: DeploymentStatus; created_at: string }[];
}

async function alleProsjekter(): Promise<ProsjektRad[]> {
  const { data, error } = await supabase
    .from("projects")
    .select(
      "id, user_id, name, repo_url, branch, custom_domain, static_output_dir, parent_project_id, stopped_at, created_at, deployments(status, created_at)",
    )
    .order("created_at", { ascending: false })
    .order("created_at", { referencedTable: "deployments", ascending: false })
    .limit(1, { referencedTable: "deployments" });
  if (error) throw new Error(`Kunne ikke hente prosjekter: ${error.message}`);
  return (data ?? []) as ProsjektRad[];
}

async function abonnementer(): Promise<Map<string, { plan: SubscriptionTier; status: SubscriptionStatus }>> {
  const { data, error } = await supabase.from("subscriptions").select("user_id, plan, status");
  if (error) throw new Error(`Kunne ikke hente abonnementer: ${error.message}`);
  return new Map(
    (data ?? []).map((rad: { user_id: string; plan: SubscriptionTier; status: SubscriptionStatus }) => [
      rad.user_id,
      { plan: rad.plan, status: rad.status },
    ]),
  );
}

async function omdirigeringerPerBruker(): Promise<Map<string, number>> {
  const { data, error } = await supabase.from("redirects").select("user_id");
  if (error) throw new Error(`Kunne ikke hente omdirigeringer: ${error.message}`);
  const antall = new Map<string, number>();
  for (const { user_id } of (data ?? []) as { user_id: string }[]) {
    antall.set(user_id, (antall.get(user_id) ?? 0) + 1);
  }
  return antall;
}

/**
 * Docker kan være utilgjengelig uten at resten av oversikten er feil.
 * Da blir `kjorer` ukjent i stedet for at hele siden feiler.
 */
async function kjorendeProsjekter(): Promise<Set<string> | null> {
  try {
    return await containers.runningProjectIds();
  } catch (err) {
    logger.warn({ err }, "Sudo: kunne ikke spørre Docker om kjørende containere");
    return null;
  }
}

const tekst = (verdi: unknown): string | null => (typeof verdi === "string" && verdi ? verdi : null);

export async function hentOversikt(): Promise<SudoOversikt> {
  const [brukere, prosjekter, abonnement, omdirigeringer, kjorende] = await Promise.all([
    alleBrukere(),
    alleProsjekter(),
    abonnementer(),
    omdirigeringerPerBruker(),
    kjorendeProsjekter(),
  ]);

  const epostFor = new Map(brukere.map((b) => [b.id, b.email ?? null]));

  const sudoProsjekter: SudoProsjekt[] = prosjekter.map((p) => {
    const siste = p.deployments[0];
    return {
      id: p.id,
      navn: p.name,
      brukerId: p.user_id,
      epost: epostFor.get(p.user_id) ?? null,
      repoUrl: p.repo_url,
      branch: p.branch,
      url: appUrl(p.name),
      customDomain: p.custom_domain,
      statisk: p.static_output_dir !== null,
      devSide: p.parent_project_id !== null,
      stoppet: p.stopped_at !== null,
      kjorer: kjorende ? kjorende.has(p.id) : null,
      opprettet: p.created_at,
      sisteDeploy: siste ? { status: siste.status, tidspunkt: siste.created_at } : null,
    };
  });

  const sudoBrukere = await Promise.all(
    brukere.map(async (b): Promise<SudoBruker> => {
      const egne = sudoProsjekter.filter((p) => p.brukerId === b.id);
      const sub = abonnement.get(b.id);
      return {
        id: b.id,
        epost: b.email ?? null,
        brukernavn: tekst(b.user_metadata?.user_name) ?? tekst(b.user_metadata?.preferred_username),
        opprettet: b.created_at,
        sistInnlogget: b.last_sign_in_at ?? null,
        plan: sub?.plan ?? "free",
        planStatus: sub?.status ?? null,
        eier: await erEierkonto(b.id),
        antallProsjekter: egne.length,
        antallKjorende: egne.filter((p) => p.kjorer === true).length,
        antallOmdirigeringer: omdirigeringer.get(b.id) ?? 0,
      };
    }),
  );

  sudoBrukere.sort((a, b) => b.opprettet.localeCompare(a.opprettet));
  return { brukere: sudoBrukere, prosjekter: sudoProsjekter };
}
