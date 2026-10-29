import { logger } from "../lib/logger.js";
import { dashboardUrl } from "../lib/public-url.js";
import { supabase } from "../lib/supabase.js";
import type { Project } from "../types.js";
import { sendCustomerEmail } from "./notify.js";

/**
 * Team på et prosjekt: medlemmer og invitasjoner (migrasjon 0020).
 *
 * Tilgangsreglene står i `routes/team.ts` og `middleware/auth.ts`. Her ligger
 * oppslagene og e-posten – det som er likt uansett hvem som spør.
 */

/** Hvor lenge en invitasjon kan godtas. Fornyes når den sendes på nytt. */
export const INVITATION_TTL_DAYS = 14;

/**
 * Hvor mange som kan være med i ett prosjekt, eieren uregnet. Åpne invitasjoner
 * teller med – ellers kunne man stilt hundre invitasjoner i kø under taket.
 */
export const MAX_TEAM_SIZE = 25;

/**
 * Hvor mange invitasjoner én konto kan sende per døgn.
 *
 * E-posten går fra vårt domene. Uten et tak er «inviter» en måte å få Snoat til
 * å sende e-post til hvem som helst, så mange ganger man vil – og det er vårt
 * avsenderomdømme hos Resend som tar støyten.
 */
export const MAX_INVITES_PER_DAY = 30;

/**
 * Minste tid mellom to utsendelser av samme invitasjon.
 *
 * Døgntaket over teller invitasjoner, ikke utsendelser – en som sendes på nytt
 * er fortsatt én rad. Uten en pause her kunne én adresse fått en e-post i
 * minuttet så lenge noen holdt på å trykke.
 */
export const RESEND_COOLDOWN_MS = 15 * 60_000;

/** En bruker slik teamsiden viser hen. */
export interface TeamPerson {
  userId: string;
  name: string | null;
  email: string | null;
  avatarUrl: string | null;
}

export interface InvitationRow {
  id: string;
  project_id: string;
  email: string;
  invited_by: string | null;
  created_at: string;
  sent_at: string;
  expires_at: string;
  accepted_at: string | null;
  accepted_by: string | null;
  declined_at: string | null;
  revoked_at: string | null;
}

export interface MemberRow {
  project_id: string;
  user_id: string;
  invited_by: string | null;
  created_at: string;
}

/**
 * Normaliserer og validerer en e-postadresse. `null` hvis den ikke ser ut som en.
 *
 * Samme regel som check-constrainten i migrasjonen, slik at vi kan svare 400 med
 * en forklaring i stedet for å la Postgres svare 500.
 */
