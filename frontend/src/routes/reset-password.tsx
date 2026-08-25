import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState, type FormEvent } from "react";
import { SnoatLogo } from "@/components/SnoatLogo";
import { useAuth } from "@/lib/auth";
import { useTranslation } from "react-i18next";
import { LanguageSwitcher } from "@/components/LanguageSwitcher";

export const Route = createFileRoute("/reset-password")({
  head: () => ({
    meta: [{ title: "Nytt passord — Snoat" }, { name: "robots", content: "noindex" }],
  }),
  component: ResetPasswordPage,
});

/**
 * Landingspunkt for gjenopprettingslenken.
 *
 * GoTrue sender brukeren hit med en engangskode i URL-en. supabase-js bytter
 * den inn i en midlertidig sesjon (`detectSessionInUrl`), og det er den
 * sesjonen som gir rett til å sette nytt passord. Uten sesjon er lenken
 * utløpt eller allerede brukt.
 */
function ResetPasswordPage() {
  const { user, loading, updatePassword } = useAuth();
  const navigate = useNavigate();
  const { t } = useTranslation();

  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [linkError, setLinkError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  /**
   * Sant mens supabase-js bytter engangskoden i URL-en mot en sesjon. Uten
   * denne rekker `loading` å bli false før sesjonen er på plass, og vi ville
   * blinket «lenken virker ikke» til en helt gyldig lenke.
   */
  const [exchangingCode, setExchangingCode] = useState(false);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const hash = new URLSearchParams(window.location.hash.slice(1));
    const description = params.get("error_description") ?? hash.get("error_description");
    if (description) {
      setLinkError(description);
      return;
    }

    const hasCode = params.has("code") || hash.has("access_token");
    if (!hasCode) return;

    setExchangingCode(true);
    // Nødbrems: kommer sesjonen aldri, skal siden lande på «ugyldig lenke»
    // i stedet for å spinne i det uendelige.
    const timer = window.setTimeout(() => setExchangingCode(false), 5000);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (user) setExchangingCode(false);
  }, [user]);

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (password !== confirmPassword) {
      setError(t("login.error_passwords_dont_match"));
      return;
    }

    setError(null);
    setPending(true);
    try {
      await updatePassword(password);
      await navigate({ to: "/dashboard" });
    } catch (cause) {
      console.error("Password update failed:", cause);
      const code = (cause as { code?: string } | null)?.code;
      if (code === "weak_password") {
        setError(t("reset.error_weak_password"));
      } else if (code === "same_password") {
        setError(t("reset.error_same_password"));
      } else {
        setError(t("login.error_generic"));
      }
    } finally {
      setPending(false);
    }
  };

  const settling = (loading || exchangingCode) && linkError === null;
  const invalidLink = linkError !== null || (!settling && !user);

  return (
    <div className="flex min-h-screen flex-col bg-paper">
      <header className="mx-auto flex w-full max-w-[1334px] items-center justify-between px-5 py-6 lg:px-0 lg:pt-[48px]">
        <Link to="/" className="inline-flex text-ink" aria-label="Snoat">
          <SnoatLogo size={36} />
        </Link>
        <LanguageSwitcher />
      </header>

      <main className="flex flex-grow items-center justify-center px-5 py-12">
        <div className="ink-card-lg anim-pop w-full max-w-[520px] px-[30px] py-[32px]">
          {settling ? (
            <p className="text-center font-body text-[17px] font-light text-ink/70">
              {t("login.loading")}
            </p>
          ) : invalidLink ? (
            <>
              <h1 className="text-center font-display text-[32px] font-bold leading-[1.15] text-ink">
                {t("reset.invalid_title")}
              </h1>
              <span className="swoosh mx-auto mt-[6px]" aria-hidden="true" />
              <p className="mt-[16px] text-center font-body text-[17px] font-light leading-[1.5] text-ink">
                {t("reset.invalid_desc")}
              </p>
              <Link
                to="/forgot-password"
                className="btn-ink mt-[24px] h-[52px] w-full font-display text-[16px]"
              >
                {t("reset.btn_request_new")}
              </Link>
            </>
          ) : (
            <>
              <h1 className="text-center font-display text-[32px] font-bold leading-[1.15] text-ink">
                {t("reset.title")}
              </h1>
              <span className="swoosh mx-auto mt-[6px]" aria-hidden="true" />
              <p className="mt-[16px] text-center font-body text-[17px] font-light leading-[1.5] text-ink">
                {t("reset.desc", { email: user?.email ?? "" })}
              </p>

              <form onSubmit={handleSubmit} className="mt-[26px] flex flex-col gap-[16px]">
                <label className="flex flex-col gap-[8px]">
                  <span className="font-body text-[15px] font-normal text-ink">
                    {t("reset.new_password_label")}
                  </span>
                  <input
                    type="password"
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    required
                    minLength={8}
                    autoComplete="new-password"
                    className="field-ink h-[52px] px-[16px] font-body text-[17px] font-normal outline-none"
                  />
                </label>

                <label className="flex flex-col gap-[8px]">
                  <span className="font-body text-[15px] font-normal text-ink">
                    {t("login.confirm_password_label")}
                  </span>
                  <input
                    type="password"
                    value={confirmPassword}
                    onChange={(event) => setConfirmPassword(event.target.value)}
                    required
                    minLength={8}
                    autoComplete="new-password"
                    className="field-ink h-[52px] px-[16px] font-body text-[17px] font-normal outline-none"
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
                  {pending ? t("login.loading") : t("reset.btn_save")}
                </button>
              </form>
            </>
          )}
        </div>
      </main>
    </div>
  );
}
