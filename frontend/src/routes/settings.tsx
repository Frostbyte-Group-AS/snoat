import { createFileRoute, Link, Outlet, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";

import { DashboardNav } from "@/components/DashboardNav";
import { useAuth } from "@/lib/auth";

/**
 * Rammen rundt kontoinnstillingene.
 *
 * Alt under `/settings` gjelder **kontoen**, ikke ett prosjekt – og det er
 * grunnen til at siden finnes. AI-tilkoblingen lå tidligere som en fane inne i
 * hvert prosjekt, noe som ga inntrykk av at Claude bare fikk se det ene
 * prosjektet, og den identiske fanen sto dessuten under alle sammen.
 *
 * Innlogging sjekkes her, én gang, i stedet for i hver enkelt underside.
 */
export const Route = createFileRoute("/settings")({
  component: SettingsLayout,
});

function SettingsLayout() {
  const { user, loading } = useAuth();
  const navigate = useNavigate();
  const { t } = useTranslation();

  useEffect(() => {
    if (!loading && !user) void navigate({ to: "/login" });
  }, [loading, user, navigate]);

  const tabClass =
    "block border-2 border-line px-[16px] py-[11px] font-body text-[15px] text-ink transition-colors hover:bg-sun";
  const activeTabClass = "bg-ink font-bold text-paper hover:bg-ink";

  if (loading || !user) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-paper">
        <p className="font-body text-[17px] font-light text-ink/70">{t("login.loading")}</p>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen flex-col bg-paper">
      <DashboardNav />

      <main className="mx-auto w-full max-w-[1334px] flex-grow px-5 py-[48px] lg:px-0">
        <div className="mb-[36px]">
          <h1 className="anim-rise font-display text-[36px] font-bold leading-[1.15] text-ink lg:text-[45px]">
            {t("account.settings_title")}
          </h1>
          <span className="swoosh anim-draw mt-[8px]" aria-hidden="true" />
        </div>

        <div className="flex flex-col gap-[31px] lg:flex-row">
          {/* Sidemenyen er en liste med lenker, ikke faner: hver side har sin
              egen URL, slik at den kan bokmerkes og lenkes til fra e-post. */}
          <nav className="stagger flex shrink-0 flex-col gap-[10px] lg:w-[240px]">
            <Link
              to="/settings/mcp"
              className={tabClass}
              activeProps={{ className: activeTabClass }}
            >
              {t("account.connector")}
            </Link>
            <Link
              to="/settings/billing"
              className={tabClass}
              activeProps={{ className: activeTabClass }}
            >
              {t("billing.title")}
            </Link>
          </nav>

          <div className="min-w-0 flex-1">
            <Outlet />
          </div>
        </div>
      </main>
    </div>
  );
}
