import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState, type FormEvent } from "react";
import { SnoatLogo } from "@/components/SnoatLogo";
import { useAuth } from "@/lib/auth";
import { consumeReturnTo } from "@/lib/return-to";
import { useTranslation } from "react-i18next";
import { LanguageSwitcher } from "@/components/LanguageSwitcher";

export const Route = createFileRoute("/login")({
  /**
   * `?email=` lar CTA-feltet nederst på landingssiden bære adressen hit, slik
   * at brukeren ikke må skrive den to ganger. Ugyldig input ignoreres framfor
   * å kaste – en rar query-parameter skal ikke gi 404 på innloggingssiden.
   */
  validateSearch: (search: Record<string, unknown>): { email?: string } => {
    const email = typeof search.email === "string" ? search.email.trim() : "";
    return email ? { email } : {};
  },
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
  if (message.includes("User already registered") || message.includes("already been registered")) {
    return t("login.error_user_exists");
  }
  if (message.includes("rate limit") || message.includes("too many requests")) {
    return t("login.error_rate_limit");
  }

  return t("login.error_generic");
}

function LoginPage() {
  const { user, loading, signInWithGitHub, signInWithPassword, signUpWithPassword } = useAuth();
  const navigate = useNavigate();
  const { t } = useTranslation();

  const { email: emailFromSearch } = Route.useSearch();

  const [mode, setMode] = useState<Mode>("signin");
  const [email, setEmail] = useState(emailFromSearch ?? "");
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
    <div className="flex min-h-screen flex-col bg-paper">
      <header className="mx-auto flex w-full max-w-[1334px] items-center justify-between px-5 py-6 lg:px-0 lg:pt-[48px]">
        <Link to="/" className="inline-flex text-ink" aria-label="Snoat">
          <SnoatLogo size={36} />
        </Link>
        <LanguageSwitcher />
      </header>

      <main className="flex flex-grow items-center justify-center px-5 py-12">
        {awaitingConfirmation ? (
          <div className="ink-card-lg w-full max-w-[520px] px-[30px] py-[32px] text-center">
            <h1 className="font-display text-[32px] font-bold leading-[1.15] text-ink">
              {t("login.confirm_sent_title")}
            </h1>
            <span className="swoosh mx-auto mt-[6px]" aria-hidden="true" />
            <p className="mt-[18px] font-body text-[17px] font-light leading-[1.55] text-ink">
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
              className="btn-outline mt-[24px] h-[52px] w-full font-display text-[16px]"
            >
              {t("login.back_to_signin")}
            </button>
          </div>
        ) : (
          <div className="ink-card-lg w-full max-w-[520px] px-[30px] py-[32px]">
            <h1 className="text-center font-display text-[32px] font-bold leading-[1.15] text-ink">
              {mode === "signin" ? t("login.title_signin") : t("login.title_signup")}
            </h1>
            <span className="swoosh mx-auto mt-[6px]" aria-hidden="true" />
            <p className="mt-[14px] text-center font-body text-[17px] font-light leading-[1.5] text-ink">
              {mode === "signin" ? t("login.desc_signin") : t("login.desc_signup")}
            </p>

            <form onSubmit={handleFormSubmit} className="mt-[26px] flex flex-col gap-[16px]">
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

              {/* Passordfeltet glir ned først når e-posten ser gyldig ut. */}
              <div
                className={`-mx-1 overflow-hidden px-1 transition-all duration-500 ease-in-out ${
                  showPassword
                    ? mode === "signup"
                      ? "-my-1 max-h-[280px] py-1 opacity-100"
                      : "-my-1 max-h-[160px] py-1 opacity-100"
                    : "pointer-events-none max-h-0 opacity-0"
                }`}
              >
                <label className="flex flex-col gap-[8px]">
                  <span className="font-body text-[15px] font-normal text-ink">
                    {t("login.password_label")}
                  </span>
                  <input
                    type="password"
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    required={showPassword}
                    minLength={6}
                    autoComplete={mode === "signin" ? "current-password" : "new-password"}
                    className="field-ink h-[52px] px-[16px] font-body text-[17px] font-normal outline-none"
                  />
                </label>

                {mode === "signup" && (
                  <label className="mt-[16px] flex flex-col gap-[8px]">
                    <span className="font-body text-[15px] font-normal text-ink">
                      {t("login.confirm_password_label")}
                    </span>
                    <input
                      type="password"
                      value={confirmPassword}
                      onChange={(event) => setConfirmPassword(event.target.value)}
                      required={showPassword && mode === "signup"}
                      minLength={6}
                      autoComplete="new-password"
                      className="field-ink h-[52px] px-[16px] font-body text-[17px] font-normal outline-none"
                    />
                  </label>
                )}
              </div>

              {mode === "signin" && showPassword && (
                <Link
                  to="/forgot-password"
                  search={{ email: email || undefined }}
                  className="self-end font-body text-[15px] font-normal text-ink underline-offset-[4px] hover:underline"
                >
                  {t("login.forgot_password")}
                </Link>
              )}

              {notice && (
                <p
                  role="status"
                  className="bg-sun px-[14px] py-[10px] text-center font-body text-[15px] font-normal text-ink"
                >
                  {notice}
                </p>
              )}

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
                {pending
                  ? t("login.loading")
                  : showPassword
                    ? mode === "signin"
                      ? t("login.btn_signin")
                      : t("login.btn_signup")
                    : t("login.btn_continue_email")}
              </button>
            </form>

            <div className="my-[24px] flex items-center gap-[14px]">
              <span className="h-px flex-grow bg-hair" />
              <span className="font-body text-[15px] font-light text-ink">
                {t("login.divider_or")}
              </span>
              <span className="h-px flex-grow bg-hair" />
            </div>

            <div className="flex flex-col gap-[12px]">
              <div className="relative">
                <span className="absolute -top-[11px] right-[14px] z-10 select-none bg-sun px-[8px] py-[2px] font-body text-[11px] font-bold uppercase tracking-[0.12em] text-ink">
                  {t("login.badge_last_used")}
                </span>
                <button
                  type="button"
                  onClick={handleGitHub}
                  disabled={pending}
                  className="btn-outline h-[52px] w-full font-display text-[16px]"
                >
                  {t("login.btn_github")}
                </button>
              </div>

              {/* Leverandører som ennå ikke er koblet på. De står synlige med
                  vilje – da vet brukeren at de kommer, og velger e-post nå. */}
              {(["btn_google", "btn_apple", "btn_passkey"] as const).map((key) => (
                <button
                  key={key}
                  type="button"
                  disabled
                  className="flex h-[52px] w-full items-center justify-between border-2 border-hair px-[16px] font-body text-[16px] font-normal text-ink/40"
                >
                  <span>{t(`login.${key}`)}</span>
                  <span className="font-body text-[11px] uppercase tracking-[0.12em]">
                    {t("login.badge_coming_soon")}
                  </span>
                </button>
              ))}
            </div>

            <button
              type="button"
              onClick={() => {
                setMode(mode === "signin" ? "signup" : "signin");
                setError(null);
                setNotice(null);
                setConfirmPassword("");
              }}
              className="mt-[24px] w-full text-center font-body text-[15px] font-normal text-ink underline-offset-[4px] hover:underline"
            >
              {mode === "signin" ? t("login.toggle_signup") : t("login.toggle_signin")}
            </button>

            <p className="mt-[24px] text-center font-body text-[15px] font-light text-ink/70">
              {t("login.data_safety")}
            </p>
          </div>
        )}
      </main>
    </div>
  );
}
