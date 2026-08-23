import { Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { avatarUrl, displayName, useAuth } from "@/lib/auth";

/**
 * Profilmenyen bak avataren – kontoens egne innstillinger.
 *
 * Tidligere lå «AI-tilkobling» og «Fakturering» som to løse lenker i toppraden,
 * ved siden av dashboardets egen navigasjon. Det blandet to nivåer: den ene
 * raden pekte både på *innholdet* (prosjektene) og på *kontoen* (abonnement,
 * tilkoblinger). Nå ligger alt som gjelder kontoen bak avataren, som er der
 * folk leter etter det.
 *
 * Ingen chevron: designet har ingen ikoner, så åpen tilstand vises ved at
 * avataren inverteres til svart flate.
 */
export function UserMenu() {
  const { t } = useTranslation();
  const { user, signOut } = useAuth();
  const navigate = useNavigate();

  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);

  const name = displayName(user);
  const avatar = avatarUrl(user);
  const initial = name.slice(0, 1).toUpperCase() || "?";

  // Klikk utenfor og Escape lukker. Uten begge blir en åpen meny stående igjen
  // over innholdet, og på mobil er den da umulig å bli kvitt.
  useEffect(() => {
    if (!open) return;

    const onPointerDown = (event: MouseEvent | TouchEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };

    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("touchstart", onPointerDown);
    document.addEventListener("keydown", onKeyDown);

    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("touchstart", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const handleSignOut = async () => {
    setOpen(false);
    await signOut();
    await navigate({ to: "/" });
  };

  const itemClass =
    "block w-full px-[16px] py-[11px] text-left font-body text-[15px] text-ink transition-colors hover:bg-sun";

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t("account.menu_label")}
        className="flex items-center gap-[10px]"
      >
        {avatar ? (
          <img
            src={avatar}
            alt=""
            className={`h-9 w-9 border-2 object-cover transition-colors ${
              open ? "border-ink" : "border-hair hover:border-ink"
            }`}
          />
        ) : (
          <span
            aria-hidden="true"
            className={`flex h-9 w-9 items-center justify-center border-2 border-ink font-body text-[15px] font-bold transition-colors ${
              open ? "bg-ink text-paper" : "bg-paper text-ink hover:bg-sun"
            }`}
          >
            {initial}
          </span>
        )}
        <span className="hidden max-w-[160px] truncate font-body text-[15px] text-ink md:inline">
          {name}
        </span>
      </button>

      {open && (
        <div
          role="menu"
          className="absolute right-0 top-full z-50 mt-[10px] w-[262px] border-2 border-ink bg-paper"
        >
          <div className="px-[16px] py-[14px]">
            <p className="truncate font-body text-[15px] font-bold text-ink">{name}</p>
            {user?.email && user.email !== name && (
              <p className="truncate font-body text-[13px] text-ink/70">{user.email}</p>
            )}
          </div>

          <hr className="hairline" />

          <Link
            to="/dashboard"
            role="menuitem"
            className={itemClass}
            onClick={() => setOpen(false)}
          >
            {t("dashboard.title")}
          </Link>
          <Link
            to="/settings/mcp"
            role="menuitem"
            className={itemClass}
            onClick={() => setOpen(false)}
          >
            {t("account.connector")}
          </Link>
          <Link
            to="/settings/billing"
            role="menuitem"
            className={itemClass}
            onClick={() => setOpen(false)}
          >
            {t("billing.title")}
          </Link>

          <hr className="hairline" />

          <button
            type="button"
            role="menuitem"
            onClick={() => void handleSignOut()}
            className={`${itemClass} font-bold`}
          >
            {t("dashboard.logout")}
          </button>
        </div>
      )}
    </div>
  );
}
