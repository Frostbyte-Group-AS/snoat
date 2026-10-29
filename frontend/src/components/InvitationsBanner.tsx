import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";

import { getIncomingInvitations } from "@/lib/api";

/**
 * «Du er invitert til …» øverst på dashboardet.
 *
 * Dette er stedet en ny bruker faktisk lander. Lenken i invitasjons-e-posten
 * fører til `/invite/<id>`, men for den som må registrere seg først, går veien
 * via bekreftelses-e-posten – og den åpnes gjerne i en ny fane, der
 * returadressen er borte. Uten varselet her ville invitasjonen bare ligget og
 * ventet på en side ingen visste om.
 *
 * Tegner ingenting når det ikke er noe å si, heller ikke mens den laster.
 */
export function InvitationsBanner() {
  const { t } = useTranslation();

  const incoming = useQuery({
    queryKey: ["team-incoming"],
    queryFn: async () => (await getIncomingInvitations()).invitations,
    staleTime: 60_000,
  });

  const invitations = incoming.data ?? [];
  if (invitations.length === 0) return null;

  return (
    <div role="status" className="anim-rise mb-[36px] flex flex-col gap-[10px]">
      {invitations.map((invitation) => (
        <div
          key={invitation.id}
          className="flex flex-col justify-between gap-3 border-2 border-line bg-sun px-[18px] py-[14px] sm:flex-row sm:items-center"
        >
          <p className="font-body text-[16px] font-normal text-ink">
            {t("team.banner_invited", { project: invitation.project.name })}
          </p>
          <Link
            to="/invite/$invitationId"
            params={{ invitationId: invitation.id }}
            className="btn-ink shrink-0 self-start px-[18px] py-[9px] font-body text-[15px] sm:self-auto"
          >
            {t("team.banner_open")}
          </Link>
        </div>
      ))}
    </div>
  );
}
