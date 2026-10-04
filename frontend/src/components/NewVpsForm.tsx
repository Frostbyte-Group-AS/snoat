import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState, type CSSProperties, type FormEvent, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { ApiError, createVps, getVpsResources, type Vps, type VpsResources } from "@/lib/api";

/**
 * «Ny VPS» som veiviser – ett spørsmål per skjerm. Kun eierkontoen.
 *
 * Brukes i «Nytt prosjekt» på dashboardet og under Innstillinger → VPS-er.
 *
 * Rask vei: navn → operativsystem → størrelse → se over. Velges «Egendefinert»
 * som størrelse, kommer CPU, RAM og disk som egne steg. Mangler eieren
 * standardnøkler (`SNOAT_VPS_DEFAULT_SSH_KEYS_B64`), kommer et steg for SSH-nøkkel.
 * Oversikten til slutt har «Endre» på hver rad, som hopper rett til steget.
 *
 * Grensene glidebryterne holder seg innenfor kommer fra `/api/vps/ressurser`.
 * Backend sjekker dem på nytt i `createVps`, så dette er en forhåndsvisning, ikke
 * kontrollen. RAM-modellen er to knotter: *garantert* (memory.low) og *maks*.
 * Standard er ingen egen maks – VPS-en kan bruke alt ledig innenfor det felles
 * taket. Se backend/src/services/vps.ts.
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
type Storrelse = (typeof STORRELSER)[number];

type Steg = "navn" | "os" | "storrelse" | "cpu" | "ram" | "disk" | "tilgang" | "oversikt";

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

const ferdigNavn = (navn: string) => navn.replace(/-+$/, "");
const gyldigNavn = (navn: string) => /^[a-z][a-z0-9-]{0,38}[a-z0-9]$/.test(ferdigNavn(navn));

function feiltekst(error: unknown): string {
  return error instanceof ApiError || error instanceof Error ? error.message : String(error);
}

export function NewVpsForm({
  onDone,
  onCancel,
  onBack,
}: {
  onDone?: () => void;
  onCancel?: () => void;
  /** Vises som «← Tilbake» på første steg (til valget mellom app og VPS). */
  onBack?: () => void;
}) {
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
    <Veiviser
      r={ressurser.data.ressurser}
      templates={ressurser.data.templates}
      onDone={onDone}
      onCancel={onCancel}
      onBack={onBack}
    />
  );
}

