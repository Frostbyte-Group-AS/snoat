import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";

import { deployProject, stopProject } from "@/lib/api";
import { useApiErrorMessage } from "@/lib/errors";
import type { Project } from "@/lib/database.types";

/**
 * Av/på-bryteren for en app.
 *
 * ## Hva «av» og «på» faktisk betyr
 *
 * **Av** er `POST /api/projects/:id/stop`: containeren fjernes, Caddy-ruten
 * slettes og `stopped_at` settes. Adressen svarer ikke lenger, og appen koster
 * ingen RAM. En stoppet app teller heller ikke mot plangrensen for kjørende
 * apper.
 *
 * **På** er `POST /api/projects/:id/deploy`, altså et **nytt bygg**. Snoat
 * beholder ikke containeren over et stopp – det er hele poenget med å stoppe –
 * så veien tilbake går gjennom pipelinen. Det er samme oppførsel som
 * «Start»-knappen alltid har hatt, men en bryter later som det er umiddelbart,
 * og derfor sier etiketten under bryteren det høyt.
 *
 * ## Hvorfor en `button` med `role="switch"` og ikke en checkbox
 *
 * En checkbox betyr «dette blir sant når jeg lagrer». Her skjer det med én gang,
 * og det finnes ingen lagreknapp. `role="switch"` med `aria-checked` er nettopp
 * skillet, og skjermlesere leser det som «på/av» framfor «avkrysset».
 *
 * Radix-`Switch`-en i `components/ui/switch.tsx` er fra det gamle designsystemet
 * (runde spor, `--primary`) og brukes ikke i Snoat – se
 * `CONTEXT_FOR_AI/05_design_system.md`.
 */
export function SiteToggle({
  project,
  /** Sant mens et bygg pågår, slik at bryteren ikke kan trykkes midt i det. */
  busy = false,
  /** Vis etiketten under bryteren. Av i tette lister. */
  showHint = true,
}: {
  project: Project;
  busy?: boolean;
  showHint?: boolean;
}) {
  const { t } = useTranslation();
  const errorMessage = useApiErrorMessage();
  const queryClient = useQueryClient();

  const isOn = !project.stopped_at;

  const toggle = useMutation({
    mutationFn: async () => {
      if (isOn) {
        await stopProject(project.id);
        return;
      }
      await deployProject(project.id);
    },
    onSettled: async () => {
      // Både prosjektraden og lista over dev-sider bærer `stopped_at`, og
      // bryteren kan stå i begge. `onSettled` og ikke `onSuccess`: feiler kallet,
      // er det nettopp da vi vil lese tilstanden på nytt framfor å stole på den
      // vi trodde vi hadde.
      await queryClient.invalidateQueries({ queryKey: ["project", project.id] });
      await queryClient.invalidateQueries({ queryKey: ["dev-sites"] });
      await queryClient.invalidateQueries({ queryKey: ["projects"] });
    },
  });

  const pending = toggle.isPending || busy;

  return (
    <div className="flex flex-col items-end gap-[6px]">
      <div className="flex items-center gap-[10px]">
        <span className="font-body text-[15px] text-ink">
          {isOn ? t("site_toggle.on") : t("site_toggle.off")}
        </span>
        <button
          type="button"
          role="switch"
          aria-checked={isOn}
          aria-label={isOn ? t("site_toggle.turn_off") : t("site_toggle.turn_on")}
          data-busy={pending ? "true" : "false"}
          disabled={pending}
          onClick={() => toggle.mutate()}
          className="ink-switch"
        >
          <span className="ink-switch-thumb" aria-hidden="true" />
        </button>
      </div>

      {showHint && (
        <span className="text-right font-body text-[14px] font-light text-ink/70">
          {pending
            ? isOn
              ? t("site_toggle.turning_off")
              : t("site_toggle.turning_on")
            : isOn
              ? t("site_toggle.hint_on")
              : t("site_toggle.hint_off")}
        </span>
      )}

      {toggle.isError && (
        <span role="alert" className="text-right font-body text-[14px] text-error">
          {errorMessage(toggle.error)}
        </span>
      )}
    </div>
  );
}
