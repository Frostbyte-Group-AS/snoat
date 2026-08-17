import { Link, useNavigate } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { SnoatLogo } from "@/components/SnoatLogo";
import { LanguageSwitcher } from "@/components/LanguageSwitcher";
import { avatarUrl, displayName, useAuth } from "@/lib/auth";

export function DashboardNav() {
  const { t } = useTranslation();
  const { user, signOut } = useAuth();
  const navigate = useNavigate();

  const name = displayName(user);
  const avatar = avatarUrl(user);

  const handleSignOut = async () => {
    await signOut();
    await navigate({ to: "/" });
  };

  return (
    <header className="sticky top-0 z-50 bg-background/70 shadow-[0_8px_30px_-20px_oklch(0_0_0/0.9)] backdrop-blur-xl">
      <div className="mx-auto flex max-w-container-max items-center justify-between gap-4 px-margin-mobile py-4 md:px-gutter">
        <div className="flex items-center gap-6">
          <Link to="/dashboard" className="inline-flex">
            <SnoatLogo />
          </Link>
          <span className="hidden font-label text-label-md text-on-surface-variant sm:inline">
            {t("dashboard.title")}
          </span>
        </div>

        <div className="flex items-center gap-4">
          <Link
            to="/settings/mcp"
            className="hidden font-label text-label-md text-on-surface-variant transition-colors hover:text-on-surface sm:inline"
            activeProps={{ className: "text-primary" }}
          >
            {t("nav.mcp")}
          </Link>

          <Link
            to="/settings/billing"
            className="hidden font-label text-label-md text-on-surface-variant transition-colors hover:text-on-surface sm:inline"
            activeProps={{ className: "text-primary" }}
          >
            {t("billing.title")}
          </Link>

          <LanguageSwitcher />

          <div className="flex items-center gap-2.5">
            {avatar ? (
              <img
                src={avatar}
                alt=""
                className="h-8 w-8 rounded-full bg-surface-variant object-cover"
              />
            ) : (
              <span className="flex h-8 w-8 items-center justify-center rounded-full bg-surface-variant font-label text-label-md text-on-surface-variant">
                {name.slice(0, 1).toUpperCase()}
              </span>
            )}
            <span className="hidden font-label text-label-md text-on-surface md:inline">
              {name}
            </span>
          </div>

          <button
            type="button"
            onClick={() => void handleSignOut()}
            className="ghost-btn px-4 py-2.5 font-label text-label-md"
          >
            {t("dashboard.logout")}
          </button>
        </div>
      </div>
    </header>
  );
}
