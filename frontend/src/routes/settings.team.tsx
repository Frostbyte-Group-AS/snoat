import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";

import {
  acceptInvitation,
  declineInvitation,
  getTeam,
  inviteToProject,
  removeProjectMember,
  revokeInvitation,
  type TeamInvitation,
  type TeamMember,
  type TeamOverview,
  type TeamPerson,
} from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useApiErrorMessage } from "@/lib/errors";

/**
 * «Team» – hvem som har tilgang til prosjektene dine.
 *
 * Alt på én side, og ikke en fane i hvert prosjekt: spørsmålet «hvem har tilgang
 * til hva?» gjelder kontoen, og svaret skal kunne leses uten å åpne prosjektene
 * ett for ett. Prosjektsiden har en snarvei hit (`?project=<id>`), som velger
 * prosjektet i invitasjonsskjemaet.
 *
 * Rekkefølgen på kortene følger hva som haster: invitasjoner som venter på deg
 * først, så skjemaet, så oversikten.
 *
 * Tilgangsreglene håndheves i backend (`routes/team.ts`) og i databasen
 * (migrasjon 0020). Det denne siden skjuler, er bare visning.
 */
export const Route = createFileRoute("/settings/team")({
  validateSearch: (search: Record<string, unknown>): { project?: string } =>
    typeof search.project === "string" && search.project ? { project: search.project } : {},
  head: () => ({
    meta: [{ title: "Team — Snoat" }, { name: "robots", content: "noindex" }],
  }),
  component: TeamSettingsPage,
});

function TeamSettingsPage() {
  const { t } = useTranslation();
  const search = Route.useSearch();

  const team = useQuery({ queryKey: ["team"], queryFn: getTeam });

  if (team.isLoading) {
    return <p className="font-body text-[16px] text-ink/70">{t("team.loading")}</p>;
  }

  if (team.isError || !team.data) {
    return (
      <section className="ink-card-lg px-[30px] py-[32px]">
        <p role="alert" className="font-body text-[16px] text-error">
          {team.error?.message ?? t("errors.unknown")}
        </p>
      </section>
    );
  }

  return (
    <div className="flex flex-col gap-[31px]">
      {team.data.incoming.length > 0 && <IncomingCard incoming={team.data.incoming} />}
      <InviteCard overview={team.data} preselect={search.project} />
      <OwnedCard owned={team.data.owned} />
      {team.data.shared.length > 0 && <SharedCard shared={team.data.shared} />}
    </div>
  );
}

// -----------------------------------------------------------------------------
// Små byggeklosser
// -----------------------------------------------------------------------------

function useFormatDate() {
  const { i18n } = useTranslation();
  return (value: string) =>
    new Date(value).toLocaleDateString(i18n.language === "en" ? "en-GB" : "nb-NO", {
      day: "numeric",
      month: "short",
      year: "numeric",
    });
}

/** Navnet hvis vi har det, ellers e-posten. */
function personLabel(person: TeamPerson | null | undefined, fallback: string): string {
  return person?.name || person?.email || fallback;
}

function Avatar({ person, label }: { person: TeamPerson | null; label: string }) {
  if (person?.avatarUrl) {
    return <img src={person.avatarUrl} alt="" className="h-9 w-9 shrink-0 object-cover" />;
  }
  return (
    <span
      aria-hidden="true"
      className="flex h-9 w-9 shrink-0 items-center justify-center bg-ink font-body text-[15px] font-bold text-paper"
    >
      {label[0]?.toUpperCase() ?? "?"}
    </span>
  );
}

function CopyLinkButton({ link }: { link: string }) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);

  return (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard.writeText(link);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      }}
      className="font-body text-[14px] text-ink underline decoration-hair underline-offset-[4px] hover:decoration-ink"
    >
      {copied ? t("team.link_copied") : t("team.copy_link")}
    </button>
  );
}

// -----------------------------------------------------------------------------
// Invitasjoner til deg
// -----------------------------------------------------------------------------

