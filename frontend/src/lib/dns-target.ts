import { useQuery } from "@tanstack/react-query";
import { getDnsTarget } from "@/lib/api";

/**
 * Vertsnavnet og IP-en egne domener skal peke mot (`GET /api/dns-target`).
 *
 * Endres bare når Snoat flytter server, så én henting per økt holder.
 */
export function useDnsTarget() {
  const query = useQuery({ queryKey: ["dns-target"], queryFn: getDnsTarget, staleTime: Infinity });
  return {
    host: query.data?.host ?? "…",
    /** A-record-verdien for et rotdomene. */
    ip: query.data?.ips[0] ?? "…",
  };
}
