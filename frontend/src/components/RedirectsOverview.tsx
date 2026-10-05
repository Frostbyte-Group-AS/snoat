import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { RedirectForm } from "@/components/RedirectForm";
import { deleteRedirect, getRedirectStatus, listRedirects, type Redirect } from "@/lib/api";

/**
 * Omdirigeringene på dashboardet, under prosjektene.
 *
 * Et kort per omdirigering: domenene, hvor de sender folk, og om alle domenene
 * faktisk svarer (DNS, rute og sertifikat – samme måling som DNS-fanen for et
 * prosjekt). Vises ikke før kontoen har minst én.
 */
export function RedirectsOverview() {
  const { t } = useTranslation();
  const list = useQuery({ queryKey: ["redirects"], queryFn: listRedirects });
  const redirects = list.data?.redirects ?? [];
  if (redirects.length === 0) return null;

  return (
    <section className="mt-[56px]">
      <h2 className="font-display text-[26px] font-bold text-ink">
        {t("redirects.overview_title")}
      </h2>
      <span className="swoosh mt-[6px] mb-[24px]" aria-hidden="true" />
      <div className="stagger grid grid-cols-1 gap-[31px] md:grid-cols-2 lg:grid-cols-3">
        {redirects.map((redirect) => (
          <RedirectCard key={redirect.id} redirect={redirect} />
        ))}
      </div>
    </section>
  );
}

function RedirectCard({ redirect }: { redirect: Redirect }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);

  // DNS-oppslag og TLS-handshake per domene – ikke noe å gjøre hvert sekund.
  const status = useQuery({
    queryKey: ["redirect-status", redirect.id, redirect.updated_at],
    queryFn: () => getRedirectStatus(redirect.id),
    staleTime: 60_000,
  });

  const remove = useMutation({
    mutationFn: () => deleteRedirect(redirect.id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["redirects"] }),
  });

  const notReady = status.data?.domains.filter((domain) => !domain.ready) ?? [];

  return (
    <article className="ink-card flex min-w-0 flex-col gap-[14px] px-[23px] py-[25px]">
      <div className="flex items-center justify-between gap-3">
        <h3 className="truncate font-body text-[20px] font-normal text-ink">{redirect.name}</h3>
        <span
          className={`shrink-0 border-2 border-line px-[8px] py-[2px] font-body text-[12px] font-bold uppercase tracking-[0.08em] ${
            status.data?.ready ? "bg-ink text-paper" : "bg-ash text-ink"
          }`}
        >
          {status.isPending
            ? t("redirects.status_checking")
            : status.data?.ready
              ? t("redirects.status_ready")
              : t("redirects.status_pending")}
        </span>
      </div>

      <ul className="flex flex-col gap-[2px] font-mono text-[13px] text-ink">
        {redirect.domains.map((domain) => (
          <li key={domain} className="truncate">
            {domain}
          </li>
        ))}
      </ul>

      <p className="break-all font-body text-[14px] font-light text-ink/70">
        {redirect.status_code} → {redirect.target_url}
        {redirect.preserve_path ? ` ${t("redirects.keeps_path")}` : ""}
      </p>

      {notReady.length > 0 && (
        <ul className="flex flex-col gap-[4px] font-body text-[13px] font-light text-ink/70">
          {notReady.map((domain) => (
            <li key={domain.domain}>
              <span className="font-mono">{domain.domain}</span>:{" "}
              {domain.dns.state !== "ok"
                ? domain.dns.detail
                : domain.route.state !== "ok"
                  ? domain.route.detail
                  : domain.certificate.detail}
            </li>
          ))}
        </ul>
      )}

      {remove.isError && (
        <p role="alert" className="font-body text-[14px] text-error">
          {remove.error.message}
        </p>
      )}

      <hr className="hairline mt-auto" />

      <div className="flex justify-end gap-[16px] font-body text-[14px]">
        <button
          type="button"
          onClick={() => setEditing(true)}
          className="text-ink underline-offset-4 hover:underline"
        >
          {t("redirects.edit")}
        </button>
        <button
          type="button"
          disabled={remove.isPending}
          onClick={() => {
            if (
              window.confirm(
                t("redirects.delete_confirm", { domains: redirect.domains.join(", ") }),
              )
            ) {
              remove.mutate();
            }
          }}
          className="text-error underline-offset-4 hover:underline"
        >
          {t("redirects.delete")}
        </button>
      </div>

      {editing && (
        <div
          className="anim-fade fixed inset-0 z-50 flex items-center justify-center bg-ink/40 px-5"
          role="dialog"
          aria-modal="true"
          onClick={() => setEditing(false)}
        >
          <div
            className="ink-card-lg anim-pop max-h-[calc(100dvh-40px)] w-full max-w-[560px] overflow-y-auto px-[30px] py-[32px]"
            onClick={(event) => event.stopPropagation()}
          >
            <h2 className="font-display text-[28px] font-bold text-ink">
              {t("redirects.edit_title")}
            </h2>
            <span className="swoosh anim-draw mt-[6px] mb-[18px]" aria-hidden="true" />
            <RedirectForm redirect={redirect} onDone={() => setEditing(false)} />
          </div>
        </div>
      )}
    </article>
  );
}
