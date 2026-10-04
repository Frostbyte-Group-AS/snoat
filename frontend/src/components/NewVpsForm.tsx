import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState, type CSSProperties, type FormEvent, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { ApiError, createVps, getVpsResources, type Vps, type VpsResources } from "@/lib/api";

/**
 * «Ny VPS» – kun eierkontoen.
 *
 * Brukes både i «Nytt prosjekt» på dashboardet og under Innstillinger → VPS-er.
 * Menyen viser hva serveren har ledig (CPU, RAM-poolen, disk) og holder
 * glidebryterne innenfor grensene backend oppgir. Backend sjekker de samme
 * grensene på nytt i `createVps`, så dette er en forhåndsvisning, ikke kontrollen.
 *
 * RAM-modellen er to knotter, ikke én: *garantert* (memory.low – minnet VPS-en
 * beholder når andre presser) og *maks*. Standard er ingen egen maks: VPS-en kan
 * bruke alt ledig minne innenfor det felles taket. Se backend/src/services/vps.ts.
 */

const OS_NAVN: Record<string, string> = {
  "debian-12": "Debian 12",
  "debian-13": "Debian 13",
  "ubuntu-24.04": "Ubuntu 24.04",
};

const STORRELSER = [
  { key: "small", cores: 1, minGb: 1, diskGb: 10 },
  { key: "medium", cores: 2, minGb: 4, diskGb: 40 },
  { key: "large", cores: 4, minGb: 16, diskGb: 100 },
] as const;

/** Samme regel som backend (`gyldigVpsNavn`): 2–40 tegn, starter med bokstav. */
function normaliserNavn(verdi: string): string {
  return verdi
    .toLowerCase()
    .replace(/æ/g, "ae")
    .replace(/ø/g, "oe")
    .replace(/å/g, "aa")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[^a-z]+/, "")
    .slice(0, 40);
}

function feiltekst(error: unknown): string {
  return error instanceof ApiError || error instanceof Error ? error.message : String(error);
}

export function NewVpsForm({ onDone, onCancel }: { onDone?: () => void; onCancel?: () => void }) {
  const { t } = useTranslation();
  const ressurser = useQuery({
    queryKey: ["vps-ressurser"],
    queryFn: getVpsResources,
    refetchInterval: 30_000,
  });

  if (ressurser.isLoading) {
    return <p className="font-body text-[16px] font-light text-ink/70">{t("vps.form.loading")}</p>;
  }
  if (ressurser.isError || !ressurser.data) {
    return (
      <p
        role="alert"
        className="border-2 border-error px-[14px] py-[10px] font-body text-[15px] text-error"
      >
        {feiltekst(ressurser.error)}
      </p>
    );
  }
  return (
    <Skjema
      r={ressurser.data.ressurser}
      templates={ressurser.data.templates}
      onDone={onDone}
      onCancel={onCancel}
    />
  );
}

