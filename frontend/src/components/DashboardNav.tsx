import { Link } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { SnoatLogo } from "@/components/SnoatLogo";
import { LanguageSwitcher } from "@/components/LanguageSwitcher";
import { UserMenu } from "@/components/UserMenu";

/**
 * Toppraden i dashboardet.
 *
 * Den inneholder nå bare to ting: veien til prosjektene, og avataren. Alt som
 * gjelder kontoen – AI-tilkobling, fakturering, utlogging – ligger i
 * `UserMenu`. Da slipper raden å vokse med én lenke for hver kontoside vi
 * legger til, og skillet mellom «innhold» og «konto» blir tydelig.
 *
 * Designet skiller flater med strek, ikke med skygge, så headeren har en
 * hårstrek under seg i stedet for den gamle blur-skyggen.
 */
export function DashboardNav() {
  const { t } = useTranslation();

  return (
    <header className="sticky top-0 z-50 border-b-2 border-line bg-paper">
      <div className="mx-auto flex w-full max-w-[1334px] items-center justify-between gap-4 px-5 py-[14px] lg:px-0">
        <div className="flex items-center gap-[22px]">
          <Link
            to="/dashboard"
            className="anim-slide-in inline-flex text-ink transition-transform duration-200 hover:-translate-y-px"
            aria-label="Snoat"
          >
            <SnoatLogo size={30} />
          </Link>
          <Link
            to="/dashboard"
            className="hidden font-body text-[15px] font-normal text-ink/70 transition-colors hover:text-ink sm:inline"
            activeProps={{
              className:
                "text-ink font-bold decoration-sun decoration-[3px] underline underline-offset-[6px]",
            }}
          >
            {t("dashboard.title")}
          </Link>
        </div>

        <div className="flex items-center gap-[18px]">
          <LanguageSwitcher />
          <UserMenu />
        </div>
      </div>
    </header>
  );
}
