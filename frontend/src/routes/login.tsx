import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState, type FormEvent } from "react";
import { SnoatLogo } from "@/components/SnoatLogo";
import { useAuth } from "@/lib/auth";
import { consumeReturnTo } from "@/lib/return-to";
import { useTranslation } from "react-i18next";
import { LanguageSwitcher } from "@/components/LanguageSwitcher";

export const Route = createFileRoute("/login")({
  head: () => ({
    meta: [
      { title: "Logg inn — Snoat" },
      { name: "description", content: "Logg inn på Snoat og deploy på norsk infrastruktur." },
    ],
  }),
  component: LoginPage,
});

type Mode = "signin" | "signup";

/**
 * GoTrue sender en stabil `code` på AuthApiError (f.eks. `user_already_exists`).
 * Vi matcher primært på den — `message` er fri tekst som endrer seg mellom versjoner.
 */
const ERROR_CODE_KEYS: Record<string, string> = {
  invalid_credentials: "login.error_credentials",
  email_not_confirmed: "login.error_email_unconfirmed",
  user_already_exists: "login.error_user_exists",
  email_exists: "login.error_user_exists",
  over_request_rate_limit: "login.error_rate_limit",
  over_email_send_rate_limit: "login.error_rate_limit",
};

/** Sant når GoTrue avviste registreringen fordi adressen er tatt. */
function isUserExistsError(cause: unknown): boolean {
  const code = (cause as { code?: string } | null)?.code;
  if (code === "user_already_exists" || code === "email_exists") return true;
  return cause instanceof Error && cause.message.includes("User already registered");
}

function getFriendlyErrorMessage(cause: unknown, t: (key: string) => string): string {
  console.error("Supabase auth error occurred:", cause);
  if (!(cause instanceof Error)) {
    return t("login.error_generic");
  }

  const code = (cause as { code?: string }).code;
  if (code && ERROR_CODE_KEYS[code]) {
    return t(ERROR_CODE_KEYS[code]);
  }

  const message = cause.message;

  if (
    message.includes("Failed to fetch") ||
    message.includes("fetch failed") ||
    message.includes("NetworkError")
  ) {
    return t("login.error_network");
  }
  if (message.includes("Invalid login credentials")) {
    return t("login.error_credentials");
  }
  if (message.includes("Email not confirmed")) {
    return t("login.error_email_unconfirmed");
  }
  if (
    message.includes("User already registered") ||
    message.includes("already been registered")
  ) {
    return t("login.error_user_exists");
  }
  if (
    message.includes("rate limit") ||
    message.includes("too many requests")
  ) {
    return t("login.error_rate_limit");
  }

  return t("login.error_generic");
}

