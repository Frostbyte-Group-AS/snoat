import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { DashboardNav } from "@/components/DashboardNav";
import { LanguageSwitcher } from "@/components/LanguageSwitcher";
import { SnoatLogo } from "@/components/SnoatLogo";
import { acceptInvitation, ApiError, declineInvitation, getInvitation } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useApiErrorMessage } from "@/lib/errors";
import { rememberReturnTo } from "@/lib/return-to";

/**
 * Landingssiden for lenken i invitasjons-e-posten.
 *
 * Lenken er ingen nøkkel: invitasjonen godtas bare av en innlogget bruker hvis
 * bekreftede e-post er adressen den ble sendt til (`routes/team.ts`). Siden har
 * derfor tre jobber, i den rekkefølgen brukeren møter dem:
 *
 *   1. Ikke innlogget → forklar hva som skjer, og send til innlogging med
 *      returadresse hit (samme mekanisme som samtykkesiden for MCP).
 *   2. Innlogget med feil konto → si hvilken adresse invitasjonen gjelder
 *      (maskert), og tilby å logge ut.
 *   3. Riktig konto → vis hvem som inviterer til hva, og la brukeren svare.
 */
export const Route = createFileRoute("/invite/$invitationId")({
  head: () => ({
    meta: [{ title: "Invitasjon — Snoat" }, { name: "robots", content: "noindex" }],
  }),
  component: InvitePage,
});

function InvitePage() {
  const { invitationId } = Route.useParams();
  const { user, loading } = useAuth();
  const { t } = useTranslation();

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-paper">
        <p className="font-body text-[17px] font-light text-ink/70">{t("login.loading")}</p>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen flex-col bg-paper">
      {user ? <DashboardNav /> : <PublicHeader />}
      <main className="mx-auto flex w-full max-w-[640px] flex-grow flex-col px-5 py-[64px]">
        {user ? (
          <InvitationCard invitationId={invitationId} />
        ) : (
          <SignedOutCard invitationId={invitationId} />
        )}
      </main>
    </div>
  );
}

function PublicHeader() {
  return (
    <header className="border-b-2 border-line bg-paper">
      <div className="mx-auto flex w-full max-w-[1334px] items-center justify-between px-5 py-[14px] lg:px-0">
        <Link to="/" aria-label="Snoat" className="inline-flex text-ink">
          <SnoatLogo size={30} />
        </Link>
        <LanguageSwitcher />
      </div>
    </header>
  );
}

function Card({ children }: { children: ReactNode }) {
  return (
    <section className="ink-card-lg anim-rise flex flex-col gap-6 px-[30px] py-[36px]">
      {children}
    </section>
  );
}

function Eyebrow() {
  const { t } = useTranslation();
  return (
    <span className="w-fit bg-sun px-[8px] py-[2px] font-body text-[12px] font-bold uppercase tracking-[0.1em] text-ink">
      {t("team.invite_eyebrow")}
    </span>
  );
}

function SignedOutCard({ invitationId }: { invitationId: string }) {
  const { t } = useTranslation();
  const navigate = useNavigate();

  return (
    <Card>
      <Eyebrow />
      <h1 className="font-display text-[30px] font-bold leading-[1.2] text-ink">
        {t("team.invite_signed_out_title")}
      </h1>
      <p className="font-body text-[16px] text-ink/70">{t("team.invite_signed_out_body")}</p>
      <button
        type="button"
        onClick={() => {
          rememberReturnTo(`/invite/${invitationId}`);
          void navigate({ to: "/login" });
        }}
        className="btn-ink w-fit px-[24px] py-[12px] font-body text-[15px]"
      >
        {t("team.invite_sign_in")}
      </button>
    </Card>
  );
}

