import { Link, useLocation } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";

import { LanguageSwitcher } from "@/components/LanguageSwitcher";
import { SnoatLogo } from "@/components/SnoatLogo";
import { useAuth } from "@/lib/auth";

/**
 * Rammen rundt markedsflatene: header og footer.
 *
 * Begge lå tidligere inne i `routes/index.tsx`. De ble flyttet hit da
 * `/articles` kom til – to kopier av samme header er to steder å glemme en
 * lenke. Målene er de samme som før (Figma 0:1684 og 0:1695–0:1718), og
 * flyttingen endret ingen piksel.
 */

/** Innholdsbredden i designet: 1334 px, sentrert. */
export const SHELL = "mx-auto w-full max-w-[1334px] px-5 sm:px-8 lg:px-0";

/**
 * Ankerlenkene i navigasjonen peker på seksjoner som bare finnes på forsiden.
 * På forsiden er de rene fragmenter, ellers må de ha banen med – ellers leter
 * nettleseren etter `#prising` på artikkelsiden og finner ingenting.
 */
function useHomePrefix(): string {
  const { pathname } = useLocation();
  return pathname === "/" ? "" : "/";
}

export function SiteHeader() {
  const { t } = useTranslation();
  const { user, loading } = useAuth();
  const signedIn = !loading && Boolean(user);
  const home = useHomePrefix();

  const links = [
    { href: `${home}#funksjoner`, label: t("nav.features") },
    { href: `${home}#prising`, label: t("nav.pricing") },
    { href: `${home}#hvorfor`, label: t("nav.why") },
  ];

  return (
    <header className="sticky top-0 z-50 bg-paper pt-6 lg:pt-[48px]">
      <div className={SHELL}>
        <div className="mx-auto flex max-w-[1264px] flex-wrap items-center justify-between gap-y-4">
          <Link to="/" className="text-ink" aria-label="Snoat">
            <SnoatLogo size={36} />
          </Link>

          <nav className="hidden items-center gap-[38px] xl:flex xl:gap-[46px]">
            {links.map((link) => (
              <a
                key={link.href}
                href={link.href}
                className="font-body text-[20px] font-normal text-ink underline-offset-[6px] hover:underline xl:text-[27px]"
              >
                {link.label}
              </a>
            ))}
            <Link
              to="/articles"
              className="font-body text-[20px] font-normal text-ink underline-offset-[6px] hover:underline xl:text-[27px]"
              activeProps={{ className: "underline" }}
            >
              {t("nav.articles")}
            </Link>
          </nav>

          <div className="flex items-center gap-4">
            <LanguageSwitcher />
            {signedIn ? (
              <Link
                to="/dashboard"
                className="btn-ink h-[45px] px-[34px] font-body text-[16px] font-normal xl:text-[20.8px]"
              >
                {t("nav.my_projects")}
              </Link>
            ) : (
              <Link
                to="/login"
                className="btn-ink h-[45px] px-[34px] font-body text-[16px] font-normal xl:text-[20.8px]"
              >
                {t("nav.login")}
              </Link>
            )}
          </div>
        </div>
      </div>
    </header>
  );
}

export function SiteFooter() {
  const { t } = useTranslation();
  const year = new Date().getFullYear();
  const home = useHomePrefix();

  const footerLink =
    "font-meta text-[18px] font-extralight text-ink hover:underline lg:text-[26.9px]";

  return (
    <footer className={`${SHELL} mt-[120px] pb-[72px] lg:mt-[160px] lg:pb-[96px]`}>
      <div className="flex flex-col gap-12 lg:flex-row lg:justify-between">
        <div>
          <SnoatLogo size={40} className="text-ink" />
          <p className="mt-[49px] max-w-[341px] font-meta text-[16px] font-normal leading-[1.5] text-ink lg:text-[20.5px]">
            {t("footer.vision")}
          </p>
        </div>

        <div className="flex gap-[48px] lg:gap-[96px]">
          <nav className="lg:text-right">
            <h2 className="font-meta text-[20px] font-normal text-ink lg:text-[26.9px]">
              {t("footer.col_platform")}
            </h2>
            <ul className="mt-[20px] flex flex-col gap-[16px] lg:mt-[28px] lg:gap-[28px]">
              <li>
                <a href={`${home}#funksjoner`} className={footerLink}>
                  {t("nav.features")}
                </a>
              </li>
              <li>
                <a href={`${home}#prising`} className={footerLink}>
                  {t("nav.pricing")}
                </a>
              </li>
              <li>
                <a href={`${home}#hvorfor`} className={footerLink}>
                  {t("nav.why")}
                </a>
              </li>
              <li>
                <Link to="/articles" className={footerLink}>
                  {t("nav.articles")}
                </Link>
              </li>
            </ul>
          </nav>

          <nav>
            <h2 className="font-meta text-[20px] font-normal text-ink lg:text-[26.9px]">
              {t("footer.col_account")}
            </h2>
            <ul className="mt-[20px] flex flex-col gap-[16px] lg:mt-[28px] lg:gap-[28px]">
              <li>
                <Link to="/login" className={footerLink}>
                  {t("nav.login")}
                </Link>
              </li>
              <li>
                <Link to="/login" className={footerLink}>
                  {t("nav.register")}
                </Link>
              </li>
              <li>
                <Link to="/dashboard" className={footerLink}>
                  {t("nav.my_projects")}
                </Link>
              </li>
            </ul>
          </nav>
        </div>
      </div>

      <p className="mt-[70px] font-meta text-[13px] font-light text-ink lg:text-[15.4px]">
        {t("footer.copyright", { year })}
      </p>
    </footer>
  );
}
