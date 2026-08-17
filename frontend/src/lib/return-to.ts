/**
 * Hvor brukeren skal tilbake til etter en innlogging som ble krevd underveis.
 *
 * Samtykkesiden for MCP-connectoren er den ene siden i dashboardet en bruker kan
 * bli sendt til *utenfra*, av Claude, uten å være innlogget. Da må vi kunne føre
 * hen tilbake til nøyaktig den forespørselen etterpå – ellers lander hen på
 * dashboardet, og tilkoblingen hen prøvde å opprette er borte.
 *
 * Ligger i `sessionStorage` og ikke i en query-parameter fordi innlogging med
 * GitHub går ut av applikasjonen og tilbake via `/auth/callback`, der vi ikke
 * kontrollerer URL-en. Én mekanisme som virker for begge innloggingsmåter er
 * bedre enn to som virker for én hver.
 */
const KEY = "snoat.return_to";

export function rememberReturnTo(path: string): void {
  try {
    sessionStorage.setItem(KEY, path);
  } catch {
    // Privat nettlesermodus kan nekte skriving. Da mister vi returadressen, og
    // brukeren havner på dashboardet – irriterende, men ikke ødeleggende.
  }
}

/**
 * Henter og fjerner returadressen.
 *
 * Fjerningen er poenget: uten den ville *neste* innlogging i samme fane også
 * sendt brukeren til en samtykkeside hen for lengst er ferdig med.
 */
export function consumeReturnTo(): string | null {
  try {
    const value = sessionStorage.getItem(KEY);
    sessionStorage.removeItem(KEY);

    // Kun interne stier. En absolutt URL her ville gjort innloggingen vår til en
    // åpen viderekobling en angriper kunne sendt folk videre gjennom.
    if (!value || !value.startsWith("/") || value.startsWith("//")) return null;

    return value;
  } catch {
    return null;
  }
}
