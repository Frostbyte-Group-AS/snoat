import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useFormatters } from "@/lib/format";
import type { Project } from "@/lib/database.types";
import { getProjectErrors, setErrorStatus, type ErrorGroup } from "@/lib/api";

/**
 * Feilfanen.
 *
 * Statistikkfanen ved siden av kan fortelle at appen svarte 5xx tolv ganger i
 * går. Den kan ikke fortelle hva som feilet. Denne kan – og det er hele
 * forskjellen mellom et tall noen noterer seg og en feil noen retter.
 *
 * Som statistikken er det ingenting å sette opp: proxyen injiserer collectoren i
 * HTML-svarene, stderr-sveipet leser containernes ufangede unntak, og
 * helsesveipet melder inn krasj. Fanen er derfor aldri tom fordi noen glemte å
 * skru den på – er den tom, har det ikke skjedd noe.
 *
 * I motsetning til statistikken er den ikke plangrenset. En app som krasjer for
 * brukerne sine er et problem på gratisplanen også.
 */

const FILTERS: Array<{ key: "open" | "resolved" | "ignored" | "all"; label: string }> = [
  { key: "open", label: "Åpne" },
  { key: "resolved", label: "Løste" },
  { key: "ignored", label: "Dempet" },
  { key: "all", label: "Alle" },
];

/**
 * Hvor feilen ble observert, i klartekst.
 *
 * `kind` er et maskinord i databasen fordi det er en del av fingerprinten.
 * Her skal det leses av et menneske som skal avgjøre om det haster.
 */
const KIND_LABEL: Record<ErrorGroup["kind"], string> = {
  client: "Nettleser",
  server: "Server",
  crash: "Krasj",
  http: "5xx",
};

/**
 * Et krasj er verre enn et serverunntak, som er verre enn en klientfeil: det
 * første betyr at appen er nede, det andre at en forespørsel feilet, det tredje
 * at én bruker så noe rart. Fargen sier det uten at noen må lese ordet.
 */
const KIND_TONE: Record<ErrorGroup["kind"], string> = {
  crash: "bg-ink text-paper",
  server: "bg-sun text-ink",
  http: "bg-sun text-ink",
  client: "bg-paper text-ink",
};

function relative(iso: string, locale: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const minutes = Math.round(diffMs / 60_000);

  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });

  if (Math.abs(minutes) < 60) return rtf.format(-minutes, "minute");
  if (Math.abs(minutes) < 60 * 24) return rtf.format(-Math.round(minutes / 60), "hour");
  return rtf.format(-Math.round(minutes / (60 * 24)), "day");
}