function Skjema({
  r,
  templates,
  onDone,
  onCancel,
}: {
  r: VpsResources;
  templates: string[];
  onDone?: () => void;
  onCancel?: () => void;
}) {
  const { t, i18n } = useTranslation();
  const queryClient = useQueryClient();
  const tall = new Intl.NumberFormat(i18n.language.startsWith("en") ? "en-GB" : "nb-NO", {
    maximumFractionDigits: 1,
  });
  const gb = (mb: number) => `${tall.format(mb / 1024)} GB`;

  const maksGarantiGb = Math.floor(r.grenser.maksGarantertMb / 512) / 2;
  const takGb = Math.floor(r.ram.takMb / 1024);
  const passer = (s: (typeof STORRELSER)[number]) =>
    s.cores <= r.grenser.maksKjerner &&
    s.minGb <= maksGarantiGb &&
    s.diskGb <= r.grenser.maksDiskGb;
  const start = STORRELSER.find((s) => s.key === "medium" && passer(s)) ?? STORRELSER.find(passer);

  const [navn, setNavn] = useState("");
  const [mal, setMal] = useState(
    templates.includes("debian-12") ? "debian-12" : (templates[0] ?? "debian-12"),
  );
  const [storrelse, setStorrelse] = useState<string>(start?.key ?? "custom");
  const [kjerner, setKjerner] = useState<number>(start?.cores ?? 1);
  const [minGb, setMinGb] = useState<number>(start?.minGb ?? 0);
  const [diskGb, setDiskGb] = useState<number>(start?.diskGb ?? Math.min(20, r.grenser.maksDiskGb));
  const [egetTak, setEgetTak] = useState(false);
  const [maksGb, setMaksGb] = useState<number>(Math.max(8, start?.minGb ?? 0));
  const [visNokler, setVisNokler] = useState(!r.standardSshNokkel);
  const [nokler, setNokler] = useState("");

  const velgStorrelse = (s: (typeof STORRELSER)[number]) => {
    setStorrelse(s.key);
    setKjerner(s.cores);
    setMinGb(s.minGb);
    setDiskGb(s.diskGb);
    if (egetTak && maksGb < s.minGb) setMaksGb(s.minGb);
  };
  const egendefinert =
    <T,>(set: (v: T) => void) =>
    (v: T) => {
      setStorrelse("custom");
      set(v);
    };

  const create = useMutation({
    mutationFn: () =>
      createVps({
        name: navn.replace(/-+$/, ""),
        template: mal,
        cores: kjerner,
        diskGb,
        memoryMinMb: Math.round(minGb * 1024),
        memoryMaxMb: egetTak ? Math.round(Math.max(maksGb, minGb, 0.25) * 1024) : undefined,
        sshPublicKeys: nokler
          .split("\n")
          .map((k) => k.trim())
          .filter(Boolean),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["vps"] });
      void queryClient.invalidateQueries({ queryKey: ["vps-ressurser"] });
    },
  });

  if (create.data) return <Ferdig vps={create.data.vps} onDone={onDone} />;

  const ingenDisk = r.grenser.maksDiskGb < r.grenser.minDiskGb;
  const manglerNokkel = !r.standardSshNokkel && !nokler.trim();
  const navnOk = /^[a-z][a-z0-9-]{0,38}[a-z0-9]$/.test(navn.replace(/-+$/, ""));

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (navnOk && !ingenDisk && !manglerNokkel) create.mutate();
  };

  const andreGarantertMb = r.ram.garantertMb;
  const brukDiskGb = Math.max(r.disk.totalGb - r.disk.ledigGb, 0);

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-[22px]">
      <label className="flex flex-col gap-[8px]">
        <span className="font-body text-[15px] font-normal text-ink">{t("vps.form.name")}</span>
        <input
          type="text"
          required
          autoFocus
          value={navn}
          onChange={(event) => setNavn(normaliserNavn(event.target.value))}
          placeholder="min-server"
          className="field-ink h-[46px] px-[14px] font-mono text-[14px] outline-none placeholder:text-ink/40"
        />
        <span className="font-body text-[14px] font-light text-ink/70">
          {t("vps.form.name_hint")}
        </span>
      </label>

      <fieldset className="flex flex-col gap-[8px]">
        <legend className="mb-[8px] font-body text-[15px] font-normal text-ink">
          {t("vps.form.os")}
        </legend>
        <div className="flex flex-wrap gap-2">
          {templates.map((tpl) => (
            <Valg key={tpl} valgt={mal === tpl} onClick={() => setMal(tpl)}>
              {OS_NAVN[tpl] ?? tpl}
            </Valg>
          ))}
        </div>
      </fieldset>

      <fieldset className="flex flex-col gap-[8px]">
        <legend className="mb-[8px] font-body text-[15px] font-normal text-ink">
          {t("vps.form.size")}
        </legend>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {STORRELSER.map((s) => (
            <Valg
              key={s.key}
              valgt={storrelse === s.key}
              onClick={() => velgStorrelse(s)}
              disabled={!passer(s)}
            >
              <span className="block font-display text-[15px] font-bold">
                {t(`vps.form.size_${s.key}`)}
              </span>
              <span className="block font-body text-[13px] font-light">
                {s.cores} CPU · {s.minGb} GB RAM
              </span>
              <span className="block font-body text-[13px] font-light">{s.diskGb} GB disk</span>
            </Valg>
          ))}
          <Valg valgt={storrelse === "custom"} onClick={() => setStorrelse("custom")}>
            <span className="block font-display text-[15px] font-bold">
              {t("vps.form.size_custom")}
            </span>
            <span className="block font-body text-[13px] font-light">
              {t("vps.form.size_custom_hint")}
            </span>
          </Valg>
        </div>
      </fieldset>

      {/* CPU */}
      <Ressurs
        tittel={t("vps.form.cpu")}
        verdi={t("vps.form.cpu_value", { n: kjerner, total: r.cpu.traader })}
        slider={
          <Glider
            min={1}
            max={r.grenser.maksKjerner}
            step={1}
            value={kjerner}
            onChange={egendefinert(setKjerner)}
            label={t("vps.form.cpu")}
          />
        }
        forklaring={t("vps.form.cpu_hint", {
          threads: r.cpu.traader,
          cores: r.cpu.kjerner ?? "–",
          load: r.cpu.bruktProsent,
          assigned: r.cpu.tildeltVps,
        })}
      />

      {/* RAM */}
      <Ressurs
        tittel={t("vps.form.ram_min")}
        verdi={gb(minGb * 1024)}
        slider={
          <Glider
            min={0}
            max={Math.max(maksGarantiGb, 0)}
            step={0.5}
            value={Math.min(minGb, maksGarantiGb)}
            onChange={egendefinert(setMinGb)}
            label={t("vps.form.ram_min")}
          />
        }
        maaler={
          <Maaler
            total={r.ram.takMb}
            deler={[
              { verdi: andreGarantertMb, klasse: "bg-ink" },
              { verdi: minGb * 1024, klasse: "bg-sun" },
            ]}
          />
        }
        forklaring={
          <>
            {t("vps.form.ram_min_hint", {
              cap: gb(r.ram.takMb),
              reserved: gb(r.ram.reservertMb),
              others: gb(andreGarantertMb),
              used: gb(r.ram.iBrukMb),
            })}{" "}
            <Forklaring
              farger={[
                ["bg-ink", t("vps.form.legend_others")],
                ["bg-sun", t("vps.form.legend_this")],
              ]}
            />
          </>
        }
      />

      <div className="flex flex-col gap-[10px] border-2 border-line px-[16px] py-[14px]">
        <div className="flex items-center justify-between gap-4">
          <div className="flex flex-col gap-[2px]">
            <span className="font-body text-[15px] font-normal text-ink">
              {t("vps.form.ram_max")}
            </span>
            <span className="font-body text-[14px] font-light text-ink/70">
              {egetTak
                ? t("vps.form.ram_max_own", { max: gb(Math.max(maksGb, minGb) * 1024) })
                : t("vps.form.ram_max_shared", { cap: gb(r.ram.takMb) })}
            </span>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={egetTak}
            aria-label={t("vps.form.ram_max_toggle")}
            onClick={() => {
              setEgetTak(!egetTak);
              if (!egetTak && maksGb < minGb) setMaksGb(Math.max(minGb, 1));
            }}
            className="ink-switch"
          >
            <span className="ink-switch-thumb" aria-hidden="true" />
          </button>
        </div>
        {egetTak && (
          <Glider
            min={Math.max(minGb, 0.5)}
            max={takGb}
            step={0.5}
            value={Math.max(maksGb, minGb, 0.5)}
            onChange={setMaksGb}
            label={t("vps.form.ram_max")}
          />
        )}
      </div>

      {/* Disk */}
      <Ressurs
        tittel={t("vps.form.disk")}
        verdi={`${diskGb} GB`}
        slider={
          ingenDisk ? null : (
            <Glider
              min={r.grenser.minDiskGb}
              max={r.grenser.maksDiskGb}
              step={1}
              value={Math.min(diskGb, r.grenser.maksDiskGb)}
              onChange={egendefinert(setDiskGb)}
              label={t("vps.form.disk")}
            />
          )
        }
        maaler={
          <Maaler
            total={r.disk.totalGb}
            deler={[
              { verdi: brukDiskGb + r.disk.tildeltUbruktGb, klasse: "bg-ink" },
              { verdi: r.disk.reservertGb, klasse: "bg-ash" },
              { verdi: diskGb, klasse: "bg-sun" },
            ]}
          />
        }
        forklaring={
          <>
            {ingenDisk
              ? t("vps.form.disk_full")
              : t("vps.form.disk_hint", {
                  free: r.disk.ledigGb,
                  max: r.disk.maksNyGb,
                  total: r.disk.totalGb,
                  margin: r.disk.reservertGb,
                })}{" "}
            <Forklaring
              farger={[
                ["bg-ink", t("vps.form.legend_used")],
                ["bg-ash", t("vps.form.legend_margin")],
                ["bg-sun", t("vps.form.legend_this")],
              ]}
            />
          </>
        }
      />

      <div className="flex flex-col gap-[8px]">
        {r.standardSshNokkel && !visNokler ? (
          <p className="font-body text-[14px] font-light text-ink/70">
            {t("vps.form.ssh_default")}{" "}
            <button
              type="button"
              onClick={() => setVisNokler(true)}
              className="text-ink underline underline-offset-[4px] hover:decoration-sun hover:decoration-[3px]"
            >
              {t("vps.form.ssh_add")}
            </button>
          </p>
        ) : (
          <label className="flex flex-col gap-[8px]">
            <span className="font-body text-[15px] font-normal text-ink">
              {r.standardSshNokkel ? t("vps.form.ssh_extra") : t("vps.form.ssh_required")}
            </span>
            <textarea
              rows={3}
              required={!r.standardSshNokkel}
              value={nokler}
              onChange={(event) => setNokler(event.target.value)}
              placeholder="ssh-ed25519 AAAA… navn@maskin"
              className="field-ink px-[14px] py-[10px] font-mono text-[13px] outline-none placeholder:text-ink/40"
            />
          </label>
        )}
      </div>

      <p className="border-l-4 border-sun bg-sun-soft px-[14px] py-[10px] font-body text-[15px] text-ink">
        <span className="font-bold">{navn.replace(/-+$/, "") || "min-server"}</span> ·{" "}
        {OS_NAVN[mal] ?? mal} · {kjerner} CPU ·{" "}
        {t("vps.form.summary_ram", {
          min: gb(minGb * 1024),
          max: egetTak ? gb(Math.max(maksGb, minGb) * 1024) : gb(r.ram.takMb),
        })}{" "}
        · {diskGb} GB disk
      </p>

      {create.isError && (
        <p
          role="alert"
          className="border-2 border-error px-[14px] py-[10px] font-body text-[15px] text-error"
        >
          {feiltekst(create.error)}
        </p>
      )}

      <div className="flex flex-wrap items-center justify-end gap-[12px]">
        {create.isPending && (
          <span className="mr-auto font-body text-[14px] font-light text-ink/70">
            {t("vps.form.creating_hint")}
          </span>
        )}
        {onCancel && (
          <button
            type="button"
            onClick={onCancel}
            className="btn-outline h-[46px] px-[20px] font-display text-[15px]"
          >
            {t("dashboard.new_project_modal.cancel")}
          </button>
        )}
        <button
          type="submit"
          disabled={create.isPending || !navnOk || ingenDisk || manglerNokkel}
          className="btn-ink h-[46px] px-[24px] font-display text-[15px]"
        >
          {create.isPending ? t("vps.creating") : t("vps.create")}
        </button>
      </div>
    </form>
  );
}

