import { HTTPException } from "hono/http-exception";

import type { GithubInstallationAccount } from "../lib/github.js";
import { logger } from "../lib/logger.js";
import { supabase } from "../lib/supabase.js";
import { erEierkonto } from "./plans.js";

/**
 * Hvem får koble en GitHub App-installasjon til kontoen sin?
 *
 * Installasjons-ID-er er sekvensielle tall, og GitHub svarer gladelig på
 * `/app/installations/<id>` for *enhver* installasjon av App-en vår. At ID-en
 * finnes, sier derfor ingenting om at den som leverer den, har noe med den å
 * gjøre. Uten denne sjekken kunne hvem som helst koble en annens installasjon
 * til sin egen konto, liste repoene og klone private repoer med et token Snoat
 * utsteder på vegne av offeret.
 *
 * Koblingen godtas bare når ett av disse holder:
 *
 * 1. Kalleren har allerede koblingen (idempotent gjentakelse).
 * 2. Kalleren er en eierkonto (`SNOAT_OWNER_ACCOUNTS`). Plattformens egne
 *    integrasjoner registrerer installasjoner over API-et på eierkontoen.
 * 3. Installasjonen ligger på en *personlig* GitHub-konto, og den kontoen er den
 *    samme som GitHub-identiteten kalleren har logget inn med.
 * 4. Kun i nettleserflyten (`/github/setup`): installasjonen ble opprettet nå
 *    nettopp, innenfor levetiden til den signerte `state`-en. Det er tilfellet
 *    «jeg installerte nettopp App-en på organisasjonen min» – GitHub sender
 *    brukeren rett tilbake hit. En gammel installasjon tilhørende noen andre
 *    slipper ikke gjennom denne veien.
 */
export type OwnershipReason = "already_linked" | "owner_account" | "github_identity" | "fresh_install";

export interface OwnershipFacts {
  alreadyLinked: boolean;
  ownerAccount: boolean;
  /** GitHub-bruker-ID-ene kalleren har logget inn med (Supabase-identiteter). */
  githubUserIds: string[];
  installation: Pick<GithubInstallationAccount, "accountType" | "accountId" | "createdAt">;
  /** Gjelder sjekk 4. Bare `/github/setup` setter denne. */
  freshInstallWindowMs: number | null;
  now: number;
}

/** Ren beslutning, uten nettverk – testes i installation-ownership.test.ts. */
export function ownershipReason(facts: OwnershipFacts): OwnershipReason | null {
  if (facts.alreadyLinked) return "already_linked";
  if (facts.ownerAccount) return "owner_account";

  const { installation } = facts;
  if (
    installation.accountType === "User" &&
    installation.accountId !== null &&
    facts.githubUserIds.includes(String(installation.accountId))
  ) {
    return "github_identity";
  }

  if (facts.freshInstallWindowMs !== null && installation.createdAt) {
    const created = Date.parse(installation.createdAt);
    const age = facts.now - created;
    // Litt slingringsmonn for klokkeforskjell mellom oss og GitHub.
    if (Number.isFinite(created) && age >= -60_000 && age <= facts.freshInstallWindowMs) {
      return "fresh_install";
    }
  }

  return null;
}

async function githubUserIdsFor(userId: string): Promise<string[]> {
  const { data, error } = await supabase.auth.admin.getUserById(userId);
  if (error || !data.user) {
    logger.warn({ userId, err: error }, "Kunne ikke slå opp GitHub-identiteten til brukeren");
    return [];
  }

  return (data.user.identities ?? [])
    .filter((identity) => identity.provider === "github")
    .flatMap((identity) => {
      const fromData = identity.identity_data?.provider_id ?? identity.identity_data?.sub;
      return [identity.id, fromData].filter((value): value is string => typeof value === "string" && value !== "");
    });
}

async function hasLink(userId: string, installationId: number): Promise<boolean> {
  const { data, error } = await supabase
    .from("github_installations")
    .select("installation_id")
    .eq("user_id", userId)
    .eq("installation_id", installationId)
    .maybeSingle();

  if (error) throw new HTTPException(500, { message: `Databasefeil: ${error.message}` });
  return data !== null;
}

/**
 * Kaster 403 hvis kalleren ikke kan vise at installasjonen er deres.
 * `freshInstallWindowMs` sendes bare fra nettleserflyten med signert `state`.
 */
export async function assertMayLinkInstallation(
  userId: string,
  account: GithubInstallationAccount,
  options: { freshInstallWindowMs?: number } = {},
): Promise<OwnershipReason> {
  const alreadyLinked = await hasLink(userId, account.installationId);
  const ownerAccount = alreadyLinked ? false : await erEierkonto(userId);
  const githubUserIds = alreadyLinked || ownerAccount ? [] : await githubUserIdsFor(userId);

  const reason = ownershipReason({
    alreadyLinked,
    ownerAccount,
    githubUserIds,
    installation: account,
    freshInstallWindowMs: options.freshInstallWindowMs ?? null,
    now: Date.now(),
  });

  if (!reason) {
    logger.warn(
      { userId, installationId: account.installationId, account: account.accountLogin },
      "Avviste kobling til en GitHub-installasjon kalleren ikke kan vise at de eier",
    );
    throw new HTTPException(403, {
      message:
        `Snoat kan ikke bekrefte at installasjonen på «${account.accountLogin}» er din. ` +
        "Installer Snoat-appen på nytt fra dashboardet, eller logg inn med GitHub-kontoen den ligger på.",
    });
  }

  return reason;
}

/**
 * Forsvar i dybden før kloning: installasjonen på prosjektet skal være koblet
 * til prosjekteierens konto. Databasetriggeren `projects_installation_owned`
 * håndhever det samme ved skriving; denne fanger rader fra før triggeren fantes.
 */
export async function assertInstallationBelongsToOwner(ownerId: string, installationId: number): Promise<void> {
  if (!(await hasLink(ownerId, installationId))) {
    throw new Error(
      `GitHub-installasjon ${installationId} er ikke koblet til prosjekteierens konto. ` +
        "Velg repoet på nytt i prosjektinnstillingene.",
    );
  }
}