function InvitationCard({ invitationId }: { invitationId: string }) {
  const { t, i18n } = useTranslation();
  const { user, signOut } = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const errorMessage = useApiErrorMessage();
  const [error, setError] = useState<string | null>(null);
  const [declined, setDeclined] = useState(false);

  const invitation = useQuery({
    queryKey: ["invitation", invitationId],
    queryFn: async () => (await getInvitation(invitationId)).invitation,
    retry: false,
  });

  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ["team"] }),
      queryClient.invalidateQueries({ queryKey: ["team-incoming"] }),
      queryClient.invalidateQueries({ queryKey: ["projects"] }),
    ]);

  const accept = useMutation({
    mutationFn: () => acceptInvitation(invitationId),
    onSuccess: async ({ projectId }) => {
      await refresh();
      void navigate({ to: "/projects/$projectId", params: { projectId } });
    },
    onError: (cause) => setError(errorMessage(cause)),
  });

  const decline = useMutation({
    mutationFn: () => declineInvitation(invitationId),
    onSuccess: async () => {
      setDeclined(true);
      await refresh();
    },
    onError: (cause) => setError(errorMessage(cause)),
  });

  if (invitation.isLoading) {
    return <p className="font-body text-[16px] text-ink/70">{t("team.loading")}</p>;
  }

  if (invitation.isError) {
    const cause = invitation.error;
    const otherAccount =
      cause instanceof ApiError && cause.code === "team.invitation_other_account";

    return (
      <Card>
        <Eyebrow />
        <h1 className="font-display text-[28px] font-bold leading-[1.2] text-ink">
          {otherAccount ? t("team.invite_other_account_title") : t("team.invite_not_found_title")}
        </h1>
        <p className="font-body text-[16px] text-ink/70">
          {otherAccount
            ? t("team.invite_other_account_body", {
                invited: (cause as ApiError).params.email ?? "",
                current: user?.email ?? "",
              })
            : errorMessage(cause)}
        </p>
        <div className="flex flex-wrap gap-3">
          {otherAccount && (
            <button
              type="button"
              onClick={() => {
                rememberReturnTo(`/invite/${invitationId}`);
                void signOut().then(() => navigate({ to: "/login" }));
              }}
              className="btn-ink px-[24px] py-[12px] font-body text-[15px]"
            >
              {t("team.invite_switch_account")}
            </button>
          )}
          <Link to="/dashboard" className="btn-outline px-[24px] py-[12px] font-body text-[15px]">
            {t("team.invite_to_dashboard")}
          </Link>
        </div>
      </Card>
    );
  }

  const details = invitation.data!;
  const who = details.invitedBy?.name || details.invitedBy?.email || t("team.someone");
  const expires = new Date(details.expiresAt).toLocaleDateString(
    i18n.language === "en" ? "en-GB" : "nb-NO",
    { day: "numeric", month: "long", year: "numeric" },
  );

  if (details.alreadyMember || details.status === "accepted") {
    return (
      <Card>
        <Eyebrow />
        <h1 className="font-display text-[28px] font-bold leading-[1.2] text-ink">
          {t("team.invite_already_member", { project: details.project.name })}
        </h1>
        <Link
          to="/projects/$projectId"
          params={{ projectId: details.project.id }}
          className="btn-ink w-fit px-[24px] py-[12px] font-body text-[15px]"
        >
          {t("team.invite_open_project")}
        </Link>
      </Card>
    );
  }

  if (declined || details.status === "declined" || details.status === "expired") {
    return (
      <Card>
        <Eyebrow />
        <h1 className="font-display text-[28px] font-bold leading-[1.2] text-ink">
          {details.status === "expired" && !declined
            ? t("team.invite_expired_title")
            : t("team.invite_declined_title")}
        </h1>
        <p className="font-body text-[16px] text-ink/70">
          {details.status === "expired" && !declined
            ? t("team.invite_expired_body", { who })
            : t("team.invite_declined_body", { who })}
        </p>
        <Link
          to="/dashboard"
          className="btn-outline w-fit px-[24px] py-[12px] font-body text-[15px]"
        >
          {t("team.invite_to_dashboard")}
        </Link>
      </Card>
    );
  }

  const busy = accept.isPending || decline.isPending;

  return (
    <Card>
      <Eyebrow />
      <h1 className="font-display text-[30px] font-bold leading-[1.2] text-ink">
        {t("team.invite_title", { who, project: details.project.name })}
      </h1>
      <p className="font-body text-[16px] text-ink/70">{t("team.invite_body")}</p>

      <ul className="flex flex-col gap-2 border-y border-hair py-4 font-body text-[15px] text-ink">
        <li>✓ {t("team.invite_can_deploy")}</li>
        <li>✓ {t("team.invite_can_configure")}</li>
        <li className="text-ink/60">– {t("team.invite_cannot")}</li>
      </ul>

      {error && (
        <p
          role="alert"
          className="border-2 border-error px-[16px] py-[12px] font-body text-[15px] text-error"
        >
          {error}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          disabled={busy}
          onClick={() => accept.mutate()}
          className="btn-ink px-[24px] py-[12px] font-body text-[15px] disabled:opacity-50"
        >
          {accept.isPending ? t("team.accepting") : t("team.invite_accept")}
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => decline.mutate()}
          className="btn-outline px-[24px] py-[12px] font-body text-[15px] disabled:opacity-50"
        >
          {t("team.decline")}
        </button>
      </div>

      <p className="font-body text-[13px] text-ink/60">
        {t("team.invite_expires", { date: expires })}
      </p>
    </Card>
  );
}