function LoginPage() {
  const { user, loading, signInWithGitHub, signInWithPassword, signUpWithPassword } = useAuth();
  const navigate = useNavigate();
  const { t } = useTranslation();

  const [mode, setMode] = useState<Mode>("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [awaitingConfirmation, setAwaitingConfirmation] = useState(false);

  /**
   * Hvor vi skal etter innlogging.
   *
   * Normalt dashboardet, men en bruker som ble sendt hit fra samtykkesiden for en
   * AI-tilkobling skal tilbake til nettopp den forespørselen – ellers er
   * tilkoblingen hen prøvde å opprette borte. Se `lib/return-to.ts`.
   */
  const goToDestination = async () => {
    const returnTo = consumeReturnTo();
    await (returnTo ? navigate({ href: returnTo }) : navigate({ to: "/dashboard" }));
  };

  useEffect(() => {
    if (!loading && user) void goToDestination();
    // `goToDestination` leser bare fra sessionStorage, så den trenger ikke stå her.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, user, navigate]);

  // Automatically show password field if email is valid
  useEffect(() => {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (emailRegex.test(email)) {
      setShowPassword(true);
    } else {
      setShowPassword(false);
    }
  }, [email]);

  const executeAuthSubmit = async () => {
    if (mode === "signup" && password !== confirmPassword) {
      setError(t("login.error_passwords_dont_match"));
      return;
    }
    setError(null);
    setNotice(null);
    setPending(true);
    try {
      if (mode === "signin") {
        await signInWithPassword(email, password);
        await goToDestination();
      } else {
        const { needsEmailConfirmation } = await signUpWithPassword(email, password);
        if (needsEmailConfirmation) {
          setAwaitingConfirmation(true);
          return;
        }
        await goToDestination();
      }
    } catch (cause) {
      // Adressen er tatt: flytt brukeren over i innlogging med e-posten i behold
      // i stedet for å la dem stå fast i et skjema som aldri kan lykkes.
      if (mode === "signup" && isUserExistsError(cause)) {
        setMode("signin");
        setConfirmPassword("");
        setPassword("");
        setNotice(t("login.notice_account_exists"));
        return;
      }
      setError(getFriendlyErrorMessage(cause, t));
    } finally {
      setPending(false);
    }
  };

  const handleFormSubmit = (event: FormEvent) => {
    event.preventDefault();
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      setError(t("login.err_invalid_email"));
      return;
    }
    setError(null);
    if (!showPassword) {
      setShowPassword(true);
      return;
    }
    void executeAuthSubmit();
  };

  const handleGitHub = async () => {
    setError(null);
    setPending(true);
    try {
      await signInWithGitHub();
    } catch (cause) {
      setError(getFriendlyErrorMessage(cause, t));
      setPending(false);
    }
  };

  return (
    <div className="relative flex min-h-screen flex-col overflow-x-hidden">
      <div className="pointer-events-none absolute inset-0 z-[-1] flex items-start justify-center opacity-20">
        <div className="mt-[-200px] h-[700px] w-[700px] rounded-full bg-primary blur-[150px] mix-blend-screen" />
      </div>

      <header className="mx-auto w-full max-w-container-max flex items-center justify-between px-margin-mobile py-6 md:px-gutter">
        <Link to="/" className="inline-flex">
          <SnoatLogo />
        </Link>
        <LanguageSwitcher />
      </header>

      <main className="flex flex-grow items-center justify-center px-margin-mobile py-stack-lg">
        {awaitingConfirmation ? (
          <div className="floating-card w-full max-w-md p-8 md:p-10 text-center">
            <h1 className="mb-2 font-headline text-headline-lg text-on-surface">
              {t("login.confirm_sent_title")}
            </h1>
            <p className="mb-stack-md font-body text-body-md text-on-surface-variant">
              {t("login.confirm_sent_desc", { email })}
            </p>
            <button
              type="button"
              onClick={() => {
                setAwaitingConfirmation(false);
                setMode("signin");
                setPassword("");
                setConfirmPassword("");
              }}
              className="w-full font-label text-label-md text-on-surface-variant transition-colors hover:text-on-surface"
            >
              {t("login.back_to_signin")}
            </button>
          </div>
        ) : (
        <div className="floating-card w-full max-w-md p-8 md:p-10">
          <h1 className="mb-2 font-headline text-headline-lg text-on-surface text-center">
            {mode === "signin" ? t("login.title_signin") : t("login.title_signup")}
          </h1>
          <p className="mb-stack-md font-body text-body-md text-on-surface-variant text-center">
            {mode === "signin" ? t("login.desc_signin") : t("login.desc_signup")}
          </p>

          <form onSubmit={handleFormSubmit} className="flex flex-col gap-4">
            <label className="flex flex-col gap-2">
              <span className="font-label text-label-md text-on-surface-variant">{t("login.email_label")}</span>
              <input
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                required
                autoComplete="email"
                placeholder={t("login.email_placeholder")}
                className="rounded-xl bg-surface-container px-4 py-3 font-body text-body-md text-on-surface outline-none ring-primary/60 placeholder:text-on-surface-variant/40 focus:ring-2 transition-all"
              />
            </label>

            {/* Password input with smooth slide-down animation */}
            <div
              className={`transition-all duration-500 ease-in-out overflow-hidden px-1 -mx-1 ${
                showPassword
                  ? mode === "signup"
                    ? "max-h-[240px] opacity-100 mt-2 py-1 -my-1"
                    : "max-h-[130px] opacity-100 mt-2 py-1 -my-1"
                  : "max-h-0 opacity-0 pointer-events-none mt-0"
              }`}
            >
              <label className="flex flex-col gap-2">
                <span className="font-label text-label-md text-on-surface-variant">{t("login.password_label")}</span>
                <input
                  type="password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  required={showPassword}
                  minLength={6}
                  autoComplete={mode === "signin" ? "current-password" : "new-password"}
                  className="rounded-xl bg-surface-container px-4 py-3 font-body text-body-md text-on-surface outline-none ring-primary/60 focus:ring-2"
                />
              </label>

              {mode === "signup" && (
                <label className="flex flex-col gap-2 mt-4">
                  <span className="font-label text-label-md text-on-surface-variant">{t("login.confirm_password_label")}</span>
                  <input
                    type="password"
                    value={confirmPassword}
                    onChange={(event) => setConfirmPassword(event.target.value)}
                    required={showPassword && mode === "signup"}
                    minLength={6}
                    autoComplete="new-password"
                    className="rounded-xl bg-surface-container px-4 py-3 font-body text-body-md text-on-surface outline-none ring-primary/60 focus:ring-2"
                  />
                </label>
              )}
            </div>

            {mode === "signin" && showPassword && (
              <Link
                to="/forgot-password"
                search={{ email: email || undefined }}
                className="-mt-1 self-end font-label text-label-md text-on-surface-variant transition-colors hover:text-on-surface"
              >
                {t("login.forgot_password")}
              </Link>
            )}

            {notice && (
              <p role="status" className="font-body text-body-md text-on-surface text-center mt-2">
                {notice}
              </p>
            )}

            {error && (
              <p role="alert" className="font-body text-body-md text-error text-center mt-2">
                {error}
              </p>
            )}

            <button
              type="submit"
              disabled={pending}
              className="primary-btn mt-2 w-full py-3.5 font-label text-label-md disabled:opacity-50"
            >
              {pending
                ? t("login.loading")
                : showPassword
                ? mode === "signin"
                  ? t("login.btn_signin")
                  : t("login.btn_signup")
                : t("login.btn_continue_email")}
            </button>
          </form>

          <div className="my-6 flex items-center gap-4">
            <span className="h-px flex-grow bg-surface-variant/30" />
            <span className="font-label text-label-md text-on-surface-variant/50">{t("login.divider_or")}</span>
            <span className="h-px flex-grow bg-surface-variant/30" />
          </div>

          <div className="flex flex-col gap-3">
            {/* GitHub - ACTIVE */}
            <div className="relative w-full">
              <span className="absolute -top-2.5 right-4 z-10 bg-primary text-primary-foreground text-[9px] uppercase font-black tracking-widest px-2 py-0.5 rounded-sm shadow-md transform rotate-3 select-none pointer-events-none">
                {t("login.badge_last_used")}
              </span>
              <button
                type="button"
                onClick={handleGitHub}
                disabled={pending}
                className="flex w-full items-center justify-center gap-3 rounded-xl bg-surface-container/60 hover:bg-surface-container px-6 py-3.5 font-label text-label-md text-on-surface transition-all disabled:opacity-50"
              >
                <svg viewBox="0 0 16 16" aria-hidden="true" className="h-5 w-5" fill="currentColor">
                  <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
                </svg>
                {t("login.btn_github")}
              </button>
            </div>

            {/* Google - COMING SOON */}
            <button
              type="button"
              disabled
              className="flex w-full items-center justify-between rounded-xl bg-surface-container/20 border border-transparent px-6 py-3.5 font-label text-label-md text-on-surface-variant/40 cursor-not-allowed"
            >
              <div className="flex items-center gap-3">
                <svg className="h-5 w-5 fill-current opacity-40" viewBox="0 0 24 24">
                  <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" />
                  <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" />
                  <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l2.85-2.22.81-.63z" />
                  <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.52 6.16-4.52z" />
                </svg>
                {t("login.btn_google")}
              </div>
              <span className="text-[10px] font-medium bg-surface-variant/50 text-on-surface-variant/40 px-2 py-0.5 rounded">
                {t("login.badge_coming_soon")}
              </span>
            </button>

            {/* Apple - COMING SOON */}
            <button
              type="button"
              disabled
              className="flex w-full items-center justify-between rounded-xl bg-surface-container/20 border border-transparent px-6 py-3.5 font-label text-label-md text-on-surface-variant/40 cursor-not-allowed"
            >
              <div className="flex items-center gap-3">
                <svg className="h-5 w-5 fill-current opacity-40" viewBox="0 0 24 24">
                  <path d="M18.71 19.5c-.83 1.24-1.71 2.45-3.05 2.47-1.34.03-1.77-.79-3.29-.79-1.53 0-2 .77-3.27.82-1.31.05-2.3-1.32-3.14-2.53C4.25 17 2.94 12.45 4.7 9.39c.87-1.52 2.43-2.48 4.12-2.51 1.28-.02 2.5.87 3.29.87.78 0 2.26-1.07 3.81-.91.65.03 2.47.26 3.64 1.98-.09.06-2.17 1.28-2.15 3.81.03 3.02 2.65 4.03 2.68 4.04-.03.07-.42 1.44-1.38 2.83M15.97 4.17c.66-.81 1.11-1.93.99-3.06-1 .04-2.22.67-2.94 1.51-.64.73-1.2 1.87-1.05 2.97 1.12.09 2.27-.58 3-1.42Z" />
                </svg>
                {t("login.btn_apple")}
              </div>
              <span className="text-[10px] font-medium bg-surface-variant/50 text-on-surface-variant/40 px-2 py-0.5 rounded">
                {t("login.badge_coming_soon")}
              </span>
            </button>

            {/* Passkey - COMING SOON */}
            <button
              type="button"
              disabled
              className="flex w-full items-center justify-between rounded-xl bg-surface-container/20 border border-transparent px-6 py-3.5 font-label text-label-md text-on-surface-variant/40 cursor-not-allowed"
            >
              <div className="flex items-center gap-3">
                <svg className="h-5 w-5 stroke-current opacity-40" viewBox="0 0 24 24" fill="none" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="7.5" cy="15.5" r="5.5" />
                  <path d="m21 2-9.6 9.6" />
                  <path d="m15.5 7.5 3 3" />
                  <path d="M17.5 5.5 20 8" />
                </svg>
                {t("login.btn_passkey")}
              </div>
              <span className="text-[10px] font-medium bg-surface-variant/50 text-on-surface-variant/40 px-2 py-0.5 rounded">
                {t("login.badge_coming_soon")}
              </span>
            </button>
          </div>

          <button
            type="button"
            onClick={() => {
              setMode(mode === "signin" ? "signup" : "signin");
              setError(null);
              setNotice(null);
              setConfirmPassword("");
            }}
            className="mt-6 w-full font-label text-label-md text-on-surface-variant transition-colors hover:text-on-surface text-center"
          >
            {mode === "signin" ? t("login.toggle_signup") : t("login.toggle_signin")}
          </button>

          <p className="mt-8 text-center font-body text-body-md text-on-surface-variant/60">
            {t("login.data_safety")}
          </p>
        </div>
        )}
      </main>
    </div>
  );
}
