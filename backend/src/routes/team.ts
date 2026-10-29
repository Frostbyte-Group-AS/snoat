import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { logger } from "../lib/logger.js";
import { supabase } from "../lib/supabase.js";
import { loadOwnedProject, loadProject, type AuthVariables } from "../middleware/auth.js";
import * as team from "../services/team.js";
import type { ErrorDetail, Project } from "../types.js";

/**
 * Team: hvem som har tilgang til prosjektene dine, og invitasjonene som venter.
 *
 * ## Hvorfor bare sesjoner
 *
 * Hele ruten er stengt for API-nøkler og MCP-connectoren, også for lesing. Å gi
 * noen tilgang til et prosjekt er en beslutning et menneske skal ta i
 * dashboardet: en connector som kan invitere, er en connector en prompt-injeksjon
 * i en byggelogg eller en feilmelding kan få til å invitere en fremmed. Og å
 * *godta* en invitasjon er et samtykke, som ingen integrasjon kan gi på vegne av
 * brukeren.
 *
 * ## Tilgangsreglene
 *
 * - Bare **eieren** inviterer, trekker tilbake invitasjoner og fjerner medlemmer.
 * - En invitasjon godtas bare av en bruker hvis **bekreftede** e-post er
 *   adressen den ble sendt til. Lenken er ingen nøkkel – se migrasjon 0020.
 * - Et medlem kan forlate et prosjekt selv.
 */
export const teamApi = new Hono<{ Variables: AuthVariables }>();

teamApi.use("*", async (c, next) => {
  if (c.get("authKind") !== "session") {
    throw new HTTPException(403, {
      message: "Team styres fra dashboardet, ikke over API-nøkkel eller MCP.",
      cause: { code: "team.session_only" } satisfies ErrorDetail,
    });
  }
  await next();
});

function fail(status: 400 | 403 | 404 | 409 | 429, code: string, message: string, params?: ErrorDetail["params"]): never {
  throw new HTTPException(status, { message, cause: { code, params } satisfies ErrorDetail });
}

function dbError(error: { message: string }): never {
  throw new HTTPException(500, { message: `Databasefeil: ${error.message}` });
}

/** Prosjektet en invitasjon gjelder, slik teamsiden viser det. */
async function projectNames(ids: string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const { data, error } = await supabase.from("projects").select("id, name").in("id", ids);
  if (error) dbError(error);
  return new Map((data ?? []).map((row) => [row.id as string, row.name as string]));
}

/**
 * Alt teamsiden trenger, i ett kall.
 *
 * - `owned`: hvert hovedprosjekt du eier, med medlemmer og invitasjoner – også
 *   prosjekter uten team ennå, slik at siden kan tilby «Inviter» på alle.
 * - `shared`: prosjektene andre har lagt deg til i.
 * - `incoming`: invitasjoner til din bekreftede e-post som venter på svar.
 */
teamApi.get("/", async (c) => {
  const userId = c.get("userId");

  const [ownedResult, membershipsResult, email] = await Promise.all([
    supabase
      .from("projects")
      .select("id, name")
      .eq("user_id", userId)
      .is("parent_project_id", null)
      .order("created_at", { ascending: true }),
    supabase.from("project_members").select("project_id, created_at").eq("user_id", userId),
    team.confirmedEmail(userId),
  ]);

  if (ownedResult.error) dbError(ownedResult.error);
  if (membershipsResult.error) dbError(membershipsResult.error);

  const owned = ownedResult.data ?? [];
  const ownedIds = owned.map((row) => row.id as string);

  const [members, invitations, incoming] = await Promise.all([
    team.membersOf(ownedIds),
    team.visibleInvitationsFor(ownedIds),
    email ? team.incomingInvitations(email) : Promise.resolve([]),
  ]);

  const memberships = membershipsResult.data ?? [];
  const sharedIds = memberships.map((row) => row.project_id as string);

  const { data: sharedProjects, error: sharedError } = sharedIds.length
    ? await supabase.from("projects").select("id, name, user_id").in("id", sharedIds)
    : { data: [], error: null };
  if (sharedError) dbError(sharedError);

  const incomingNames = await projectNames(incoming.map((row) => row.project_id));

  const people = await team.peopleById([
    ...members.map((row) => row.user_id),
    ...(sharedProjects ?? []).map((row) => row.user_id as string),
    ...incoming.flatMap((row) => (row.invited_by ? [row.invited_by] : [])),
  ]);

  return c.json({
    email,
    owned: owned.map((project) => ({
      project: { id: project.id, name: project.name },
      members: members
        .filter((row) => row.project_id === project.id)
        .map((row) => ({ ...people.get(row.user_id)!, joinedAt: row.created_at })),
      invitations: invitations
        .filter((row) => row.project_id === project.id)
        .map((row) => ({
          id: row.id,
          email: row.email,
          status: team.invitationStatus(row),
          sentAt: row.sent_at,
          expiresAt: row.expires_at,
          link: team.invitationLink(row.id),
        })),
    })),
    shared: (sharedProjects ?? []).map((project) => ({
      project: { id: project.id, name: project.name },
      owner: people.get(project.user_id as string) ?? null,
      joinedAt: memberships.find((row) => row.project_id === project.id)?.created_at ?? null,
    })),
    incoming: incoming.flatMap((row) => {
      const name = incomingNames.get(row.project_id);
      if (!name) return [];
      return [
        {
          id: row.id,
          project: { id: row.project_id, name },
          invitedBy: row.invited_by ? (people.get(row.invited_by) ?? null) : null,
          expiresAt: row.expires_at,
        },
      ];
    }),
  });
});

