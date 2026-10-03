import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";

import {
  ApiError,
  createVps,
  deleteVps,
  getVpsAccess,
  listVps,
  setVpsReservedRam,
  vpsPower,
  type Vps,
  type VpsRamPool,
} from "@/lib/api";

/**
 * VPS-er – kun for eierkontoen.
 *
 * Fanen vises bare når `/api/vps/tilgang` sier `eier: true`, men det er backend
 * som håndhever grensen: alle andre kall under `/api/vps` svarer 403 for en vanlig
 * konto. Samme funksjoner finnes som MCP-verktøy (`snoat_vps_*`).
 */
export const Route = createFileRoute("/settings/vps")({
  head: () => ({
    meta: [{ title: "VPS-er — Snoat" }, { name: "robots", content: "noindex" }],
  }),
  component: VpsPage,
});

const gb = (mb: number | null | undefined) => (mb === null || mb === undefined ? "–" : `${(mb / 1024).toFixed(1)} GB`);

function feiltekst(error: unknown): string {
  return error instanceof ApiError || error instanceof Error ? error.message : String(error);
}

function VpsPage() {
  const { t } = useTranslation();
  const access = useQuery({ queryKey: ["vps-access"], queryFn: getVpsAccess });
  const list = useQuery({
    queryKey: ["vps"],
    queryFn: listVps,
    enabled: Boolean(access.data?.konfigurert),
    refetchInterval: 15_000,
  });

  if (access.isLoading) return <p className="font-body text-[16px] text-ink/70">{t("vps.loading")}</p>;
  if (!access.data?.eier) return null;
  if (!access.data.konfigurert) {
    return <p className="border-2 border-hair px-[16px] py-[12px] font-body text-[15px] text-ink/70">{t("vps.not_configured")}</p>;
  }

  return (
    <div className="flex flex-col gap-[31px]">
      <section className="ink-card-lg anim-rise flex flex-col gap-3 px-[30px] py-[32px]">
        <span className="w-fit bg-sun px-[8px] py-[2px] font-body text-[12px] font-bold uppercase tracking-[0.1em] text-ink">
          {t("vps.eyebrow")}
        </span>
        <h2 className="font-display text-[28px] font-bold text-ink">{t("vps.title")}</h2>
        <p className="max-w-2xl font-body text-[16px] text-ink/70">{t("vps.intro")}</p>
      </section>

      {list.error && <p className="border-2 border-line px-[16px] py-[12px] font-body text-[15px] text-ink">{feiltekst(list.error)}</p>}
      {list.data && <RamCard ram={list.data.ram} />}
      <VpsListCard vps={list.data?.vps} loading={list.isLoading} />
      {list.data && <NewVpsCard templates={list.data.templates} />}
    </div>
  );
}

function RamCard({ ram }: { ram: VpsRamPool }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [reservertGb, setReservertGb] = useState(String(Math.round(ram.reservertMb / 1024)));
  const save = useMutation({
    mutationFn: () => setVpsReservedRam(Math.round(Number(reservertGb) * 1024)),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["vps"] }),
  });
  const andel = ram.takMb > 0 ? Math.min(ram.iBrukMb / ram.takMb, 1) : 0;

  return (
    <section className="ink-card-lg flex flex-col gap-5 px-[30px] py-[28px]">
      <h3 className="font-display text-[22px] font-bold text-ink">{t("vps.ram_title")}</h3>
      <dl className="grid grid-cols-2 gap-4 font-body text-[15px] sm:grid-cols-4">
        {[
          [t("vps.ram_total"), gb(ram.totalMb)],
          [t("vps.ram_reserved"), gb(ram.reservertMb)],
          [t("vps.ram_cap"), gb(ram.takMb)],
          [t("vps.ram_used"), gb(ram.iBrukMb)],
        ].map(([label, value]) => (
          <div key={label} className="flex flex-col gap-1">
            <dt className="text-ink/60">{label}</dt>
            <dd className="font-bold text-ink">{value}</dd>
          </div>
        ))}
      </dl>
      <div className="h-3 w-full border-2 border-line" aria-hidden="true">
        <div className="h-full bg-ink" style={{ width: `${andel * 100}%` }} />
      </div>
      <form
        className="flex flex-col gap-3 sm:flex-row sm:items-end"
        onSubmit={(event: FormEvent) => {
          event.preventDefault();
          save.mutate();
        }}
      >
        <label className="flex flex-col gap-2 font-body text-[15px] font-bold text-ink">
          {t("vps.ram_reserved_label")}
          <input
            type="number"
            min={8}
            value={reservertGb}
            onChange={(event) => setReservertGb(event.target.value)}
            className="field-ink w-[160px] px-[14px] py-[10px] font-mono text-[15px] outline-none"
          />
        </label>
        <button
          type="submit"
          disabled={save.isPending}
          className="border-2 border-line bg-ink px-[18px] py-[10px] font-body text-[15px] font-bold text-paper disabled:opacity-60"
        >
          {t("vps.ram_save")}
        </button>
      </form>
      {save.isSuccess && <p className="font-body text-[14px] text-ink/70">{t("vps.ram_saved")}</p>}
      {save.error && <p className="font-body text-[14px] text-ink">{feiltekst(save.error)}</p>}
    </section>
  );
}