function IncomingCard({ incoming }: { incoming: TeamOverview["incoming"] }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const errorMessage = useApiErrorMessage();
  const [error, setError] = useState<string | null>(null);

  const refresh = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["team"] }),
      queryClient.invalidateQueries({ queryKey: ["team-incoming"] }),
      queryClient.invalidateQueries({ queryKey: ["projects"] }),
    ]);
  };

  const accept = useMutation({
    mutationFn: acceptInvitation,
    onSuccess: async ({ projectId }) => {
      await refresh();
      void navigate({ to: "/projects/$projectId", params: { projectId } });
    },
    onError: (cause) => setError(errorMessage(cause)),
  });

  const decline = useMutation({
    mutationFn: declineInvitation,
    onSuccess: refresh,
    onError: (cause) => setError(errorMessage(cause)),
  });

  const busy = accept.isPending || decline.isPending;

  return (
    <section className="anim-rise flex flex-col gap-5 border-2 border-line bg-sun px-[30px] py-[28px]">
      <div className="flex flex-col gap-1">
        <h2 className="font-display text-[22px] font-bold text-ink">{t("team.incoming_title")}</h2>
        <p className="font-body text-[14px] text-ink/80">{t("team.incoming_subtitle")}</p>
      </div>

      {error && (
        <p role="alert" className="font-body text-[15px] text-error">
          {error}
        </p>
      )}

      <ul className="flex flex-col divide-y divide-ink/20 border-y border-ink/20">
        {incoming.map((invitation) => (
          <li
            key={invitation.id}
            className="flex flex-col justify-between gap-3 py-4 sm:flex-row sm:items-center"
          >
            <span className="font-body text-[16px] text-ink">
              {t("team.incoming_row", {
                who: personLabel(invitation.invitedBy, t("team.someone")),
                project: invitation.project.name,
              })}
            </span>
            <div className="flex shrink-0 gap-3">
              <button
                type="button"
                disabled={busy}
                onClick={() => accept.mutate(invitation.id)}
                className="btn-ink px-[18px] py-[9px] font-body text-[15px] disabled:opacity-50"
              >
                {t("team.accept")}
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => decline.mutate(invitation.id)}
                className="btn-outline px-[18px] py-[9px] font-body text-[15px] disabled:opacity-50"
              >
                {t("team.decline")}
              </button>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

// -----------------------------------------------------------------------------
// Inviter
// -----------------------------------------------------------------------------

function InviteCard({ overview, preselect }: { overview: TeamOverview; preselect?: string }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const errorMessage = useApiErrorMessage();
  const emailRef = useRef<HTMLInputElement>(null);

  const projects = overview.owned.map((entry) => entry.project);
  const initial = projects.find((project) => project.id === preselect)?.id ?? projects[0]?.id ?? "";

  const [email, setEmail] = useState("");
  const [projectId, setProjectId] = useState(initial);
  const [result, setResult] = useState<
    | { kind: "sent" | "not_sent"; email: string; link: string }
    | { kind: "error"; message: string }
    | null
  >(null);

  // Kom brukeren hit fra et prosjekt, er det dit hen vil invitere. Feltet får
  // fokus med én gang, så neste tastetrykk er e-postadressen.
  useEffect(() => {
    if (preselect && projects.some((project) => project.id === preselect)) {
      setProjectId(preselect);
      emailRef.current?.focus();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preselect]);

  const invite = useMutation({
    mutationFn: () => inviteToProject(projectId, email),
    onSuccess: async (data) => {
      setResult({
        kind: data.emailSent ? "sent" : "not_sent",
        email: data.invitation.email,
        link: data.invitation.link,
      });
      setEmail("");
      await queryClient.invalidateQueries({ queryKey: ["team"] });
    },
    onError: (cause) => setResult({ kind: "error", message: errorMessage(cause) }),
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setResult(null);
    invite.mutate();
  };

  return (
    <section
      id="invite"
      className="ink-card-lg anim-rise [--anim-delay:60ms] flex flex-col gap-6 px-[30px] py-[32px]"
    >
      <div className="flex flex-col gap-2">
        <span className="w-fit bg-sun px-[8px] py-[2px] font-body text-[12px] font-bold uppercase tracking-[0.1em] text-ink">
          {t("team.eyebrow")}
        </span>
        <h2 className="font-display text-[28px] font-bold text-ink">{t("team.title")}</h2>
        <p className="max-w-2xl font-body text-[16px] text-ink/70">{t("team.intro")}</p>
      </div>

      {projects.length === 0 ? (
        <p className="border-2 border-hair px-[16px] py-[12px] font-body text-[15px] text-ink/70">
          {t("team.no_projects")}{" "}
          <Link to="/dashboard" className="text-ink underline underline-offset-[4px]">
            {t("team.go_to_dashboard")}
          </Link>
        </p>
      ) : (
        <form onSubmit={submit} className="flex flex-col gap-4">
          <div className="grid gap-4 md:grid-cols-[1fr_minmax(0,260px)_auto] md:items-end">
            <label className="flex flex-col gap-2">
              <span className="font-body text-[15px] font-bold text-ink">
                {t("team.email_label")}
              </span>
              <input
                ref={emailRef}
                type="email"
                required
                autoComplete="off"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                placeholder={t("team.email_placeholder")}
                className="field-ink w-full px-[14px] py-[12px] font-body text-[16px] outline-none"
              />
            </label>

            <label className="flex flex-col gap-2">
              <span className="font-body text-[15px] font-bold text-ink">
                {t("team.project_label")}
              </span>
              <select
                value={projectId}
                onChange={(event) => setProjectId(event.target.value)}
                className="field-ink w-full px-[14px] py-[12px] font-body text-[16px] outline-none"
              >
                {projects.map((project) => (
                  <option key={project.id} value={project.id}>
                    {project.name}
                  </option>
                ))}
              </select>
            </label>

            <button
              type="submit"
              disabled={invite.isPending || !email.trim() || !projectId}
              className="btn-ink h-[50px] px-[24px] font-body text-[15px] disabled:opacity-50"
            >
              {invite.isPending ? t("team.sending") : t("team.send_invite")}
            </button>
          </div>

          <div className="collapse-grid" data-open={result ? "true" : "false"} inert={!result}>
            <div>
              {result?.kind === "sent" && (
                <p
                  role="status"
                  className="bg-sun px-[16px] py-[12px] font-body text-[15px] text-ink"
                >
                  {t("team.sent", { email: result.email })}
                </p>
              )}
              {result?.kind === "not_sent" && (
                <div
                  role="status"
                  className="flex flex-col gap-2 border-2 border-line px-[16px] py-[12px] font-body text-[15px] text-ink sm:flex-row sm:items-center sm:justify-between"
                >
                  <span>{t("team.not_sent", { email: result.email })}</span>
                  <CopyLinkButton link={result.link} />
                </div>
              )}
              {result?.kind === "error" && (
                <p
                  role="alert"
                  className="border-2 border-error px-[16px] py-[12px] font-body text-[15px] text-error"
                >
                  {result.message}
                </p>
              )}
            </div>
          </div>
        </form>
      )}

      <ul className="flex flex-col gap-2 border-t border-hair pt-5 font-body text-[14px] text-ink/70">
        <li>{t("team.rule_member")}</li>
        <li>{t("team.rule_owner")}</li>
        <li>{t("team.rule_accept")}</li>
      </ul>
    </section>
  );
}

// -----------------------------------------------------------------------------
// Prosjektene dine
// -----------------------------------------------------------------------------

function OwnedCard({ owned }: { owned: TeamOverview["owned"] }) {
  const { t } = useTranslation();

  if (owned.length === 0) return null;

  return (
    <section className="ink-card anim-rise [--anim-delay:120ms] flex flex-col gap-6 px-[30px] py-[28px]">
      <div className="flex flex-col gap-1">
        <h2 className="font-display text-[22px] font-bold text-ink">{t("team.owned_title")}</h2>
        <p className="font-body text-[14px] text-ink/70">{t("team.owned_subtitle")}</p>
      </div>

      <div className="flex flex-col gap-8">
        {owned.map((entry) => (
          <OwnedProject key={entry.project.id} entry={entry} />
        ))}
      </div>
    </section>
  );
}

function OwnedProject({ entry }: { entry: TeamOverview["owned"][number] }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { project, members, invitations } = entry;
  const empty = members.length === 0 && invitations.length === 0;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Link
          to="/projects/$projectId"
          params={{ projectId: project.id }}
          className="font-body text-[18px] font-bold text-ink underline decoration-hair underline-offset-[5px] hover:decoration-ink"
        >
          {project.name}
        </Link>
        <button
          type="button"
          onClick={() => {
            void navigate({ to: "/settings/team", search: { project: project.id } });
            document
              .getElementById("invite")
              ?.scrollIntoView({ behavior: "smooth", block: "start" });
          }}
          className="btn-outline px-[14px] py-[7px] font-body text-[14px]"
        >
          {t("team.invite_to", { project: project.name })}
        </button>
      </div>

      {empty ? (
        <p className="font-body text-[15px] italic text-ink/60">{t("team.only_you")}</p>
      ) : (
        <ul className="divide-y divide-hair border-y border-hair">
          {members.map((member) => (
            <MemberRow
              key={member.userId}
              projectId={project.id}
              projectName={project.name}
              member={member}
            />
          ))}
          {invitations.map((invitation) => (
            <InvitationRow key={invitation.id} projectId={project.id} invitation={invitation} />
          ))}
        </ul>
      )}
    </div>
  );
}

function MemberRow({
  projectId,
  projectName,
  member,
}: {
  projectId: string;
  projectName: string;
  member: TeamMember;
}) {
  const { t } = useTranslation();
  const formatDate = useFormatDate();
  const queryClient = useQueryClient();
  const errorMessage = useApiErrorMessage();
  const label = personLabel(member, t("team.unknown_user"));

  const remove = useMutation({
    mutationFn: () => removeProjectMember(projectId, member.userId),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["team"] }),
    onError: (cause) => alert(errorMessage(cause)),
  });

  return (
    <li className="flex flex-col justify-between gap-3 py-4 sm:flex-row sm:items-center">
      <div className="flex min-w-0 items-center gap-3">
        <Avatar person={member} label={label} />
        <div className="flex min-w-0 flex-col">
          <span className="truncate font-body text-[16px] font-bold text-ink">{label}</span>
          <span className="truncate font-body text-[13px] text-ink/70">
            {member.name && member.email ? `${member.email} · ` : ""}
            {t("team.member_since", { date: formatDate(member.joinedAt) })}
          </span>
        </div>
      </div>
      <button
        type="button"
        disabled={remove.isPending}
        onClick={() => {
          if (confirm(t("team.remove_confirm", { who: label, project: projectName })))
            remove.mutate();
        }}
        className="btn-outline self-start border-error px-[14px] py-[7px] font-body text-[14px] text-error hover:bg-error hover:text-paper disabled:opacity-50 sm:self-auto"
      >
        {t("team.remove")}
      </button>
    </li>
  );
}

function InvitationRow({
  projectId,
  invitation,
}: {
  projectId: string;
  invitation: TeamInvitation;
}) {
  const { t } = useTranslation();
  const formatDate = useFormatDate();
  const queryClient = useQueryClient();
  const errorMessage = useApiErrorMessage();
  const [notice, setNotice] = useState<string | null>(null);

  const refresh = () => void queryClient.invalidateQueries({ queryKey: ["team"] });

  const resend = useMutation({
    mutationFn: () => inviteToProject(projectId, invitation.email),
    onSuccess: (data) => {
      setNotice(data.emailSent ? t("team.resent") : t("team.not_sent_short"));
      refresh();
    },
    onError: (cause) => setNotice(errorMessage(cause)),
  });

  const revoke = useMutation({
    mutationFn: () => revokeInvitation(invitation.id),
    onSuccess: refresh,
    onError: (cause) => setNotice(errorMessage(cause)),
  });

  const chip =
    invitation.status === "pending"
      ? { text: t("team.status_pending"), className: "border-line bg-sun" }
      : invitation.status === "expired"
        ? { text: t("team.status_expired"), className: "border-hair text-ink/70" }
        : { text: t("team.status_declined"), className: "border-error text-error" };

  return (
    <li className="flex flex-col justify-between gap-3 py-4 sm:flex-row sm:items-center">
      <div className="flex min-w-0 items-center gap-3">
        <span
          aria-hidden="true"
          className="flex h-9 w-9 shrink-0 items-center justify-center border-2 border-dashed border-hair font-body text-[15px] text-ink/60"
        >
          @
        </span>
        <div className="flex min-w-0 flex-col">
          <span className="flex flex-wrap items-center gap-2">
            <span className="truncate font-body text-[16px] text-ink">{invitation.email}</span>
            <span className={`border-2 px-[6px] py-[0px] font-body text-[12px] ${chip.className}`}>
              {chip.text}
            </span>
          </span>
          <span className="font-body text-[13px] text-ink/70">
            {notice ??
              (invitation.status === "pending"
                ? t("team.invited_until", { date: formatDate(invitation.expiresAt) })
                : t("team.invited_at", { date: formatDate(invitation.sentAt) }))}
          </span>
        </div>
      </div>

      <div className="flex shrink-0 flex-wrap items-center gap-4">
        {invitation.status === "pending" && <CopyLinkButton link={invitation.link} />}
        <button
          type="button"
          disabled={resend.isPending}
          onClick={() => resend.mutate()}
          className="font-body text-[14px] text-ink underline decoration-hair underline-offset-[4px] hover:decoration-ink disabled:opacity-50"
        >
          {resend.isPending ? t("team.sending") : t("team.resend")}
        </button>
        <button
          type="button"
          disabled={revoke.isPending}
          onClick={() => revoke.mutate()}
          className="font-body text-[14px] text-error underline decoration-error/40 underline-offset-[4px] hover:decoration-error disabled:opacity-50"
        >
          {invitation.status === "pending" ? t("team.revoke") : t("team.dismiss")}
        </button>
      </div>
    </li>
  );
}

// -----------------------------------------------------------------------------
// Delt med deg
// -----------------------------------------------------------------------------

function SharedCard({ shared }: { shared: TeamOverview["shared"] }) {
  const { t } = useTranslation();
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const errorMessage = useApiErrorMessage();

  const leave = useMutation({
    mutationFn: (projectId: string) => removeProjectMember(projectId, user!.id),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["team"] }),
        queryClient.invalidateQueries({ queryKey: ["projects"] }),
      ]);
    },
    onError: (cause) => alert(errorMessage(cause)),
  });

  return (
    <section className="ink-card anim-rise [--anim-delay:180ms] flex flex-col gap-5 px-[30px] py-[28px]">
      <div className="flex flex-col gap-1">
        <h2 className="font-display text-[22px] font-bold text-ink">{t("team.shared_title")}</h2>
        <p className="font-body text-[14px] text-ink/70">{t("team.shared_subtitle")}</p>
      </div>

      <ul className="divide-y divide-hair border-y border-hair">
        {shared.map((entry) => {
          const owner = personLabel(entry.owner, t("team.unknown_user"));
          return (
            <li
              key={entry.project.id}
              className="flex flex-col justify-between gap-3 py-4 sm:flex-row sm:items-center"
            >
              <div className="flex min-w-0 items-center gap-3">
                <Avatar person={entry.owner} label={owner} />
                <div className="flex min-w-0 flex-col">
                  <Link
                    to="/projects/$projectId"
                    params={{ projectId: entry.project.id }}
                    className="truncate font-body text-[16px] font-bold text-ink underline decoration-hair underline-offset-[4px] hover:decoration-ink"
                  >
                    {entry.project.name}
                  </Link>
                  <span className="truncate font-body text-[13px] text-ink/70">
                    {t("team.owned_by", { who: owner })}
                  </span>
                </div>
              </div>
              <button
                type="button"
                disabled={leave.isPending}
                onClick={() => {
                  if (confirm(t("team.leave_confirm", { project: entry.project.name }))) {
                    leave.mutate(entry.project.id);
                  }
                }}
                className="btn-outline self-start border-error px-[14px] py-[7px] font-body text-[14px] text-error hover:bg-error hover:text-paper disabled:opacity-50 sm:self-auto"
              >
                {t("team.leave")}
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
