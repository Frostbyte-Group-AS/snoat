import { useEffect, useRef, type CSSProperties, type ReactNode } from "react";

type RevealTag = "div" | "section" | "article" | "li" | "aside";

/**
 * Toner innholdet inn når det rulles inn i bildet.
 *
 * Startilstanden ligger i CSS (`[data-reveal]` i styles.css), ikke i JSX, slik
 * at serveren kan sende ferdig markup uten å vite noe om synlighet. Når
 * elementet treffer skjermen setter observatøren `data-reveal="visible"`, og
 * overgangen tar resten.
 *
 * To ting er bevisste:
 *
 *  - **Uten JavaScript vises alt.** `__root.tsx` legger inn en `<noscript>`-regel
 *    som overstyrer starttilstanden. Ellers ville hele landingssiden vært usynlig
 *    for en leser uten JS.
 *  - **Vi slutter å se etter etter første treff.** Innhold som toner ut igjen når
 *    man ruller opp er en effekt, ikke en forbedring.
 */
export function Reveal({
  children,
  className,
  delay = 0,
  as: Tag = "div",
  id,
}: {
  children: ReactNode;
  className?: string;
  /** Millisekunder før elementet toner inn, for radvis innkomst. */
  delay?: number;
  as?: RevealTag;
  id?: string;
}) {
  const ref = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;

    // Eldre nettlesere og testmiljøer uten observatør får innholdet med én gang.
    if (typeof IntersectionObserver === "undefined") {
      element.dataset.reveal = "visible";
      return;
    }

    // Er elementet allerede synlig ved montering (over folden), skal det ikke
    // vente på en rullehendelse som kanskje aldri kommer.
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          element.dataset.reveal = "visible";
          observer.unobserve(element);
        }
      },
      { threshold: 0.08, rootMargin: "0px 0px -8% 0px" },
    );

    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  return (
    <Tag
      id={id}
      ref={ref as never}
      data-reveal=""
      className={className}
      style={{ "--anim-delay": `${delay}ms` } as CSSProperties}
    >
      {children}
    </Tag>
  );
}
