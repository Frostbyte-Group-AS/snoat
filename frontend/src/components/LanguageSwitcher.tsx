import { useTranslation } from "react-i18next";

/**
 * Språkvelger som to bokstavpar i stedet for flagg.
 *
 * Flaggbildene var det siste ikonet på siden, og et flagg er dessuten et
 * dårlig språkvalg: Union Jack er ikke «engelsk», det er Storbritannia.
 * Aktivt språk er understreket med den gule håndstreken fra designet.
 */
export function LanguageSwitcher() {
  const { i18n } = useTranslation();

  const isNorwegian =
    i18n.language?.startsWith("no") ||
    i18n.language?.startsWith("nb") ||
    i18n.language?.startsWith("nn");

  const options = [
    { code: "no", label: "NO", title: "Bytt til norsk", active: isNorwegian },
    { code: "en", label: "EN", title: "Switch to English", active: !isNorwegian },
  ];

  return (
    <div className="flex items-center gap-[10px]">
      {options.map((option) => (
        <button
          key={option.code}
          type="button"
          onClick={() => void i18n.changeLanguage(option.code)}
          title={option.title}
          aria-current={option.active ? "true" : undefined}
          className={`font-body text-[15px] leading-none tracking-[0.06em] transition-opacity ${
            option.active ? "font-bold text-ink" : "font-normal text-ink/45 hover:text-ink"
          }`}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