function Veiviser({
  r,
  templates,
  onDone,
  onCancel,
  onBack,
}: {
  r: VpsResources;
  templates: string[];
  onDone?: () => void;
  onCancel?: () => void;
  onBack?: () => void;
}) {
  const { t, i18n } = useTranslation();
  const queryClient = useQueryClient();
  const tall = new Intl.NumberFormat(i18n.language.startsWith("en") ? "en-GB" : "nb-NO", {
    maximumFractionDigits: 1,
  });
  const gb = (mb: number) => `${tall.format(mb / 1024)} GB`;

  const maksGarantiGb = Math.floor(r.grenser.maksGarantertMb / 512) / 2;
  const takGb = Math.floor(r.ram.takMb / 1024);
  const passer = (s: Storrelse) =>
    s.cores <= r.grenser.maksKjerner &&
    s.minGb <= maksGarantiGb &&
    s.diskGb <= r.grenser.maksDiskGb;
  const start = STORRELSER.find((s) => s.key === "medium" && passer(s)) ?? STORRELSER.find(passer);

  const [navn, setNavn] = useState("");
  const [navnForsokt, setNavnForsokt] = useState(false);
  const [mal, setMal] = useState(
    templates.includes("debian-12") ? "debian-12" : (templates[0] ?? "debian-12"),
  );
  const [storrelse, setStorrelse] = useState<string>(start?.key ?? "custom");
  const [kjerner, setKjerner] = useState<number>(start?.cores ?? 1);
  const [minGb, setMinGb] = useState<number>(start?.minGb ?? 0);
  const [diskGb, setDiskGb] = useState<number>(start?.diskGb ?? Math.min(20, r.grenser.maksDiskGb));
  const [egetTak, setEgetTak] = useState(false);
  const [maksGb, setMaksGb] = useState<number>(Math.max(8, start?.minGb ?? 0));
  const [visNokler, setVisNokler] = useState(false);
  const [nokler, setNokler] = useState("");
  const [steg, setSteg] = useState<Steg>("navn");

  const egendefinert = storrelse === "custom";
  const alleSteg: Steg[] = [
    "navn",
    "os",
    "storrelse",
    ...(egendefinert ? (["cpu", "ram", "disk"] as const) : []),
    ...(r.standardSshNokkel ? [] : (["tilgang"] as const)),
    "oversikt",
  ];
  const indeks = Math.max(alleSteg.indexOf(steg), 0);
  const sisteSteg = steg === "oversikt";

  const ingenDisk = r.grenser.maksDiskGb < r.grenser.minDiskGb;
  const harNokkel = r.standardSshNokkel || Boolean(nokler.trim());
  const ekstraNokler = nokler
    .split("\n")
    .map((k) => k.trim())
    .filter(Boolean);
  const effektivMaksGb = Math.max(maksGb, minGb, 0.5);

  const create = useMutation({
    mutationFn: () =>
      createVps({
        name: ferdigNavn(navn),
        template: mal,
        cores: kjerner,
        diskGb,
        memoryMinMb: Math.round(minGb * 1024),
        memoryMaxMb: egetTak ? Math.round(effektivMaksGb * 1024) : undefined,
        sshPublicKeys: ekstraNokler,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["vps"] });
      void queryClient.invalidateQueries({ queryKey: ["vps-ressurser"] });
    },
  });

  if (create.data) return <Ferdig vps={create.data.vps} onDone={onDone} />;

  const kanGaVidere = (s: Steg) => {
    if (s === "navn") return gyldigNavn(navn);
    if (s === "disk") return !ingenDisk;
    if (s === "tilgang") return harNokkel;
    if (s === "oversikt") return gyldigNavn(navn) && !ingenDisk && harNokkel;
    return true;
  };

  const neste = () => {
    if (steg === "navn") setNavnForsokt(true);
    if (!kanGaVidere(steg)) return;
    if (sisteSteg) {
      create.mutate();
      return;
    }
    setSteg(alleSteg[indeks + 1] ?? "oversikt");
  };

  const tilbake = () => {
    if (indeks === 0) (onBack ?? onCancel)?.();
    else setSteg(alleSteg[indeks - 1] ?? "navn");
  };

  /** Fra oversikten: CPU, RAM og disk kan bare endres i egendefinert modus. */
  const endre = (s: Steg) => {
    if ((s === "cpu" || s === "ram" || s === "disk") && !egendefinert) setStorrelse("custom");
    setSteg(s);
  };

  const velgStorrelse = (s: Storrelse) => {
    setStorrelse(s.key);
    setKjerner(s.cores);
    setMinGb(s.minGb);
    setDiskGb(s.diskGb);
    if (egetTak && maksGb < s.minGb) setMaksGb(s.minGb);
  };

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    neste();
  };

  const venstreKnapp =
    indeks === 0
      ? onBack
        ? t("vps.wizard.back")
        : onCancel
          ? t("dashboard.new_project_modal.cancel")
          : null
      : t("vps.wizard.back");

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-[24px]">
      <StegLinje
        steg={alleSteg}
        indeks={indeks}
        onVelg={(i) => {
          const maal = alleSteg[i];
          if (maal && i < indeks && !create.isPending) setSteg(maal);
        }}
      />

      <div key={steg} className="anim-rise flex min-h-[260px] flex-col gap-[18px]">
        <h3 className="font-display text-[24px] font-bold leading-[1.2] text-ink">
          {t(`vps.wizard.q_${steg}`)}
        </h3>

        {steg === "navn" && (
          <label className="flex flex-col gap-[8px]">
            <span className="sr-only">{t("vps.wizard.sum_name")}</span>
            <input
              type="text"
              autoFocus
              value={navn}
              onChange={(event) => setNavn(normaliserNavn(event.target.value))}
              placeholder="min-server"
              aria-invalid={navnForsokt && !gyldigNavn(navn)}
              className="field-ink h-[50px] px-[14px] font-mono text-[16px] outline-none placeholder:text-ink/40"
            />
            <span
              className={`font-body text-[14px] ${navnForsokt && !gyldigNavn(navn) ? "text-error" : "font-light text-ink/70"}`}
            >
              {navnForsokt && !gyldigNavn(navn)
                ? t("vps.wizard.name_invalid")
                : t("vps.form.name_hint")}
            </span>
          </label>
        )}

        {steg === "os" && (
          <div
            className="flex flex-col gap-[10px]"
            role="radiogroup"
            aria-label={t("vps.wizard.sum_os")}
          >
            {templates.map((tpl) => (
              <Valg key={tpl} valgt={mal === tpl} onClick={() => setMal(tpl)}>
                <span className="block font-body text-[17px] text-ink">{OS_NAVN[tpl] ?? tpl}</span>
                <span className="block font-body text-[14px] font-light text-ink/70">
                  {t(`vps.wizard.os_hint_${tpl.replace(/[^a-z0-9]/g, "")}`)}
                </span>
              </Valg>
            ))}
          </div>
        )}

        {steg === "storrelse" && (
          <>
            <p className="font-body text-[15px] font-light text-ink/70">
              {t("vps.wizard.free_now", {
                threads: r.cpu.traader,
                ram: gb(r.grenser.maksGarantertMb),
                disk: r.disk.maksNyGb,
              })}
            </p>
            <div
              className="grid grid-cols-1 gap-[10px] sm:grid-cols-2"
              role="radiogroup"
              aria-label={t("vps.wizard.q_storrelse")}
            >
              {STORRELSER.map((s) => (
                <Valg
                  key={s.key}
                  valgt={storrelse === s.key}
                  onClick={() => velgStorrelse(s)}
                  disabled={!passer(s)}
                >
                  <span className="block font-body text-[17px] text-ink">
                    {t(`vps.form.size_${s.key}`)}
                  </span>
                  <span className="mt-[4px] block font-body text-[14px] font-light text-ink/70">
                    {t("vps.wizard.preset_cpu", { count: s.cores })}
                    <br />
                    {t("vps.wizard.preset_ram", { n: s.minGb })}
                    <br />
                    {t("vps.wizard.preset_disk", { n: s.diskGb })}
                  </span>
                </Valg>
              ))}
              <Valg valgt={egendefinert} onClick={() => setStorrelse("custom")}>
                <span className="block font-body text-[17px] text-ink">
                  {t("vps.form.size_custom")}
                </span>
                <span className="mt-[4px] block font-body text-[14px] font-light text-ink/70">
                  {t("vps.wizard.custom_hint")}
                </span>
              </Valg>
            </div>
          </>
        )}

        {steg === "cpu" && (
          <Ressurs
            verdi={t("vps.form.cpu_value", { n: kjerner, total: r.cpu.traader })}
            slider={
              <Glider
                min={1}
                max={r.grenser.maksKjerner}
                step={1}
                value={kjerner}
                onChange={setKjerner}
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
        )}

        {steg === "ram" && (
          <>
            <Ressurs
              etikett={t("vps.form.ram_min")}
              verdi={gb(minGb * 1024)}
              slider={
                <Glider
                  min={0}
                  max={Math.max(maksGarantiGb, 0)}
                  step={0.5}
                  value={Math.min(minGb, maksGarantiGb)}
                  onChange={setMinGb}
                  label={t("vps.form.ram_min")}
                />
              }
              maaler={
                <Maaler
                  total={r.ram.takMb}
                  deler={[
                    { verdi: r.ram.garantertMb, klasse: "bg-ink" },
                    { verdi: minGb * 1024, klasse: "bg-sun" },
                  ]}
                />
              }
              forklaring={
                <>
                  {t("vps.form.ram_min_hint", {
                    cap: gb(r.ram.takMb),
                    reserved: gb(r.ram.reservertMb),
                    others: gb(r.ram.garantertMb),
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

            <hr className="hairline" />

            <div className="flex flex-col gap-[12px]">
              <div className="flex items-center justify-between gap-4">
                <div className="flex flex-col gap-[2px]">
                  <span className="font-body text-[15px] text-ink">{t("vps.form.ram_max")}</span>
                  <span className="font-body text-[14px] font-light text-ink/70">
                    {egetTak
                      ? t("vps.form.ram_max_own", { max: gb(effektivMaksGb * 1024) })
                      : t("vps.form.ram_max_shared", { cap: gb(r.ram.takMb) })}
                  </span>
                </div>
                <div className="flex shrink-0 items-center gap-[10px]">
                  <span className="font-body text-[14px] text-ink" aria-hidden="true">
                    {egetTak ? t("vps.wizard.switch_on") : t("vps.wizard.switch_off")}
                  </span>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={egetTak}
                    aria-label={t("vps.form.ram_max_toggle")}
                    onClick={() => {
                      if (!egetTak && maksGb < minGb) setMaksGb(Math.max(minGb, 1));
                      setEgetTak(!egetTak);
                    }}
                    className="ink-switch"
                  >
                    <span className="ink-switch-thumb" aria-hidden="true" />
                  </button>
                </div>
              </div>
              <div
                className="collapse-grid"
                data-open={egetTak ? "true" : "false"}
                inert={!egetTak}
              >
                <div>
                  <Glider
                    min={Math.max(minGb, 0.5)}
                    max={takGb}
                    step={0.5}
                    value={effektivMaksGb}
                    onChange={setMaksGb}
                    label={t("vps.form.ram_max")}
                  />
                </div>
              </div>
            </div>
          </>
        )}

        {steg === "disk" && (
          <Ressurs
            verdi={`${diskGb} GB`}
            slider={
              ingenDisk ? null : (
                <Glider
                  min={r.grenser.minDiskGb}
                  max={r.grenser.maksDiskGb}
                  step={1}
                  value={Math.min(diskGb, r.grenser.maksDiskGb)}
                  onChange={setDiskGb}
                  label={t("vps.form.disk")}
                />
              )
            }
            maaler={
              <Maaler
                total={r.disk.totalGb}
                deler={[
                  {
                    verdi: Math.max(r.disk.totalGb - r.disk.ledigGb, 0) + r.disk.tildeltUbruktGb,
                    klasse: "bg-ink",
                  },
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
        )}

        {steg === "tilgang" && (
          <label className="flex flex-col gap-[8px]">
            <span className="font-body text-[15px] text-ink">{t("vps.form.ssh_required")}</span>
            <textarea
              rows={4}
              autoFocus
              value={nokler}
              onChange={(event) => setNokler(event.target.value)}
              placeholder="ssh-ed25519 AAAA… navn@maskin"
              className="field-ink px-[14px] py-[10px] font-mono text-[13px] outline-none placeholder:text-ink/40"
            />
          </label>
        )}

        {steg === "oversikt" && (
          <>
            <dl className="border-2 border-line">
              {(
                [
                  [
                    "navn",
                    t("vps.wizard.sum_name"),
                    <span className="font-mono">{ferdigNavn(navn)}</span>,
                  ],
                  ["os", t("vps.wizard.sum_os"), OS_NAVN[mal] ?? mal],
                  [
                    "cpu",
                    t("vps.wizard.sum_cpu"),
                    t("vps.form.cpu_value", { n: kjerner, total: r.cpu.traader }),
                  ],
                  [
                    "ram",
                    t("vps.wizard.sum_ram"),
                    t("vps.wizard.sum_ram_value", {
                      min: gb(minGb * 1024),
                      max: egetTak ? gb(effektivMaksGb * 1024) : gb(r.ram.takMb),
                    }),
                  ],
                  ["disk", t("vps.wizard.sum_disk"), `${diskGb} GB`],
                ] as Array<[Steg, string, ReactNode]>
              ).map(([id, etikett, verdi]) => (
                <Rad
                  key={id}
                  etikett={etikett}
                  verdi={verdi}
                  onEndre={() => endre(id)}
                  endreTekst={t("vps.wizard.edit")}
                />
              ))}
              <Rad
                etikett={t("vps.wizard.sum_ssh")}
                verdi={
                  ekstraNokler.length > 0
                    ? t("vps.wizard.sum_ssh_extra", { n: ekstraNokler.length })
                    : t("vps.wizard.sum_ssh_default")
                }
                onEndre={
                  r.standardSshNokkel ? () => setVisNokler(!visNokler) : () => setSteg("tilgang")
                }
                endreTekst={r.standardSshNokkel ? t("vps.wizard.add_keys") : t("vps.wizard.edit")}
              />
            </dl>

            {r.standardSshNokkel && (
              <div
                className="collapse-grid"
                data-open={visNokler ? "true" : "false"}
                inert={!visNokler}
              >
                <div>
                  <label className="flex flex-col gap-[8px] pt-[2px]">
                    <span className="font-body text-[15px] text-ink">
                      {t("vps.form.ssh_extra")}
                    </span>
                    <textarea
                      rows={3}
                      value={nokler}
                      onChange={(event) => setNokler(event.target.value)}
                      placeholder="ssh-ed25519 AAAA… navn@maskin"
                      className="field-ink px-[14px] py-[10px] font-mono text-[13px] outline-none placeholder:text-ink/40"
                    />
                  </label>
                </div>
              </div>
            )}

            <div
              className="collapse-grid"
              data-open={create.isError ? "true" : "false"}
              inert={!create.isError}
            >
              <div>
                <p
                  role="alert"
                  className="border-2 border-error px-[14px] py-[10px] font-body text-[15px] text-error"
                >
                  {create.isError ? feiltekst(create.error) : ""}
                </p>
              </div>
            </div>
          </>
        )}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-[12px]">
        <div>
          {venstreKnapp && (
            <button
              type="button"
              onClick={tilbake}
              disabled={create.isPending}
              className="btn-outline h-[46px] px-[20px] font-display text-[15px]"
            >
              {venstreKnapp}
            </button>
          )}
        </div>
        <div className="flex items-center gap-[12px]">
          {create.isPending && (
            <span className="font-body text-[14px] font-light text-ink/70">
              {t("vps.form.creating_hint")}
            </span>
          )}
          <button
            type="submit"
            disabled={create.isPending || (sisteSteg && !kanGaVidere("oversikt"))}
            className="btn-ink h-[46px] px-[24px] font-display text-[15px]"
          >
            {sisteSteg
              ? create.isPending
                ? t("vps.creating")
                : t("vps.create")
              : t("vps.wizard.next")}
          </button>
        </div>
      </div>
    </form>
  );
}

/**
 * Fremdriften: én rute per steg. Formen bærer tilstanden, ikke fargen alene –
 * ferdig er svart med ✓, nåværende er gul med tallet, kommende er hvit med tallet.
 * Ferdige steg kan klikkes for å gå tilbake.
 */
function StegLinje({
  steg,
  indeks,
  onVelg,
}: {
  steg: Steg[];
  indeks: number;
  onVelg: (i: number) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-[10px]">
      <ol className="flex flex-wrap items-center gap-[6px]">
        {steg.map((s, i) => {
          const ferdig = i < indeks;
          const naa = i === indeks;
          return (
            <li key={s} className="flex items-center gap-[6px]">
              <button
                type="button"
                onClick={() => onVelg(i)}
                disabled={!ferdig}
                aria-current={naa ? "step" : undefined}
                aria-label={`${i + 1}. ${t(`vps.wizard.label_${s}`)}`}
                className={`flex h-[28px] w-[28px] items-center justify-center border-2 border-line font-body text-[13px] font-bold transition-colors ${
                  ferdig
                    ? "bg-ink text-paper hover:bg-paper hover:text-ink"
                    : naa
                      ? "bg-sun text-ink"
                      : "cursor-default bg-paper text-ink/50"
                }`}
              >
                {ferdig ? "✓" : i + 1}
              </button>
              {i < steg.length - 1 && (
                <span
                  className={`hidden h-[2px] w-[12px] sm:block ${ferdig ? "bg-line" : "bg-ash"}`}
                  aria-hidden="true"
                />
              )}
            </li>
          );
        })}
      </ol>
      <p className="font-body text-[12px] font-bold uppercase tracking-[0.1em] text-ink/70">
        {t("vps.wizard.step_of", { n: indeks + 1, total: steg.length })} ·{" "}
        {t(`vps.wizard.label_${steg[indeks] ?? "navn"}`)}
      </p>
    </div>
  );
}

function Rad({
  etikett,
  verdi,
  onEndre,
  endreTekst,
}: {
  etikett: string;
  verdi: ReactNode;
  onEndre: () => void;
  endreTekst: string;
}) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-hair px-[16px] py-[12px] last:border-b-0">
      <div className="flex min-w-0 flex-col gap-[2px]">
        <dt className="font-body text-[13px] font-light text-ink/70">{etikett}</dt>
        <dd className="font-body text-[16px] text-ink">{verdi}</dd>
      </div>
      <button
        type="button"
        onClick={onEndre}
        className="btn-quiet shrink-0 px-[8px] py-[4px] font-body text-[14px] text-ink underline underline-offset-[4px]"
      >
        {endreTekst}
      </button>
    </div>
  );
}

function Ferdig({ vps, onDone }: { vps: Vps; onDone?: () => void }) {
  const { t } = useTranslation();
  const [kopi, setKopi] = useState<"klar" | "kopiert" | "feilet">("klar");
  const kommando = vps.ssh?.command ?? "";
  return (
    <div className="anim-rise flex flex-col gap-[18px]">
      <h3 className="font-display text-[24px] font-bold leading-[1.2] text-ink">
        {t("vps.form.done", { name: vps.name, ip: vps.ip ?? "–" })}
      </h3>
      {vps.ssh && (
        // Hele feltet er knappen; den sier «Kopiert» i klartekst, og sier fra
        // hvis utklippstavla ikke er tilgjengelig (05_design_system.md).
        <button
          type="button"
          onClick={() => {
            if (!navigator.clipboard) {
              setKopi("feilet");
              return;
            }
            navigator.clipboard.writeText(kommando).then(
              () => setKopi("kopiert"),
              () => setKopi("feilet"),
            );
          }}
          className="flex items-stretch border-2 border-line text-left transition-colors hover:bg-sun-soft"
        >
          <code className="min-w-0 flex-1 truncate px-[14px] py-[12px] font-mono text-[14px] text-ink">
            {kommando}
          </code>
          <span className="flex shrink-0 items-center border-l-2 border-line px-[14px] font-body text-[14px] text-ink">
            {kopi === "kopiert"
              ? t("vps.form.copied")
              : kopi === "feilet"
                ? t("vps.wizard.copy_failed")
                : t("vps.form.copy")}
          </span>
        </button>
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
      role="radio"
      aria-checked={valgt}
      onClick={onClick}
      disabled={disabled}
      className={`border-2 border-line px-[16px] py-[12px] text-left transition-colors disabled:cursor-not-allowed disabled:opacity-35 ${
        valgt ? "bg-sun" : "hover:bg-sun-soft"
      }`}
    >
      {children}
    </button>
  );
}

function Ressurs({
  etikett,
  verdi,
  slider,
  maaler,
  forklaring,
}: {
  etikett?: string;
  verdi: string;
  slider: ReactNode;
  /** Utelates når glidebryteren alene sier alt (CPU). */
  maaler?: ReactNode;
  forklaring: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-[12px]">
      <div className="flex items-baseline justify-between gap-3">
        <span className="font-body text-[15px] text-ink">{etikett}</span>
        <span className="font-display text-[28px] font-bold leading-none text-ink">{verdi}</span>
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