function ErrorRow({
  group,
  locale,
  onStatus,
  busy,
}: {
  group: ErrorGroup;
  locale: string;
  onStatus: (status: "open" | "resolved" | "ignored") => void;
  busy: boolean;
}) {
  const [open, setOpen] = useState(false);
  const stack = group.stacks[0];

  return (
    <div className="ink-card px-[23px] py-[20px]">
      <div className="flex flex-wrap items-start justify-between gap-[12px]">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-[8px]">
            <span
              className={`border-2 border-line px-[8px] py-[2px] font-body text-[12px] font-normal uppercase tracking-[0.08em] ${KIND_TONE[group.kind]}`}
            >
              {KIND_LABEL[group.kind]}
            </span>
            <span className="font-body text-[13px] font-normal text-ink/70">
              {group.events}× · sist {relative(group.last_seen, locale)} · først{" "}
              {relative(group.first_seen, locale)}
            </span>
          </div>

          {/* `break-words` fordi en feilmelding kan være én lang URL uten
              mellomrom, og den skal ikke sprenge kortet. */}
          <p className="mt-[10px] break-words font-display text-[18px] font-bold leading-snug text-ink">
            {group.message}
          </p>

          {group.file ? (
            <p className="mt-[4px] break-all font-mono text-[13px] font-normal text-ink/70">
              {group.file}
              {group.line === null ? "" : `:${group.line}`}
              {group.col === null ? "" : `:${group.col}`}
            </p>
          ) : null}

          {group.patch_pr_url ? (
            <a
              href={group.patch_pr_url}
              target="_blank"
              rel="noreferrer"
              className="mt-[8px] inline-block font-body text-[14px] font-normal underline"
            >
              Foreslått fiks →
            </a>
          ) : null}
        </div>

        <div className="flex shrink-0 gap-[8px]">
          {group.status === "open" ? (
            <>
              <button
                type="button"
                disabled={busy}
                onClick={() => onStatus("resolved")}
                className="border-2 border-line px-[12px] py-[6px] font-body text-[14px] font-normal text-ink disabled:opacity-50"
              >
                Løst
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => onStatus("ignored")}
                className="border-2 border-line px-[12px] py-[6px] font-body text-[14px] font-normal text-ink/70 disabled:opacity-50"
              >
                Demp
              </button>
            </>
          ) : (
            <button
              type="button"
              disabled={busy}
              onClick={() => onStatus("open")}
              className="border-2 border-line px-[12px] py-[6px] font-body text-[14px] font-normal text-ink disabled:opacity-50"
            >
              Gjenåpne
            </button>
          )}
        </div>
      </div>

      {stack?.stack ? (
        <div className="mt-[14px]">
          <button
            type="button"
            onClick={() => setOpen((value) => !value)}
            className="font-body text-[14px] font-normal text-ink underline"
          >
            {open ? "Skjul stacktrace" : "Vis stacktrace"}
          </button>

          {open ? (
            <div className="mt-[10px] border-2 border-line bg-paper">
              {stack.url || stack.browser ? (
                <p className="border-b-2 border-line px-[14px] py-[8px] font-body text-[13px] font-normal text-ink/70">
                  {[stack.url, stack.browser, stack.os].filter(Boolean).join(" · ")}
                </p>
              ) : null}
              {/* Vannrett scroll på selve blokken: en stacktrace har lange
                  linjer, og ombrekking gjør den uleselig. Siden skal ikke
                  scrolle sidelengs fordi en av dem er bred. */}
              <pre className="max-h-[320px] overflow-auto px-[14px] py-[12px] font-mono text-[12px] leading-relaxed text-ink">
                {stack.stack}
              </pre>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export function ErrorsTab({ project }: { project: Project }) {
  const format = useFormatters();
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [filter, setFilter] = useState<"open" | "resolved" | "ignored" | "all">("open");

  const query = useQuery({
    queryKey: ["errors", project.id, filter],
    queryFn: () => getProjectErrors(project.id, filter),
    refetchInterval: 60_000,
    staleTime: 30_000,
  });

  const mutation = useMutation({
    mutationFn: ({ id, status }: { id: string; status: "open" | "resolved" | "ignored" }) =>
      setErrorStatus(id, status),
    // Hele lista friskes opp og ikke bare raden: en gruppe som lukkes forsvinner
    // ut av «Åpne»-filteret, og da er det lista som har endret seg.
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["errors", project.id] }),
  });

  const groups = query.data?.errors ?? [];

  return (
    <div className="flex flex-col gap-[18px]">
      <div className="flex flex-wrap items-center gap-[8px]">
        {FILTERS.map((item) => (
          <button
            key={item.key}
            type="button"
            onClick={() => setFilter(item.key)}
            className={`border-2 border-line px-[14px] py-[6px] font-body text-[14px] font-normal ${
              filter === item.key ? "bg-ink text-paper" : "bg-paper text-ink"
            }`}
          >
            {item.label}
          </button>
        ))}
      </div>

      {query.isLoading ? (
        <p className="font-body text-[16px] font-normal text-ink/70">Henter feil …</p>
      ) : query.isError ? (
        <div className="border-2 border-line bg-sun px-[23px] py-[20px]">
          <p className="font-body text-[16px] font-normal text-ink">
            Kunne ikke hente feil. Prøv igjen om litt.
          </p>
        </div>
      ) : groups.length === 0 ? (
        <div className="border-2 border-line bg-paper px-[23px] py-[25px]">
          <h2 className="font-display text-[20px] font-bold text-ink">
            {filter === "open" ? "Ingen åpne feil" : "Ingenting her"}
          </h2>
          <p className="mt-[6px] font-body text-[16px] font-normal text-ink/70">
            {filter === "open"
              ? "Feil fanges automatisk – i nettleseren, i serverprosessen og når containeren dør. Det er ingenting å slå på."
              : "Ingen feilgrupper med denne statusen."}
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-[12px]">
          {groups.map((group) => (
            <ErrorRow
              key={group.id}
              group={group}
              locale={format.locale}
              busy={mutation.isPending}
              onStatus={(status) => mutation.mutate({ id: group.id, status })}
            />
          ))}
        </div>
      )}

      <p className="font-body text-[13px] font-normal text-ink/70">
        {t("project.errors_privacy", {
          defaultValue:
            "Ingen IP-adresser lagres. Stacktraces slettes etter 30 dager, og URL-er lagres uten query-streng.",
        })}
      </p>
    </div>
  );
}
