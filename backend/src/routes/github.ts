import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { config } from "../config.js";
import * as github from "../lib/github.js";
import { logger } from "../lib/logger.js";
import { supabase } from "../lib/supabase.js";
import type { AuthVariables } from "../middleware/auth.js";
import type { GithubInstallation } from "../types.js";

/** Dashboardet, dit installasjonsflyten sender brukeren tilbake. */
function dashboardUrl(params: Record<string, string>): string {
  const origin = config.SNOAT_FRONTEND_ORIGIN.split(",")[0]!.trim();
  const url = new URL("/dashboard", origin);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return url.toString();
}

async function installationsFor(userId: string): Promise<GithubInstallation[]> {
  const { data, error } = await supabase
    .from("github_installations")
    .select("*")
    .eq("user_id", userId)
    .order("created_at", { ascending: true });

  if (error) throw new HTTPException(500, { message: `Databasefeil: ${error.message}` });

  return (data ?? []) as GithubInstallation[];
}

/**
 * Fjerner en kobling som ikke lenger finnes hos GitHub.
 *
 * Avinstallerer brukeren App-en, får vi 404 på installasjonen. Uten opprydding
 * ville repo-listen feilet for alltid etterpå.
 */
async function forgetStaleInstallation(row: GithubInstallation): Promise<void> {
  github.forgetInstallation(row.installation_id);
  await supabase.from("github_installations").delete().eq("id", row.id);
  logger.info(
    { installationId: row.installation_id },
    "GitHub-installasjon finnes ikke lenger – koblingen er fjernet",
  );
}

// ---------------------------------------------------------------------------
// Autentiserte endepunkter (monteres under /api/github)
// ---------------------------------------------------------------------------

export const githubApi = new Hono<{ Variables: AuthVariables }>();

/**
 * Hva dashboardet trenger for å tegne dialogen: er integrasjonen tilgjengelig,
 * har brukeren koblet til, og hvor sendes vedkommende for å koble til.
 */
githubApi.get("/status", async (c) => {
  if (!github.isConfigured()) {
    return c.json({ configured: false, connected: false, installations: [], installUrl: null });
  }

  const userId = c.get("userId");
  const rows = await installationsFor(userId);

  return c.json({
    configured: true,
    connected: rows.length > 0,
    installations: rows.map((row) => ({
      installationId: row.installation_id,
      accountLogin: row.account_login,
      accountType: row.account_type,
    })),
    installUrl: github.installUrl(userId),
  });
});

/** Repoene brukeren har gitt Snoat tilgang til, på tvers av installasjoner. */
githubApi.get("/repos", async (c) => {
  if (!github.isConfigured()) {
    throw new HTTPException(503, { message: "GitHub-integrasjonen er ikke konfigurert" });
  }

  const rows = await installationsFor(c.get("userId"));
  const repos = [];

  for (const row of rows) {
    try {
      repos.push(...(await github.listRepositories(row.installation_id)));
    } catch (error) {
      // 404 betyr at App-en er avinstallert. Da rydder vi og går videre i
      // stedet for å la én død kobling ta ned hele lista.
      if (error instanceof github.GithubError && error.status === 404) {
        await forgetStaleInstallation(row);
        continue;
      }
      throw error;
    }
  }

  // Sist oppdaterte først – det er nesten alltid det man leter etter.
  repos.sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));

  return c.json({ repos });
});

/**
 * Grenene i ett repo, til grenvelgeren i dashboardet.
 *
 * `repo` kan være en klone-URL eller `owner/repo` – begge normaliseres av
 * `repoIdentity()`, av samme grunn som i webhooken: `projects.repo_url` finnes i
 * alle varianter, og velgeren skal virke uansett hvilken som er lagret.
 *
 * **Installasjonen kommer aldri fra klienten.** Vi går gjennom kontoens egne
 * koblinger og bruker den første som faktisk rekker repoet. Tok vi imot en
 * `installationId` fra forespørselen, ville endepunktet vært en vei til å lese
 * grenlisten i andres private repoer med et gjettet tall – `installation_id` er
 * ingen hemmelighet.
 *
 * Rekker ingen av koblingene repoet, er svaret 404 og ikke en tom liste: en tom
 * liste leses som «repoet har ingen grener», og da er et fritekstfelt bedre enn
 * en nedtrekksliste som lyver.
 */
githubApi.get("/branches", async (c) => {
  if (!github.isConfigured()) {
    throw new HTTPException(503, { message: "GitHub-integrasjonen er ikke konfigurert" });
  }

  const repo = c.req.query("repo")?.trim();
  if (!repo) throw new HTTPException(400, { message: "«repo» mangler" });

  const identity = github.repoIdentity(repo);
  if (!identity) {
    throw new HTTPException(400, { message: `Kjenner ikke igjen repositoryet «${repo}»` });
  }

  const rows = await installationsFor(c.get("userId"));

  for (const row of rows) {
    try {
      const result = await github.listBranches(row.installation_id, identity);
      return c.json({ repo: identity, installationId: row.installation_id, ...result });
    } catch (error) {
      // 404 betyr «denne installasjonen rekker ikke repoet» – eller at App-en er
      // avinstallert. Vi prøver de øvrige koblingene før vi gir opp, akkurat som
      // repo-listen gjør.
      if (error instanceof github.GithubError && error.status === 404) continue;
      throw error;
    }
  }

  throw new HTTPException(404, {
    message:
      `Snoat rekker ikke ${identity} gjennom noen av GitHub-kontoene som er koblet til. ` +
      "Skriv grennavnet manuelt, eller gi Snoat tilgang til repoet.",
  });
});