function Ferdig({ vps, onDone }: { vps: Vps; onDone?: () => void }) {
  const { t } = useTranslation();
  const [kopiert, setKopiert] = useState(false);
  return (
    <div className="flex flex-col gap-[16px]">
      <p className="font-body text-[17px] text-ink">
        {t("vps.form.done", { name: vps.name, ip: vps.ip ?? "–" })}
      </p>
      {vps.ssh && (
        <div className="flex flex-wrap items-stretch border-2 border-line">
          <code className="min-w-0 flex-1 px-[14px] py-[10px] font-mono text-[14px] text-ink">
            {vps.ssh.command}
          </code>
          <button
            type="button"
            onClick={() => {
              void navigator.clipboard
                ?.writeText(vps.ssh?.command ?? "")
                .then(() => setKopiert(true));
            }}
            className="border-l-2 border-line px-[14px] font-body text-[14px] text-ink transition-colors hover:bg-sun"
          >
            {kopiert ? t("vps.form.copied") : t("vps.form.copy")}
          </button>
        </div>
      )}
      <p className="font-body text-[14px] font-light text-ink/70">{t("vps.form.done_hint")}</p>
      <div className="flex flex-wrap justify-end gap-[12px]">
        <Link
          to="/settings/vps"
          className="btn-outline h-[46px] px-[20px] font-display text-[15px]"
        >
          {t("vps.form.see_all")}
        </Link>
        {onDone && (
          <button
            type="button"
            onClick={onDone}
            className="btn-ink h-[46px] px-[24px] font-display text-[15px]"
          >
            {t("vps.form.close")}
          </button>
        )}
      </div>
    </div>
  );
}

