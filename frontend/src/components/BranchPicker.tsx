import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { listGithubBranches } from "@/lib/api";

/**
 * `owner/repo`, eller null hvis strengen ikke ser ut som et GitHub-repo ennå.
 *
 * En lettere utgave av `repoIdentity()` i backend, og den er her av én grunn:
 * feltet i «Nytt prosjekt» kan skrives tegn for tegn, og uten sjekken hadde vi
 * sendt et oppslag per tastetrykk – de fleste av dem mot en halvskrevet URL som
 * uansett gir 400. Backend normaliserer på nytt; dette er bare en dørvokter.
 */
function githubIdentity(value: string): string | null {
  const path = value
    .trim()
    .split(/[?#]/)[0]!
    .replace(/^https?:\/\/(www\.)?github\.com\//i, "")
    .replace(/^git@github\.com:/i, "");

  // Er skjemaet fortsatt der, pekte URL-en et annet sted enn github.com.
  if (path.includes("://")) return null;

  const segments = path
    .replace(/\/+$/, "")
    .replace(/\.git$/i, "")
    .split("/")
    .filter(Boolean);

  const [owner, repo] = segments;
  if (!owner || !repo) return null;

  return `${owner}/${repo}`.toLowerCase();
}

/**
 * Velger hvilken gren et prosjekt skal bygges og deployes fra.
 *
 * **Tomt felt betyr «repoets standardgren».** Det er standardverdien i databasen
 * (`projects.branch` er NULL), og den eneste som ikke kan bli feil: skriver vi
 * `main` inn for kunden, slutter et repo med `master` eller `trunk` som hovedgren
 * å deploye i det øyeblikket noen lagrer skjemaet.
 *
 * Lista hentes fra GitHub når Snoat har tilgang til repoet, og det er med vilje:
 * grennavnet må stemme tegn for tegn med noe som finnes der, og en skrivefeil i
 * et fritekstfelt viser seg ellers ikke før bygget feiler med «grenen finnes
 * ikke». Rekker vi ikke repoet – en URL limt inn for hånd, et offentlig repo
 * uten installasjon – faller vi tilbake til et validert tekstfelt. Da er
 * feltet fortsatt brukbart, i stedet for en tom nedtrekksliste som ser ut som om
 * repoet ikke har grener.
 *
 * Uttrykket følger `RepoPicker` i «Nytt prosjekt»: en innrammet liste med rader,
 * gult fyll på valgt rad. Ingen ikoner, ingen skygge – se
 * `CONTEXT_FOR_AI/05_design_system.md`.
 */
export function BranchPicker({
  repo,
  value,
  onChange,
  /** Kjent standardgren fra repo-velgeren, før grenlista er hentet. */
  defaultBranch,
}: {
  repo: string;
  value: string;
  onChange: (branch: string) => void;
  defaultBranch?: string | null;
}) {
  const { t } = useTranslation();
  const [filter, setFilter] = useState("");

  // Repoet kan komme fra et felt som skrives i. Vi venter til det står stille
  // før vi spør GitHub, slik at «https://github.com/eier/repo» blir ett oppslag
  // og ikke tjue.
  const [settled, setSettled] = useState(repo);

  useEffect(() => {
    const timer = setTimeout(() => setSettled(repo), 400);
    return () => clearTimeout(timer);
  }, [repo]);

  const identity = githubIdentity(settled);

  const query = useQuery({
    queryKey: ["github-branches", identity],
    queryFn: () => listGithubBranches(identity!),
    enabled: identity !== null,
    // Ett forsøk. Svaret er 404 når Snoat ikke rekker repoet, og det er et svar
    // – ikke en feil å prøve seg fram mot. Tekstfeltet skal komme fram raskt.
    retry: false,
    staleTime: 60_000,
  });

  const known = query.data?.branches ?? [];
  const standard = query.data?.defaultBranch ?? defaultBranch ?? null;

  // En gren som ligger lagret på prosjektet, men er slettet på GitHub, skal
  // fortsatt stå i lista. Forsvant den, ville feltet sett tomt ut – og tomt
  // betyr noe annet enn «denne grenen finnes ikke lenger».
  const options = value && !known.includes(value) ? [value, ...known] : known;

  const needle = filter.trim().toLowerCase();
  const visible = needle ? options.filter((name) => name.toLowerCase().includes(needle)) : options;

  const defaultLabel = standard
    ? t("branch.default_option", { branch: standard })
    : t("branch.default_option_unknown");

  return (
    <div className="flex flex-col gap-[8px]">
      <span className="font-body text-[15px] font-normal text-ink">{t("branch.label")}</span>

      {query.isSuccess ? (
        <div className="flex max-w-lg flex-col gap-2">
          {options.length > 10 && (
            <input
              type="search"
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
              placeholder={t("branch.filter_placeholder")}
              className="field-ink h-[46px] px-[14px] font-body text-[16px] font-normal outline-none placeholder:text-ink/40"
            />
          )}

          {/* Lista skifter høyde mens man filtrerer. `size-morph` gjør det til
              en bevegelse i stedet for et hopp. */}
          <div className="max-h-56 overflow-y-auto border-2 border-line">
            <BranchRow label={defaultLabel} selected={value === ""} onSelect={() => onChange("")} />

            {visible.map((name) => (
              <BranchRow
                key={name}
                label={name}
                note={known.includes(name) ? undefined : t("branch.missing_on_github")}
                selected={value === name}
                onSelect={() => onChange(name)}
              />
            ))}

            {visible.length === 0 && needle && (
              <p className="anim-fade px-[14px] py-[14px] font-body text-[16px] font-light text-ink/70">
                {t("branch.no_match")}
              </p>
            )}
          </div>
        </div>
      ) : (
        <input
          type="text"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          // Samme regel som `assertSafeBranch()` i backend og
          // check-constrainten `projects_branch_check`. Nettleseren stopper det
          // åpenbare før kallet sendes; backend er den som avgjør.
          pattern="[A-Za-z0-9_][A-Za-z0-9._/-]*"
          title={t("branch.pattern_title")}
          placeholder={standard ?? t("branch.placeholder")}
          className="field-ink h-[46px] max-w-lg px-[14px] font-mono text-[14px] outline-none placeholder:text-ink/40"
        />
      )}

      <span className="max-w-lg font-body text-[14px] font-light leading-[1.5] text-ink/70">
        {query.isLoading && identity
          ? t("branch.loading")
          : query.isError
            ? t("branch.manual_hint")
            : t("branch.help")}
      </span>
    </div>
  );
}

function BranchRow({
  label,
  note,
  selected,
  onSelect,
}: {
  label: string;
  note?: string;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={`anim-slide-in flex w-full items-center justify-between gap-3 border-b border-hair px-[14px] py-[11px] text-left last:border-b-0 ${
        selected ? "bg-sun" : "hover:bg-sun-soft"
      }`}
    >
      <span className="truncate font-mono text-[14px] text-ink">{label}</span>
      {note && (
        <span className="shrink-0 border border-line px-[6px] py-[1px] font-body text-[11px] uppercase tracking-[0.08em] text-ink">
          {note}
        </span>
      )}
    </button>
  );
}
