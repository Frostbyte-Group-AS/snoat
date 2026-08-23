/**
 * Avkrysningsmerket fra Figma-malen, tegnet som typografi.
 *
 * Malen bruker et ikon (`Check_fill`, 14,413 px → 22 px i 1440-skalaen): en
 * heldekkende svart skive med tegnet i hvitt. Siden plattformen ikke skal ha
 * ikoner, er skiven en `span` med bakgrunn og tegnet et vanlig tekstglyf.
 * Resultatet er identisk i vekt og størrelse, men uten ikonbibliotek.
 */
export function Mark({ on, size = 22 }: { on: boolean; size?: number }) {
  return (
    <span
      aria-hidden="true"
      className="inline-flex shrink-0 items-center justify-center rounded-full bg-ink font-body font-bold leading-none text-paper"
      style={{ width: size, height: size, fontSize: size * 0.55 }}
    >
      {on ? "✓" : "✕"}
    </span>
  );
}
