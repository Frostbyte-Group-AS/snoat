import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";

import { createRedirect, updateRedirect, type Redirect } from "@/lib/api";
import { snoatServerIp } from "@/lib/platform";

/**
 * Skjemaet for en omdirigering – både «Nytt prosjekt» → Omdirigering og «Endre»
 * på kortet i dashboardet.
 *
 * Domenene skrives ett per linje (eller med komma). Backend normaliserer dem
 * (`https://www.Gammelt.no/` → `gammelt.no`) og legger på `www.` selv, så feltet
 * trenger ikke være strengt – det som betyr noe er at kunden ser hvilke records
 * som må settes, og det står under.
 */
export function RedirectForm({
  redirect,
  onDone,
  onBack,
}: {
  redirect?: Redirect;
  onDone: () => void;
  onBack?: () => void;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [domains, setDomains] = useState(redirect?.domains.join("\n") ?? "");
  const [targetUrl, setTargetUrl] = useState(redirect?.target_url ?? "https://");
  const [statusCode, setStatusCode] = useState<Redirect["status_code"]>(
    redirect?.status_code ?? 301,
  );
  const [preservePath, setPreservePath] = useState(redirect?.preserve_path ?? false);
  const [name, setName] = useState(redirect?.name ?? "");

  const domainList = domains
    .split(/[\s,]+/)
    .map((domain) => domain.trim())
    .filter(Boolean);

  const save = useMutation({
    mutationFn: async () => {
      const input = {
        name: name.trim() || null,
        targetUrl: targetUrl.trim(),
        domains: domainList,
        statusCode,
        preservePath,
      };
      return redirect ? await updateRedirect(redirect.id, input) : await createRedirect(input);
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["redirects"] });
      onDone();
    },
  });

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    save.mutate();
  };

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-[18px]">
      <p className="font-body text-[16px] font-light leading-[1.5] text-ink">
        {t("redirects.form.desc")}
      </p>

      <label className="flex flex-col gap-[8px]">
        <span className="font-body text-[15px] font-normal text-ink">
          {t("redirects.form.domains")}
        </span>
        <textarea
          required
          rows={3}
          value={domains}
          onChange={(event) => setDomains(event.target.value)}
          placeholder={"gammelt-domene.no\ngammelt-domene.com"}
          className="field-ink px-[14px] py-[10px] font-mono text-[14px] outline-none placeholder:text-ink/40"
        />
        <span className="font-body text-[14px] font-light text-ink/70">
          {t("redirects.form.domains_hint")}
        </span>
      </label>

      <label className="flex flex-col gap-[8px]">
        <span className="font-body text-[15px] font-normal text-ink">
          {t("redirects.form.target")}
        </span>
        <input
          type="url"
          required
          value={targetUrl}
          onChange={(event) => setTargetUrl(event.target.value)}
          placeholder="https://nytt-domene.no/side"
          className="field-ink h-[46px] px-[14px] font-mono text-[14px] outline-none placeholder:text-ink/40"
        />
      </label>

      <div className="flex flex-wrap items-center gap-x-[24px] gap-y-[12px]">
        <label className="flex items-center gap-[10px]">
          <span className="font-body text-[15px] font-normal text-ink">
            {t("redirects.form.status")}
          </span>
          <select
            value={statusCode}
            onChange={(event) =>
              setStatusCode(Number(event.target.value) as Redirect["status_code"])
            }
            className="field-ink h-[40px] px-[10px] font-body text-[15px] outline-none"
          >
            <option value={301}>{t("redirects.form.status_301")}</option>
            <option value={302}>{t("redirects.form.status_302")}</option>
            <option value={308}>308</option>
            <option value={307}>307</option>
          </select>
        </label>

        <label className="flex items-center gap-[10px]">
          <input
            type="checkbox"
            checked={preservePath}
            onChange={(event) => setPreservePath(event.target.checked)}
            className="h-[18px] w-[18px] accent-ink"
          />
          <span className="font-body text-[15px] font-normal text-ink">
            {t("redirects.form.preserve_path")}
          </span>
        </label>
      </div>

      <label className="flex flex-col gap-[8px]">
        <span className="font-body text-[15px] font-normal text-ink">
          {t("redirects.form.name")}
        </span>
        <input
          type="text"
          value={name}
          maxLength={100}
          onChange={(event) => setName(event.target.value)}
          placeholder={domainList[0] ?? ""}
          className="field-ink h-[46px] px-[14px] font-body text-[15px] outline-none placeholder:text-ink/40"
        />
      </label>

      <div className="border-2 border-line px-[14px] py-[12px] font-body text-[14px] font-light leading-[1.5] text-ink">
        <p>{t("redirects.form.dns_hint")}</p>
        <code className="mt-[6px] block font-mono text-[13px] text-ink">
          A @ {snoatServerIp}
          <br />A www {snoatServerIp}
        </code>
      </div>

      {save.isError && (
        <p
          role="alert"
          className="border-2 border-error px-[14px] py-[10px] font-body text-[15px] text-error"
        >
          {save.error.message}
        </p>
      )}

      <div className="mt-[8px] flex justify-end gap-[12px]">
        {onBack && (
          <button
            type="button"
            onClick={onBack}
            className="btn-outline mr-auto h-[46px] px-[20px] font-display text-[15px]"
          >
            {t("vps.wizard.back")}
          </button>
        )}
        <button
          type="button"
          onClick={onDone}
          className="btn-outline h-[46px] px-[20px] font-display text-[15px]"
        >
          {t("dashboard.new_project_modal.cancel")}
        </button>
        <button
          type="submit"
          disabled={save.isPending}
          className="btn-ink h-[46px] px-[24px] font-display text-[15px]"
        >
          {save.isPending
            ? t("redirects.form.saving")
            : redirect
              ? t("redirects.form.save")
              : t("redirects.form.create")}
        </button>
      </div>
    </form>
  );
}