/**
 * Bare invitasjonene som venter på deg – til varselet på dashboardet.
 *
 * Eget endepunkt fordi det kalles på hver dashboardvisning, og `GET /` slår opp
 * e-posten til hvert medlem i hvert prosjekt du eier. Det er også her en ny
 * bruker finner invitasjonen sin: bekreftelseslenken i registrerings-e-posten
 * åpnes ofte i en ny fane, og da er returadressen til invitasjonssiden borte.
 */
teamApi.get("/invitations", async (c) => {
  const email = await team.confirmedEmail(c.get("userId"));
  const incoming = email ? await team.incomingInvitations(email) : [];
  const names = await projectNames(incoming.map((row) => row.project_id));

  return c.json({
    invitations: incoming.flatMap((row) => {
      const name = names.get(row.project_id);
      return name ? [{ id: row.id, project: { id: row.project_id, name }, expiresAt: row.expires_at }] : [];
    }),
  });
});

/**
 * Inviterer en e-postadresse til prosjektet.
 *
 * Står det allerede en åpen invitasjon til adressen, fornyes den og sendes på
 * nytt – det er det eieren mener når hen trykker «Inviter» på samme adresse to
 * ganger, og det gir mottakeren én invitasjon å forholde seg til, ikke to.
 */
teamApi.post("/projects/:projectId/invitations", async (c) => {
  const project = await loadOwnedProject(c, c.req.param("projectId"));
  const userId = c.get("userId");

  if (project.parent_project_id) {
    fail(400, "team.dev_site", "Inviter til hovedprosjektet – dev-sidene følger med.");
  }

  const body = await c.req.json<{ email?: unknown }>().catch(() => null);
  const email = team.normalizeEmail(body?.email);

  if (!email) {
    fail(400, "team.invalid_email", "Skriv inn en gyldig e-postadresse.");
  }

  if (email === (c.get("userEmail") ?? "").toLowerCase()) {
    fail(400, "team.self", "Du eier prosjektet allerede.");
  }

  const members = await team.membersOf([project.id]);
  const memberPeople = await team.peopleById(members.map((row) => row.user_id));
  if ([...memberPeople.values()].some((person) => person.email?.toLowerCase() === email)) {
    fail(409, "team.already_member", `${email} er allerede med i prosjektet.`, { email });
  }

  const { data: openRows, error: openError } = await supabase
    .from("project_invitations")
    .select("*")
    .eq("project_id", project.id)
    .is("accepted_at", null)
    .is("declined_at", null)
    .is("revoked_at", null);
  if (openError) dbError(openError);

  const open = (openRows ?? []) as team.InvitationRow[];
  const existing = open.find((row) => row.email === email) ?? null;

  if (!existing && members.length + open.length >= team.MAX_TEAM_SIZE) {
    fail(409, "team.limit_reached", `Et prosjekt kan ha opptil ${team.MAX_TEAM_SIZE} i teamet.`, {
      max: team.MAX_TEAM_SIZE,
    });
  }

  if (existing && Date.now() - new Date(existing.sent_at).getTime() < team.RESEND_COOLDOWN_MS) {
    fail(429, "team.resend_too_soon", "Invitasjonen ble nettopp sendt. Vent et kvarter før du sender den på nytt.", {
      minutes: team.RESEND_COOLDOWN_MS / 60_000,
    });
  }

  const { count, error: countError } = await supabase
    .from("project_invitations")
    .select("id", { count: "exact", head: true })
    .eq("invited_by", userId)
    .gte("sent_at", new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString());
  if (countError) dbError(countError);

  if ((count ?? 0) >= team.MAX_INVITES_PER_DAY) {
    fail(429, "team.rate_limited", "Du har sendt mange invitasjoner det siste døgnet. Prøv igjen senere.", {
      max: team.MAX_INVITES_PER_DAY,
    });
  }

  const now = new Date();
  const fields = {
    invited_by: userId,
    sent_at: now.toISOString(),
    expires_at: new Date(now.getTime() + team.INVITATION_TTL_DAYS * 24 * 60 * 60 * 1000).toISOString(),
  };

  const write = existing
    ? supabase.from("project_invitations").update(fields).eq("id", existing.id).select("*").single()
    : supabase
        .from("project_invitations")
        .insert({ project_id: project.id, email, ...fields })
        .select("*")
        .single();

  const { data, error } = await write;

  if (error) {
    // To samtidige invitasjoner til samme adresse: den unike indeksen på åpne
    // invitasjoner stopper den andre. Den første står, og det er riktig svar.
    if (error.code === "23505") {
      fail(409, "team.already_invited", `${email} er allerede invitert.`, { email });
    }
    dbError(error);
  }

  const invitation = data as team.InvitationRow;

  // Et tidligere avslag fra samme adresse er besvart av denne invitasjonen.
  // Uten dette sto «Avslått» og «Venter» side om side for samme person.
  if (!existing) {
    await supabase
      .from("project_invitations")
      .update({ revoked_at: now.toISOString() })
      .eq("project_id", project.id)
      .eq("email", email)
      .not("declined_at", "is", null)
      .is("revoked_at", null);
  }

  const inviter = (await team.peopleById([userId])).get(userId)!;
  const emailSent = await team.sendInvitationEmail(invitation, project, inviter);

  logger.info(
    { userId, project: project.name, invitation: invitation.id, renewed: Boolean(existing), emailSent },
    "Invitasjon til prosjekt sendt",
  );

  return c.json(
    {
      invitation: {
        id: invitation.id,
        email: invitation.email,
        status: team.invitationStatus(invitation),
        sentAt: invitation.sent_at,
        expiresAt: invitation.expires_at,
        link: team.invitationLink(invitation.id),
      },
      emailSent,
      renewed: Boolean(existing),
    },
    existing ? 200 : 201,
  );
});

