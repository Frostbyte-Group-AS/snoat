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
    <div className="flex min-h-screen flex-col items-center justify-center gap-6 px-margin-mobile">
      <SnoatLogo />
      {error ? (
        <div className="floating-card max-w-md p-8 text-center">
          <h1 className="mb-2 font-headline text-headline-md text-on-surface">
            Innloggingen ble avbrutt
          </h1>
          <p className="mb-6 font-body text-body-md text-on-surface-variant">{error}</p>
          <button
            type="button"
            onClick={() => void navigate({ to: "/login" })}
            className="primary-btn px-6 py-3 font-label text-label-md"
          >
            Prøv igjen
          </button>
        </div>
      ) : (
        <p className="font-body text-body-md text-on-surface-variant">Logger deg inn…</p>
      )}
    </div>
  );
}
