import { useMutation } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { SnoatLogo } from "@/components/SnoatLogo";
import { approveOauthRequest, denyOauthRequest } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { displayName } from "@/lib/auth";
import { rememberReturnTo } from "@/lib/return-to";

/**
 * Samtykkesiden for MCP-connectoren.
 *
 * Hit sendes brukeren av backend når en MCP-klient ber om tilgang til kontoen.
 * Dette er stedet i hele flyten der et menneske faktisk tar en beslutning, og
 * derfor det eneste stedet tilgangen kan oppstå.
 *
 * Siden er bevisst naken: ingen navigasjon, ingenting å klikke på ved siden av.
 * En samtykkeside der «Godkjenn» konkurrerer med en meny er en samtykkeside folk
 * klikker seg gjennom uten å lese.
 */
export const Route = createFileRoute("/oauth/consent")({
  head: () => ({
    meta: [{ title: "Koble til Snoat" }, { name: "robots", content: "noindex" }],
  }),
  validateSearch: (search: Record<string, unknown>): { request?: string } => ({
    request: typeof search.request === "string" ? search.request : undefined,
  }),
  component: ConsentPage,
});

/** Rettighetene tokenet gir. Formulert som handlinger, ikke som API-navn. */
const PERMISSION_KEYS = [
  "mcp.consent_permission_read",
  "mcp.consent_permission_deploy",
  "mcp.consent_permission_config",
  "mcp.consent_permission_logs",
] as const;

function ConsentPage() {
  const { t } = useTranslation();
  const { request } = Route.useSearch();
  const { user, loading } = useAuth();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);

  /**
   * Omdirigeringen gjøres med `window.location` og ikke med ruteren: målet ligger
   * hos klienten (f.eks. `claude.ai`), utenfor denne applikasjonen.
   */
  const approve = useMutation({
    mutationFn: () => approveOauthRequest(request ?? ""),
    onSuccess: ({ redirect_to }) => {
      window.location.href = redirect_to;
    },
    onError: (cause: Error) => setError(cause.message),
  });

  const deny = useMutation({
    mutationFn: () => denyOauthRequest(request ?? ""),
    // Feiler avslaget, har vi ingenting å sende brukeren til. Da er dashboardet
    // riktigere enn en feilmelding: ingen tilgang ble gitt, som var poenget.
    onSuccess: ({ redirect_to }) => {
      window.location.href = redirect_to;
    },
    onError: () => void navigate({ to: "/dashboard" }),
  });

  const busy = approve.isPending || deny.isPending;

  if (!request) {
    return (
      <ConsentShell>
        <h1 className="font-display text-headline-md text-on-background">
          {t("mcp.consent_invalid_title")}
        </h1>
        <p className="font-body text-body-md text-on-surface-variant">
          {t("mcp.consent_invalid_body")}
        </p>
      </ConsentShell>
    );
  }

  if (loading) {
    return (
      <ConsentShell>
        <p className="font-body text-body-md text-on-surface-variant">{t("mcp.consent_loading")}</p>
      </ConsentShell>
    );
  }

  /**
   * Uinnlogget: vi ber om innlogging her i stedet for å omdirigere automatisk.
   *
   * Brukeren kom hit fra en annen applikasjon, og skal få se hva hen er kommet
   * til før hen blir bedt om passordet sitt. En innloggingsside som dukker opp av
   * seg selv etter en omdirigering fra en tredjepart er nøyaktig formen en
   * phishing-side har.
   */
  if (!user) {
    return (
      <ConsentShell>
        <h1 className="font-display text-headline-md text-on-background">
          {t("mcp.consent_login_title")}
        </h1>
        <p className="font-body text-body-md text-on-surface-variant">
          {t("mcp.consent_login_body")}
        </p>
        <button
          type="button"
          onClick={() => {
            rememberReturnTo(`${window.location.pathname}${window.location.search}`);
            void navigate({ to: "/login" });
          }}
          className="primary-btn w-full px-6 py-3.5 font-label text-label-lg"
        >
          {t("mcp.consent_login_action")}
        </button>
      </ConsentShell>
    );
  }

  return (
    <ConsentShell>
      <div className="flex flex-col gap-2">
        <span className="font-label text-label-sm text-primary">{t("mcp.consent_eyebrow")}</span>
        <h1 className="font-display text-headline-md text-on-background">
          {t("mcp.consent_title")}
        </h1>
        <p className="font-body text-body-md text-on-surface-variant">
          {t("mcp.consent_body", { account: displayName(user) })}
        </p>
      </div>

      <ul className="flex flex-col gap-3 rounded-2xl bg-surface-container p-5">
        {PERMISSION_KEYS.map((key) => (
          <li key={key} className="flex items-start gap-3">
            <span className="material-symbols-outlined icon-sm mt-0.5 text-primary">check</span>
            <span className="font-body text-body-md text-on-surface">{t(key)}</span>
          </li>
        ))}
      </ul>

      <p className="font-body text-body-sm text-on-surface-variant">
        {t("mcp.consent_revoke_hint")}
      </p>

      {error && (
        <p role="alert" className="font-body text-body-sm text-error">
          {error}
        </p>
      )}

      <div className="flex flex-col gap-3 sm:flex-row-reverse">
        <button
          type="button"
          onClick={() => approve.mutate()}
          disabled={busy}
          className="primary-btn flex-1 px-6 py-3.5 font-label text-label-lg disabled:opacity-60"
        >
          {approve.isPending ? t("mcp.consent_approving") : t("mcp.consent_approve")}
        </button>
        <button
          type="button"
          onClick={() => deny.mutate()}
          disabled={busy}
          className="ghost-btn flex-1 px-6 py-3.5 font-label text-label-lg disabled:opacity-60"
        >
          {t("mcp.consent_deny")}
        </button>
      </div>
    </ConsentShell>
  );
}

function ConsentShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-8 px-margin-mobile py-12">
      <SnoatLogo />
      <div className="floating-card flex w-full max-w-lg flex-col gap-6 p-8">{children}</div>
    </div>
  );
}