/** Trekker tilbake en invitasjon. Bare eieren av prosjektet. */
teamApi.delete("/invitations/:invitationId", async (c) => {
  const invitation = await team.loadInvitation(c.req.param("invitationId"));
  if (!invitation) fail(404, "team.invitation_not_found", "Invitasjonen finnes ikke.");

  await loadOwnedProject(c, invitation.project_id);

  const { error } = await supabase
    .from("project_invitations")
    .update({ revoked_at: new Date().toISOString() })
    .eq("id", invitation.id)
    .is("accepted_at", null);
  if (error) dbError(error);

  return c.json({ revoked: true });
});

/**
 * Slår opp en invitasjon og bekrefter at den er til den innloggede brukeren.
 *
 * Feil adressat får 403 med en maskert adresse, ikke 404: personen *har* fått en
 * lenke fra noen, og det nyttige svaret er «logg inn med o•••@firma.no», ikke
 * «finnes ikke».
 */
async function invitationForCaller(
  invitationId: string,
  userId: string,
): Promise<{ invitation: team.InvitationRow; project: Project }> {
  const invitation = await team.loadInvitation(invitationId);
  if (!invitation || invitation.revoked_at) {
    fail(404, "team.invitation_not_found", "Invitasjonen finnes ikke, eller er trukket tilbake.");
  }

  const email = await team.confirmedEmail(userId);
  if (email !== invitation.email) {
    fail(403, "team.invitation_other_account", "Invitasjonen ble sendt til en annen e-postadresse.", {
      email: team.maskEmail(invitation.email),
    });
  }

  const { data, error } = await supabase
    .from("projects")
    .select("*")
    .eq("id", invitation.project_id)
    .maybeSingle();
  if (error) dbError(error);
  if (!data) fail(404, "team.invitation_not_found", "Prosjektet finnes ikke lenger.");

  return { invitation, project: data as Project };
}

/** Det invitasjonssiden viser før brukeren svarer. */
teamApi.get("/invitations/:invitationId", async (c) => {
  const userId = c.get("userId");
  const { invitation, project } = await invitationForCaller(c.req.param("invitationId"), userId);

  const ids = [project.user_id, ...(invitation.invited_by ? [invitation.invited_by] : [])];
  const people = await team.peopleById(ids);

  const alreadyMember =
    project.user_id === userId ||
    (await team.membersOf([project.id])).some((row) => row.user_id === userId);

  return c.json({
    invitation: {
      id: invitation.id,
      project: { id: project.id, name: project.name },
      invitedBy: invitation.invited_by ? (people.get(invitation.invited_by) ?? null) : null,
      owner: people.get(project.user_id) ?? null,
      expiresAt: invitation.expires_at,
      status: invitation.accepted_at ? "accepted" : team.invitationStatus(invitation),
      alreadyMember,
    },
  });
});

