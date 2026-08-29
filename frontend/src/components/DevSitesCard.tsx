import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";

import { BranchPicker } from "@/components/BranchPicker";
import { SiteToggle } from "@/components/SiteToggle";
import { createDevSite, deployProject, listDevSites, setAccessPassword } from "@/lib/api";
import { useApiErrorMessage } from "@/lib/errors";
import type { Project } from "@/lib/database.types";

/**
 * Dev-sider for et prosjekt, og passordet foran dem.
 *
 * En dev-side er ikke et miljø i en egen tabell, men et helt ordinært prosjekt på
 * samme repo med en annen gren – se migrasjon 0013. Det er derfor kortet lenker
 * til prosjektsiden til dev-siden i stedet for å gjenskape fanene her: alt som
 * gjelder bygg, logger og miljøvariabler finnes allerede der.
 *
 * Kortet vises bare på hovedprosjekter. En dev-side har ingen egne dev-sider
 * (databasen håndhever dybde 1), og et kort som bare kunne si nei er et kort som
 * ikke skal stå der.
 */
export function DevSitesCard({ project }: { project: Project }) {
  const { t } = useTranslation();
  const errorMessage = useApiErrorMessage();
  const queryClient = useQueryClient();

  const [branch, setBranch] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);

  const devSites = useQuery({
    queryKey: ["dev-sites", project.id],
    queryFn: () => listDevSites(project.id).then((r) => r.devSites),
  });

  const create = useMutation({
    mutationFn: async () => {
      const { project: created } = await createDevSite(project.id, branch.trim(), password);
      // Bygget startes herfra og ikke i API-et: opprettelsen og utrullingen er to
      // beslutninger i backend (se `POST /dev-sites`), men fra dashboardet er det
      // én handling – man lager ikke en dev-side for å la den stå tom.
      await deployProject(created.id);
      return created;
    },
    onSuccess: async () => {
      setBranch("");
      setPassword("");
      setError(null);
      await queryClient.invalidateQueries({ queryKey: ["dev-sites", project.id] });
    },
    onError: (cause: unknown) => setError(errorMessage(cause)),
  });

  return (
    <div className="ink-card-lg anim-rise flex flex-col gap-6 p-6 md:p-8">
      <div>
        <h2 className="font-display text-[22px] font-bold text-ink">{t("dev_sites.title")}</h2>
        <span className="swoosh anim-draw mt-[6px]" aria-hidden="true" />
        <p className="mt-2 font-body text-[16px] text-ink/70">{t("dev_sites.desc")}</p>
      </div>

      {/* Eksisterende dev-sider */}
      {(devSites.data?.length ?? 0) > 0 && (
        <ul className="flex flex-col gap-3">
          {devSites.data?.map((site) => (
            <li
              key={site.id}
              className="flex flex-wrap items-center justify-between gap-3 border-2 border-hair px-[16px] py-[12px]"
            >
              <div className="flex flex-col">
                <a
                  href={`/projects/${site.id}`}
                  className="font-body text-[16px] font-medium text-ink underline decoration-sun decoration-[3px] underline-offset-[5px]"
                >
                  {site.name}
                </a>
                <span className="font-mono text-[13px] text-ink/70">
                  {t("dev_sites.from_branch", { branch: site.branch ?? "—" })}
                </span>
              </div>
              <div className="flex items-center gap-4">
                <span className="font-body text-[14px] text-ink/70">
                  {site.access_protected ? t("dev_sites.locked") : t("dev_sites.open")}
                </span>
                {/* Uten hint i lista: raden er tett, og forklaringen står på
                    dev-sidens egen side der man faktisk stopper for å lese. */}
                <SiteToggle project={site} showHint={false} />
              </div>
            </li>
          ))}
        </ul>
      )}

      {/* Ny dev-side */}
      <form
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          create.mutate();
        }}
      >
        <BranchPicker repo={project.repo_url} value={branch} onChange={setBranch} />

        <label className="flex flex-col gap-[8px]">
          <span className="font-body text-[15px] text-ink">{t("dev_sites.password")}</span>
          <input
            type="password"
            required
            minLength={8}
            autoComplete="new-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            className="field-ink h-[46px] px-[14px] font-mono text-[14px] outline-none"
          />
          <span className="font-body text-[14px] font-light text-ink/70">
            {t("dev_sites.password_hint")}
          </span>
        </label>

        {error && (
          <p
            role="alert"
            className="border-2 border-error px-[14px] py-[10px] font-body text-[15px] text-error"
          >
            {error}
          </p>
        )}

        <div className="flex justify-end">
          <button
            type="submit"
            // Grenen må være valgt. Tomt felt betyr «repoets standardgren» i
            // BranchPicker, og en dev-side på samme gren som produksjonen er ikke
            // en dev-side – det er en kopi.
            disabled={create.isPending || branch.trim() === ""}
            className="btn-ink h-[46px] px-[24px] font-display text-[15px]"
          >
            {create.isPending ? t("dev_sites.creating") : t("dev_sites.create")}
          </button>
        </div>
      </form>
    </div>
  );
}

/**
 * Passordet foran denne appen.
 *
 * Står som et eget kort fordi det gjelder alle prosjekter, ikke bare dev-sider:
 * en kundedemo eller en app som ikke er klar har samme behov. Dev-siden er bare
 * det første stedet vi trengte det.
 */
export function AccessPasswordCard({ project }: { project: Project }) {
  const { t } = useTranslation();
  const errorMessage = useApiErrorMessage();
  const queryClient = useQueryClient();
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: (value: string | null) => setAccessPassword(project.id, value),
    onSuccess: async () => {
      setPassword("");
      setError(null);
      await queryClient.invalidateQueries({ queryKey: ["project", project.id] });
      await queryClient.invalidateQueries({ queryKey: ["dev-sites"] });
    },
    onError: (cause: unknown) => setError(errorMessage(cause)),
  });

  return (
    <div className="ink-card-lg anim-rise flex flex-col gap-5 p-6 md:p-8">
      <div>
        <h2 className="font-display text-[22px] font-bold text-ink">{t("access.title")}</h2>
        <p className="mt-2 font-body text-[16px] text-ink/70">
          {project.access_protected ? t("access.state_locked") : t("access.state_open")}
        </p>
      </div>

      <form
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          save.mutate(password);
        }}
      >
        <label className="flex flex-col gap-[8px]">
          <span className="font-body text-[15px] text-ink">
            {project.access_protected ? t("access.new_password") : t("access.password")}
          </span>
          <input
            type="password"
            required
            minLength={8}
            autoComplete="new-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            className="field-ink h-[46px] px-[14px] font-mono text-[14px] outline-none"
          />
          <span className="font-body text-[14px] font-light text-ink/70">
            {t("access.username_note")}
          </span>
        </label>

        {error && (
          <p
            role="alert"
            className="border-2 border-error px-[14px] py-[10px] font-body text-[15px] text-error"
          >
            {error}
          </p>
        )}

        <div className="flex flex-wrap justify-end gap-3">
          {project.access_protected && (
            <button
              type="button"
              disabled={save.isPending}
              onClick={() => save.mutate(null)}
              className="btn-outline h-[46px] px-[20px] font-display text-[15px]"
            >
              {t("access.remove")}
            </button>
          )}
          <button
            type="submit"
            disabled={save.isPending || password.length < 8}
            className="btn-ink h-[46px] px-[24px] font-display text-[15px]"
          >
            {save.isPending ? t("access.saving") : t("access.save")}
          </button>
        </div>
      </form>
    </div>
  );
}