/**
 * Registrerer en GitHub App-installasjon på den som kaller.
 *
 * Dette er `/github/setup` uten nettleseren. Setup-URL-en får `installation_id`
 * som en query-parameter i en redirect, og verifiserer avsenderen med en
 * HMAC-signert `state` – en mekanikk som forutsetter at det finnes en nettleser
 * å redirecte. En integrasjon som LeadLab kjører installasjonsflyten i *sitt*
 * eget UI og sitter igjen med ID-en; da mangler den bare et sted å levere den.
 *
 * Tilliten hviler her på API-nøkkelen i `Authorization`, ikke på `state`. Vi
 * spør likevel GitHub om installasjonen faktisk finnes før vi lagrer noe,
 * nøyaktig som setup-ruten gjør: ID-en kommer utenfra, og en kobling til en
 * installasjon som ikke er vår ville gitt et repo-oppslag som feiler for alltid.
 */
githubApi.post("/installations", async (c) => {
  if (!github.isConfigured()) {
    throw new HTTPException(503, { message: "GitHub-integrasjonen er ikke konfigurert" });
  }

  const body = await c.req.json<{ installationId?: unknown }>().catch(() => null);
  const installationId = Number(body?.installationId);

  if (!Number.isSafeInteger(installationId) || installationId <= 0) {
    throw new HTTPException(400, { message: "«installationId» må være et positivt heltall" });
  }

  const userId = c.get("userId");

  let account: Awaited<ReturnType<typeof github.getInstallation>>;
  try {
    account = await github.getInstallation(installationId);
  } catch (error) {
    // 404 fra GitHub betyr at installasjonen ikke finnes, eller ikke tilhører
    // App-en vår. Begge er kallerens feil å rette, ikke vår å feile på.
    if (error instanceof github.GithubError && error.status === 404) {
      throw new HTTPException(404, {
        message: `GitHub kjenner ingen installasjon ${installationId} for denne App-en.`,
      });
    }
    throw error;
  }

  const { error } = await supabase.from("github_installations").upsert(
    {
      user_id: userId,
      installation_id: account.installationId,
      account_login: account.accountLogin,
      account_type: account.accountType,
    },
    { onConflict: "user_id,installation_id" },
  );

  if (error) throw new HTTPException(500, { message: `Databasefeil: ${error.message}` });

  logger.info(
    { userId, installationId, account: account.accountLogin, via: c.get("authKind") },
    "GitHub-installasjon registrert over API",
  );

  return c.json({ installation: account }, 201);
});

// ---------------------------------------------------------------------------
// Offentlig endepunkt (monteres på /github)
// ---------------------------------------------------------------------------

export const githubSetup = new Hono();

/**
 * Setup-URL-en GitHub sender brukeren tilbake til etter installasjon.
 *
 * Denne treffes av nettleseren, ikke av dashboardet, og har derfor ingen
 * Authorization-header. Tilliten hviler i stedet på `state`, som er
 * HMAC-signert av oss – og på at vi spør GitHub om installasjonen faktisk
 * finnes før vi lagrer noe.
 */
githubSetup.get("/setup", async (c) => {
  if (!github.isConfigured()) {
    return c.redirect(dashboardUrl({ github: "error", reason: "not_configured" }));
  }

  const installationId = Number(c.req.query("installation_id"));
  const state = c.req.query("state") ?? "";

  if (!Number.isSafeInteger(installationId) || installationId <= 0) {
    return c.redirect(dashboardUrl({ github: "error", reason: "missing_installation" }));
  }

  const userId = github.verifyState(state);
  if (!userId) {
    return c.redirect(dashboardUrl({ github: "error", reason: "invalid_state" }));
  }

  try {
    const account = await github.getInstallation(installationId);

    const { error } = await supabase.from("github_installations").upsert(
      {
        user_id: userId,
        installation_id: account.installationId,
        account_login: account.accountLogin,
        account_type: account.accountType,
      },
      { onConflict: "user_id,installation_id" },
    );

    if (error) throw new Error(error.message);

    logger.info({ userId, installationId, account: account.accountLogin }, "GitHub App koblet til");
    return c.redirect(dashboardUrl({ github: "connected" }));
  } catch (error) {
    logger.error({ err: error, installationId }, "Kunne ikke fullføre GitHub-installasjonen");
    return c.redirect(dashboardUrl({ github: "error", reason: "setup_failed" }));
  }
});