/** Godtar en invitasjon. Brukeren blir medlem av prosjektet. */
teamApi.post("/invitations/:invitationId/accept", async (c) => {
  const userId = c.get("userId");
  const { invitation, project } = await invitationForCaller(c.req.param("invitationId"), userId);

  if (invitation.accepted_at) {
    // Dobbeltklikk, eller lenken åpnet på nytt. Er det samme bruker, er det ingen
    // feil – hen er allerede med.
    if (invitation.accepted_by === userId) return c.json({ projectId: project.id });
    fail(409, "team.invitation_used", "Invitasjonen er allerede brukt.");
  }

  const status = team.invitationStatus(invitation);
  if (status === "declined") {
    fail(409, "team.invitation_declined", "Du har avslått denne invitasjonen. Be om en ny.");
  }
  if (status === "expired") {
    fail(409, "team.invitation_expired", "Invitasjonen har utløpt. Be eieren sende den på nytt.");
  }

  if (project.user_id === userId) {
    fail(409, "team.self", "Du eier prosjektet allerede.");
  }

  // Invitasjonen krysses av *først*, betinget på at den fortsatt er åpen. To
  // samtidige godtak – eller et godtak og en tilbaketrekking – kan da ikke begge
  // vinne: den som kommer sist, treffer null rader.
  const { data: claimed, error: claimError } = await supabase
    .from("project_invitations")
    .update({ accepted_at: new Date().toISOString(), accepted_by: userId })
    .eq("id", invitation.id)
    .is("accepted_at", null)
    .is("declined_at", null)
    .is("revoked_at", null)
    .select("id");
  if (claimError) dbError(claimError);

  if (!claimed || claimed.length === 0) {
    fail(409, "team.invitation_used", "Invitasjonen er ikke lenger åpen.");
  }

  const { error } = await supabase.from("project_members").upsert(
    { project_id: project.id, user_id: userId, invited_by: invitation.invited_by },
    { onConflict: "project_id,user_id", ignoreDuplicates: true },
  );

  if (error) {
    // Medlemskapet ble ikke skrevet. Gjenåpne invitasjonen, så brukeren kan
    // prøve igjen i stedet for å sitte igjen med en brukt lenke og ingen tilgang.
    await supabase
      .from("project_invitations")
      .update({ accepted_at: null, accepted_by: null })
      .eq("id", invitation.id);
    dbError(error);
  }

  logger.info({ userId, project: project.name, invitation: invitation.id }, "Invitasjon godtatt");

  return c.json({ projectId: project.id });
});

/** Avslår en invitasjon. Eieren ser avslaget på sin teamside. */
teamApi.post("/invitations/:invitationId/decline", async (c) => {
  const { invitation } = await invitationForCaller(c.req.param("invitationId"), c.get("userId"));

  if (invitation.accepted_at) {
    fail(409, "team.invitation_used", "Invitasjonen er allerede godtatt. Forlat prosjektet i stedet.");
  }

  const { error } = await supabase
    .from("project_invitations")
    .update({ declined_at: new Date().toISOString() })
    .eq("id", invitation.id)
    .is("accepted_at", null);
  if (error) dbError(error);

  return c.json({ declined: true });
});

/**
 * Fjerner et medlem fra prosjektet.
 *
 * Eieren kan fjerne hvem som helst; et medlem kan bare fjerne seg selv – det er
 * «Forlat prosjektet».
 */
teamApi.delete("/projects/:projectId/members/:memberId", async (c) => {
  const project = await loadProject(c, c.req.param("projectId"), "member");
  const userId = c.get("userId");
  const memberId = c.req.param("memberId");

  if (project.parent_project_id) {
    fail(400, "team.dev_site", "Teamet styres på hovedprosjektet.");
  }

  if (project.user_id !== userId && memberId !== userId) {
    fail(403, "team.owner_only", "Bare eieren av prosjektet kan fjerne andre fra teamet.");
  }

  const { data, error } = await supabase
    .from("project_members")
    .delete()
    .eq("project_id", project.id)
    .eq("user_id", memberId)
    .select("user_id");
  if (error) dbError(error);

  if (!data || data.length === 0) {
    fail(404, "team.member_not_found", "Brukeren er ikke med i prosjektet.");
  }

  logger.info(
    { userId, project: project.name, removed: memberId, left: memberId === userId },
    "Medlem fjernet fra prosjekt",
  );

  return c.json({ removed: true });
});
