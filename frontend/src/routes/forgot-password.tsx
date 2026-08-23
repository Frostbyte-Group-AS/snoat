import { createFileRoute, Link } from "@tanstack/react-router";
import { useState, type FormEvent } from "react";
import { SnoatLogo } from "@/components/SnoatLogo";
import { useAuth } from "@/lib/auth";
import { useTranslation } from "react-i18next";
import { LanguageSwitcher } from "@/components/LanguageSwitcher";

export const Route = createFileRoute("/forgot-password")({
  validateSearch: (search: Record<string, unknown>): { email?: string } => ({
    email: typeof search.email === "string" ? search.email : undefined,
  }),
  head: () => ({
    meta: [
      { title: "Glemt passord — Snoat" },
      { name: "description", content: "Få tilsendt en lenke for å sette nytt passord." },
    ],
  }),
  component: ForgotPasswordPage,
});

function ForgotPasswordPage() {
  const { requestPasswordReset } = useAuth();
  const { email: prefill } = Route.useSearch();
  const { t } = useTranslation();

  const [email, setEmail] = useState(prefill ?? "");
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      setError(t("login.err_invalid_email"));
      return;
    }

    setError(null);
    setPending(true);
    try {
      await requestPasswordReset(email);
      setSent(true);
    } catch (cause) {
      console.error("Password reset request failed:", cause);
      const code = (cause as { code?: string } | null)?.code;
      if (code === "over_email_send_rate_limit" || code === "over_request_rate_limit") {
        setError(t("login.error_rate_limit"));
      } else if (cause instanceof Error && cause.message.includes("Failed to fetch")) {
        setError(t("login.error_network"));
      } else {
        // Alt annet svelges med vilje: å skille «finnes ikke» fra «feilet» her
        // ville gjort skjemaet til et oppslagsverk over registrerte adresser.
        setSent(true);
      }
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="flex min-h-screen flex-col bg-paper">
      <header className="mx-auto flex w-full max-w-[1334px] items-center justify-between px-5 py-6 lg:px-0 lg:pt-[48px]">
        <Link to="/" className="inline-flex text-ink" aria-label="Snoat">
          <SnoatLogo size={36} />
        </Link>
        <LanguageSwitcher />
      </header>

      <main className="flex flex-grow items-center justify-center px-5 py-12">
        <div className="ink-card-lg w-full max-w-[520px] px-[30px] py-[32px]">
          <h1 className="text-center font-display text-[32px] font-bold leading-[1.15] text-ink">
            {t("forgot.title")}
          </h1>
          <span className="swoosh mx-auto mt-[6px]" aria-hidden="true" />

          {sent ? (
            <>
              <p className="mt-[16px] text-center font-body text-[17px] font-light leading-[1.5] text-ink">
                {t("forgot.sent_desc", { email })}
              </p>
              <Link
                to="/login"
                className="btn-outline mt-[24px] h-[52px] w-full font-display text-[16px]"
              >
                {t("login.back_to_signin")}
              </Link>
            </>
          ) : (
            <>
              <p className="mt-[16px] text-center font-body text-[17px] font-light leading-[1.5] text-ink">
                {t("forgot.desc")}
              </p>

              <form onSubmit={handleSubmit} className="mt-[26px] flex flex-col gap-[16px]">
                <label className="flex flex-col gap-[8px]">
                  <span className="font-body text-[15px] font-normal text-ink">
                    {t("login.email_label")}
                  </span>
                  <input
                    type="email"
                    value={email}
                    onChange={(event) => setEmail(event.target.value)}
                    required
                    autoComplete="email"
                    placeholder={t("login.email_placeholder")}
                    className="field-ink h-[52px] px-[16px] font-body text-[17px] font-normal outline-none placeholder:text-ink/40"
                  />
                </label>

                {error && (
                  <p
                    role="alert"
                    className="border-2 border-error px-[14px] py-[10px] text-center font-body text-[15px] font-normal text-error"
                  >
                    {error}
                  </p>
                )}

                <button
                  type="submit"
                  disabled={pending}
                  className="btn-ink mt-[4px] h-[52px] w-full font-display text-[17px]"
                >
                  {pending ? t("login.loading") : t("forgot.btn_send")}
                </button>
              </form>

              <Link
                to="/login"
                className="mt-[24px] block w-full text-center font-body text-[15px] font-normal text-ink underline-offset-[4px] hover:underline"
              >
                {t("login.back_to_signin")}
              </Link>
            </>
          )}
        </div>
      </main>
    </div>
  );
}
