import { createFileRoute, redirect } from "@tanstack/react-router";

/**
 * `/settings` har ikke noe eget innhold – den første siden er AI-tilkoblingen.
 *
 * Omdirigeringen ligger i `beforeLoad` og ikke i en `useEffect`: da skjer den
 * før noe rendres, og brukeren ser aldri en tom ramme blinke forbi.
 */
export const Route = createFileRoute("/settings/")({
  beforeLoad: () => {
    throw redirect({ to: "/settings/mcp" });
  },
});