export function normalizeEmail(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const email = value.trim().toLowerCase();
  if (email.length > 254 || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return null;
  return email;
}

/**
 * `ola.nordmann@firma.no` → `o•••@firma.no`.
 *
 * Brukes når en invitasjon åpnes av feil konto: personen skal kunne kjenne igjen
 * hvilken adresse den gjelder, uten at lenken avslører hele adressen til den som
 * måtte ha fått den videresendt.
 */
export function maskEmail(email: string): string {
  const [local = "", domain = ""] = email.split("@");
  return `${local.slice(0, 1)}•••@${domain}`;
}

/** Hvor invitasjonen åpnes i dashboardet. Ingen hemmelighet – se migrasjonen. */
export function invitationLink(invitationId: string): string {
  return `${dashboardUrl()}/invite/${invitationId}`;
}

/** `pending`, `expired` eller `declined` for en invitasjon som ikke er godtatt. */
export function invitationStatus(row: InvitationRow, now = Date.now()): "pending" | "expired" | "declined" {
  if (row.declined_at) return "declined";
  return new Date(row.expires_at).getTime() <= now ? "expired" : "pending";
}

/**
 * E-posten til brukeren, **kun hvis den er bekreftet**. Ellers `null`.
 *
 * Bekreftelsen er hele grunnlaget for at en invitasjon kan godtas: uten den
 * kunne hvem som helst registrert seg med adressen i invitasjonen og tatt plassen.
 * Registrering krever bekreftelse allerede (`ENABLE_EMAIL_AUTOCONFIRM=false`), men
 * regelen skal ikke hvile på en innstilling et annet sted.
 */
export async function confirmedEmail(userId: string): Promise<string | null> {
  const { data, error } = await supabase.auth.admin.getUserById(userId);

  if (error || !data.user) {
    logger.warn({ userId, err: error }, "Kunne ikke slå opp brukeren i Supabase Auth");
    return null;
  }

  const user = data.user;
  if (!user.email || !(user.email_confirmed_at ?? user.confirmed_at)) return null;

  return user.email.toLowerCase();
}

/**
 * Navn, e-post og avatar for en liste brukere.
 *
 * Navn og avatar ligger i `profiles`, e-posten bare i `auth.users` – og den når
 * vi kun med service-role-nøkkelen, ett kall per bruker. Team er små, så det er
 * et akseptabelt antall kall for en side som åpnes for hånd.
 */
export async function peopleById(userIds: Iterable<string>): Promise<Map<string, TeamPerson>> {
  const ids = [...new Set(userIds)];
  const people = new Map<string, TeamPerson>();

  if (ids.length === 0) return people;

  const { data: profiles, error } = await supabase
    .from("profiles")
    .select("id, full_name, avatar_url")
    .in("id", ids);

  if (error) throw new Error(`Kunne ikke lese profiler: ${error.message}`);

  const profileById = new Map((profiles ?? []).map((row) => [row.id as string, row]));

  await Promise.all(
    ids.map(async (id) => {
      const { data } = await supabase.auth.admin.getUserById(id);
      const profile = profileById.get(id);
      people.set(id, {
        userId: id,
        name: (profile?.full_name as string | null) ?? null,
        email: data?.user?.email ?? null,
        avatarUrl: (profile?.avatar_url as string | null) ?? null,
      });
    }),
  );

  return people;
}

/** Medlemmene i et (hoved)prosjekt. */
export async function membersOf(projectIds: string[]): Promise<MemberRow[]> {
  if (projectIds.length === 0) return [];

  const { data, error } = await supabase
    .from("project_members")
    .select("project_id, user_id, invited_by, created_at")
    .in("project_id", projectIds)
    .order("created_at", { ascending: true });

  if (error) throw new Error(`Kunne ikke lese medlemmer: ${error.message}`);

  return (data ?? []) as MemberRow[];
}

/**
 * Invitasjonene eieren skal se: åpne (også utløpte, så de kan sendes på nytt) og
 * de som er avslått den siste måneden – ellers ville et nei bare forsvunnet, og
 * eieren hadde ventet på et svar som aldri kommer.
 */
export async function visibleInvitationsFor(projectIds: string[]): Promise<InvitationRow[]> {
  if (projectIds.length === 0) return [];

  const declinedSince = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

  const { data, error } = await supabase
    .from("project_invitations")
    .select("*")
    .in("project_id", projectIds)
    .is("accepted_at", null)
    .is("revoked_at", null)
    .or(`declined_at.is.null,declined_at.gt.${declinedSince}`)
    .order("created_at", { ascending: true });

  if (error) throw new Error(`Kunne ikke lese invitasjoner: ${error.message}`);

  return (data ?? []) as InvitationRow[];
}

/** Åpne, gyldige invitasjoner til en e-postadresse. */
export async function incomingInvitations(email: string): Promise<InvitationRow[]> {
  const { data, error } = await supabase
    .from("project_invitations")
    .select("*")
    .eq("email", email)
    .is("accepted_at", null)
    .is("declined_at", null)
    .is("revoked_at", null)
    .gt("expires_at", new Date().toISOString())
    .order("created_at", { ascending: false });

  if (error) throw new Error(`Kunne ikke lese invitasjoner: ${error.message}`);

  return (data ?? []) as InvitationRow[];
}

export async function loadInvitation(id: string): Promise<InvitationRow | null> {
  // Ikke en uuid → kan ikke finnes. Uten sjekken svarer Postgres 500 på en
  // ugyldig verdi, og en tilfeldig URL skal gi «finnes ikke».
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;

  const { data, error } = await supabase
    .from("project_invitations")
    .select("*")
    .eq("id", id)
    .maybeSingle();

  if (error) throw new Error(`Kunne ikke lese invitasjonen: ${error.message}`);

  return (data as InvitationRow | null) ?? null;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Sender invitasjonen på e-post. Svarer om den kom fram til Resend.
 *
 * Teksten er på norsk og engelsk: vi vet ikke hvilket språk mottakeren bruker –
 * hen har kanskje ikke en konto ennå.
 */
export async function sendInvitationEmail(
  invitation: InvitationRow,
  project: Project,
  inviter: TeamPerson,
): Promise<boolean> {
  const link = invitationLink(invitation.id);
  // Navnet kommer fra GitHub-profilen og er fritekst. Det havner i emnefeltet,
  // så linjeskift ut og lengden ned.
  const who = (inviter.name ?? inviter.email ?? "En Snoat-bruker").replace(/\s+/g, " ").trim().slice(0, 80);
  const expires = new Date(invitation.expires_at).toISOString().slice(0, 10);

  const text = [
    `${who} har invitert deg til prosjektet «${project.name}» på Snoat.`,
    "",
    `Godta invitasjonen her: ${link}`,
    "",
    `Logg inn (eller registrer deg) med denne e-postadressen, ${invitation.email}. ` +
      `Invitasjonen gjelder til ${expires}.`,
    "",
    "---",
    "",
    `${who} has invited you to the project "${project.name}" on Snoat.`,
    "",
    `Accept the invitation: ${link}`,
    "",
    `Sign in (or sign up) with this email address, ${invitation.email}. ` +
      `The invitation is valid until ${expires}.`,
    "",
    "Fikk du denne ved en feil, kan du se bort fra den. / If you weren't expecting this, you can ignore it.",
  ].join("\n");

  const html = `<!doctype html>
<html lang="no">
  <body style="margin:0;padding:32px 16px;background:#f6f4ee;font-family:Helvetica,Arial,sans-serif;color:#111">
    <div style="max-width:520px;margin:0 auto;background:#fff;border:2px solid #111;padding:32px">
      <h1 style="margin:0 0 16px;font-size:22px">Du er invitert til «${escapeHtml(project.name)}»</h1>
      <p style="margin:0 0 24px;font-size:16px;line-height:1.5">
        ${escapeHtml(who)} har invitert deg til å jobbe på prosjektet
        <strong>${escapeHtml(project.name)}</strong> på Snoat.
      </p>
      <p style="margin:0 0 24px">
        <a href="${escapeHtml(link)}" style="display:inline-block;background:#111;color:#fff;text-decoration:none;padding:12px 24px;font-size:15px;font-weight:bold">Se invitasjonen</a>
      </p>
      <p style="margin:0 0 8px;font-size:14px;line-height:1.5;color:#555">
        Logg inn eller registrer deg med <strong>${escapeHtml(invitation.email)}</strong>.
        Invitasjonen gjelder til ${expires}.
      </p>
      <hr style="border:0;border-top:1px solid #ddd;margin:24px 0">
      <p style="margin:0;font-size:14px;line-height:1.5;color:#555">
        ${escapeHtml(who)} has invited you to the project <strong>${escapeHtml(project.name)}</strong> on Snoat.
        Sign in or sign up with ${escapeHtml(invitation.email)} to accept. Valid until ${expires}.
      </p>
      <p style="margin:24px 0 0;font-size:12px;color:#888">
        Fikk du denne ved en feil, kan du se bort fra den. / If you weren't expecting this, you can ignore it.
      </p>
    </div>
  </body>
</html>`;

  return sendCustomerEmail({
    to: invitation.email,
    subject: `${who} har invitert deg til ${project.name} på Snoat`,
    text,
    html,
  });
}
