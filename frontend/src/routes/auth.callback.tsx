import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { SnoatLogo } from "@/components/SnoatLogo";
import { useAuth } from "@/lib/auth";
import { consumeReturnTo } from "@/lib/return-to";

export const Route = createFileRoute("/auth/callback")({
  component: AuthCallback,
});

/**
 * Landingspunkt etter GitHub OAuth.
 *
 * supabase-js oppdager `?code=` i URL-en selv og bytter den inn i en sesjon
 * (PKCE). Vi venter bare på at auth-tilstanden settes, og sender brukeren
 * videre. Feilmeldinger fra GoTrue kommer som query-parametre.
 */
function AuthCallback() {
  const { user, loading } = useAuth();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const hash = new URLSearchParams(window.location.hash.slice(1));
    const description = params.get("error_description") ?? hash.get("error_description");

    if (description) {
      setError(description);
      return;
    }

    if (!loading && user) {
      // Kom brukeren fra samtykkesiden for en AI-tilkobling, skal hen tilbake
      // dit – ikke til dashboardet, der forespørselen er glemt.
      const returnTo = consumeReturnTo();
      void (returnTo ? navigate({ href: returnTo }) : navigate({ to: "/dashboard" }));
    }
  }, [loading, user, navigate]);

  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-8 bg-paper px-5">
      <SnoatLogo size={36} className="text-ink" />
      {error ? (
        <div className="ink-card-lg max-w-[520px] px-[30px] py-[32px] text-center">
          <h1 className="font-display text-[28px] font-bold leading-[1.15] text-ink">
            Innloggingen ble avbrutt
          </h1>
          <span className="swoosh mx-auto mt-[6px]" aria-hidden="true" />
          <p className="mt-[16px] font-body text-[17px] font-light leading-[1.5] text-ink">
            {error}
          </p>
          <button
            type="button"
            onClick={() => void navigate({ to: "/login" })}
            className="btn-ink mt-[24px] h-[52px] w-full font-display text-[16px]"
          >
            Prøv igjen
          </button>
        </div>
      ) : (
        <p className="font-body text-[17px] font-light text-ink/70">Logger deg inn…</p>
      )}
    </div>
  );
}