function VpsListCard({ vps, loading }: { vps: Vps[] | undefined; loading: boolean }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [feil, setFeil] = useState<string | null>(null);
  const power = useMutation({
    mutationFn: ({ vmid, action }: { vmid: number; action: "start" | "shutdown" | "reboot" }) => vpsPower(vmid, action),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["vps"] }),
    onError: (error) => setFeil(feiltekst(error)),
  });
  const remove = useMutation({
    mutationFn: ({ vmid, name }: { vmid: number; name: string }) => deleteVps(vmid, name),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["vps"] }),
    onError: (error) => setFeil(feiltekst(error)),
  });

  return (
    <section className="ink-card-lg flex flex-col gap-4 px-[30px] py-[28px]">
      <h3 className="font-display text-[22px] font-bold text-ink">{t("vps.list_title")}</h3>
      {feil && <p className="font-body text-[14px] text-ink">{feil}</p>}
      {loading && <p className="font-body text-[15px] text-ink/70">{t("vps.loading")}</p>}
      {vps && vps.length === 0 && <p className="font-body text-[15px] text-ink/70">{t("vps.empty")}</p>}
      <ul className="flex flex-col gap-3">
        {vps?.map((v) => (
          <li key={v.vmid} className="flex flex-col gap-3 border-2 border-line px-[18px] py-[14px] lg:flex-row lg:items-center lg:justify-between">
            <div className="flex flex-col gap-1 font-body text-[15px] text-ink">
              <span className="font-bold">
                {v.name} <span className="font-normal text-ink/60">#{v.vmid} · {v.status}</span>
              </span>
              <span className="text-ink/70">
                {t("vps.ip")} {v.ip ?? "–"} · {v.cores ?? "–"} CPU · {t("vps.memory")} {gb(v.memoryUsedMb)} /{" "}
                {v.memoryMaxMb !== null && v.memoryMaxMb < 200 * 1024 ? gb(v.memoryMaxMb) : t("vps.no_cap")}
                {v.memoryMinMb > 0 ? ` (min ${gb(v.memoryMinMb)})` : ""} · disk {v.diskUsedGb ?? "–"}/{v.diskGb ?? "–"} GB
              </span>
              {v.ssh && <code className="w-fit bg-paper font-mono text-[14px] text-ink">{v.ssh.command}</code>}
            </div>
            <div className="flex flex-wrap gap-2">
              {v.status === "running" ? (
                <>
                  <ActionButton label={t("vps.reboot")} onClick={() => power.mutate({ vmid: v.vmid, action: "reboot" })} disabled={power.isPending} />
                  <ActionButton label={t("vps.shutdown")} onClick={() => power.mutate({ vmid: v.vmid, action: "shutdown" })} disabled={power.isPending} />
                </>
              ) : (
                <ActionButton label={t("vps.start")} onClick={() => power.mutate({ vmid: v.vmid, action: "start" })} disabled={power.isPending} />
              )}
              <ActionButton
                label={t("vps.delete")}
                disabled={remove.isPending}
                onClick={() => {
                  const svar = window.prompt(`${t("vps.delete_confirm")} ${v.name}`);
                  if (svar !== null) remove.mutate({ vmid: v.vmid, name: svar });
                }}
              />
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

function ActionButton({ label, onClick, disabled }: { label: string; onClick: () => void; disabled: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="border-2 border-line px-[14px] py-[8px] font-body text-[14px] text-ink transition-colors hover:bg-sun disabled:opacity-60"
    >
      {label}
    </button>
  );
}

function NewVpsCard({ templates }: { templates: string[] }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [form, setForm] = useState({ name: "", template: templates[0] ?? "debian-12", cores: "2", diskGb: "20", maxGb: "", minGb: "0", keys: "" });
  const set = (key: keyof typeof form) => (event: { target: { value: string } }) => setForm({ ...form, [key]: event.target.value });
  const create = useMutation({
    mutationFn: () =>
      createVps({
        name: form.name.trim(),
        template: form.template,
        cores: Number(form.cores),
        diskGb: Number(form.diskGb),
        memoryMaxMb: form.maxGb.trim() ? Math.round(Number(form.maxGb) * 1024) : undefined,
        memoryMinMb: Math.round(Number(form.minGb || "0") * 1024),
        sshPublicKeys: form.keys.split("\n").map((k) => k.trim()).filter(Boolean),
      }),
    onSuccess: () => {
      setForm({ ...form, name: "", keys: "" });
      void queryClient.invalidateQueries({ queryKey: ["vps"] });
    },
  });

  const field = "field-ink w-full px-[14px] py-[10px] font-mono text-[15px] outline-none";
  const label = "flex flex-col gap-2 font-body text-[15px] font-bold text-ink";

  return (
    <section className="ink-card-lg flex flex-col gap-5 px-[30px] py-[28px]">
      <h3 className="font-display text-[22px] font-bold text-ink">{t("vps.new_title")}</h3>
      <form
        className="grid gap-4 sm:grid-cols-2"
        onSubmit={(event: FormEvent) => {
          event.preventDefault();
          create.mutate();
        }}
      >
        <label className={label}>
          {t("vps.name")}
          <input required pattern="[a-z][a-z0-9-]{0,38}[a-z0-9]" value={form.name} onChange={set("name")} className={field} />
        </label>
        <label className={label}>
          {t("vps.template")}
          <select value={form.template} onChange={set("template")} className={field}>
            {templates.map((tpl) => (
              <option key={tpl} value={tpl}>
                {tpl}
              </option>
            ))}
          </select>
        </label>
        <label className={label}>
          {t("vps.cores")}
          <input type="number" min={1} max={12} value={form.cores} onChange={set("cores")} className={field} />
        </label>
        <label className={label}>
          {t("vps.disk")}
          <input type="number" min={4} max={300} value={form.diskGb} onChange={set("diskGb")} className={field} />
        </label>
        <label className={label}>
          {t("vps.max_ram")}
          <input type="number" min={0.25} step={0.25} value={form.maxGb} onChange={set("maxGb")} className={field} />
        </label>
        <label className={label}>
          {t("vps.min_ram")}
          <input type="number" min={0} step={0.25} value={form.minGb} onChange={set("minGb")} className={field} />
        </label>
        <label className={`${label} sm:col-span-2`}>
          {t("vps.ssh_keys")}
          <textarea rows={3} value={form.keys} onChange={set("keys")} className={field} />
        </label>
        <div className="flex flex-col gap-2 sm:col-span-2">
          <button
            type="submit"
            disabled={create.isPending}
            className="w-fit border-2 border-line bg-ink px-[18px] py-[10px] font-body text-[15px] font-bold text-paper disabled:opacity-60"
          >
            {create.isPending ? t("vps.creating") : t("vps.create")}
          </button>
          {create.error && <p className="font-body text-[14px] text-ink">{feiltekst(create.error)}</p>}
          {create.data?.vps.ssh && (
            <code className="w-fit font-mono text-[14px] text-ink">{create.data.vps.ssh.command}</code>
          )}
        </div>
      </form>
    </section>
  );
}