function Valg({
  valgt,
  onClick,
  disabled,
  children,
}: {
  valgt: boolean;
  onClick: () => void;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={valgt}
      className={`border-2 border-line px-[14px] py-[9px] text-left text-ink transition-colors disabled:cursor-not-allowed disabled:opacity-35 ${
        valgt ? "bg-sun" : "hover:bg-sun-soft"
      }`}
    >
      {children}
    </button>
  );
}

function Ressurs({
  tittel,
  verdi,
  slider,
  maaler,
  forklaring,
}: {
  tittel: string;
  verdi: string;
  slider: ReactNode;
  /** Utelates når glidebryteren alene sier alt (CPU). */
  maaler?: ReactNode;
  forklaring: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-[10px]">
      <div className="flex items-baseline justify-between gap-3">
        <span className="font-body text-[15px] font-normal text-ink">{tittel}</span>
        <span className="font-display text-[18px] font-bold text-ink">{verdi}</span>
      </div>
      {slider}
      {maaler}
      <p className="font-body text-[14px] font-light leading-[1.5] text-ink/70">{forklaring}</p>
    </div>
  );
}

function Glider({
  min,
  max,
  step,
  value,
  onChange,
  label,
}: {
  min: number;
  max: number;
  step: number;
  value: number;
  onChange: (v: number) => void;
  label: string;
}) {
  const fyll = max > min ? ((value - min) / (max - min)) * 100 : 100;
  return (
    <input
      type="range"
      min={min}
      max={max}
      step={step}
      value={value}
      aria-label={label}
      onChange={(event) => onChange(Number(event.target.value))}
      className="ink-range"
      style={{ "--fill": `${fyll}%` } as CSSProperties}
    />
  );
}

/** Stablet stolpe: hver del i sin farge, resten står hvitt (ledig). */
function Maaler({
  total,
  deler,
}: {
  total: number;
  deler: Array<{ verdi: number; klasse: string }>;
}) {
  let igjen = 100;
  return (
    <div
      className="flex h-[8px] w-full overflow-hidden border border-line bg-paper"
      aria-hidden="true"
    >
      {deler.map((del, i) => {
        const andel = total > 0 ? Math.min((Math.max(del.verdi, 0) / total) * 100, igjen) : 0;
        igjen -= andel;
        return (
          <div
            key={i}
            className={`h-full ${del.klasse} transition-[width] duration-200`}
            style={{ width: `${andel}%` }}
          />
        );
      })}
    </div>
  );
}

function Forklaring({ farger }: { farger: Array<[string, string]> }) {
  return (
    <span className="inline-flex flex-wrap gap-x-[12px] gap-y-[4px] align-middle">
      {farger.map(([klasse, tekst]) => (
        <span key={tekst} className="inline-flex items-center gap-[6px]">
          <span
            className={`inline-block h-[10px] w-[10px] border border-line ${klasse}`}
            aria-hidden="true"
          />
          {tekst}
        </span>
      ))}
    </span>
  );
}
