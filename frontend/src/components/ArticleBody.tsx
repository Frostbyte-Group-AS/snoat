import { Fragment, type ReactNode } from "react";

import { Link } from "@tanstack/react-router";

import { Mark } from "@/components/Mark";
import { Reveal } from "@/components/Reveal";
import type { ArticleLang, Block } from "@/content/articles";
import { ARTICLE_UI, headingId } from "@/content/articles/ui";

/**
 * Rendrer blokkene i en artikkel med klassene fra «Ink & Sun».
 *
 * Blokkene er data (`content/articles/types.ts`), ikke markdown, så det finnes
 * ingen parser å stole på og ingen `dangerouslySetInnerHTML` noe sted. Det
 * eneste som tolkes er tre inline-mønstre i teksten – se `inline()` – og de
 * blir React-noder, aldri HTML.
 *
 * Designreglene som gjelder her: ramme og ikke skygge, firkantede handlinger og
 * rundede kort, ingen ikoner (kvadratbullet og `Mark` i stedet), og gult kun som
 * markør. Kodeblokker låner terminalflata fra dashbordet, som er det ene stedet
 * i appen som følger systemets mørk/lys-innstilling.
 */

/**
 * Inline-markup: `kode`, **fet** og [lenketekst](/bane).
 *
 * Tre mønstre, ikke en markdown-dialekt. De dekker det teknisk prosa trenger –
 * et kommandonavn i mono, en uthevet ledetekst i en punktliste, og en intern
 * lenke – og de er trygge fordi hver treff blir et React-element.
 */
function inline(text: string): ReactNode {
  const parts = text.split(/(`[^`]+`|\*\*[^*]+\*\*|\[[^\]]+\]\([^)]+\))/g);

  return parts.map((part, i) => {
    if (part.startsWith("`") && part.endsWith("`") && part.length > 2) {
      return (
        <code key={i} className="bg-muted px-[5px] py-[1px] font-mono text-[0.9em]">
          {part.slice(1, -1)}
        </code>
      );
    }

    if (part.startsWith("**") && part.endsWith("**") && part.length > 4) {
      return (
        <strong key={i} className="font-normal text-ink">
          {part.slice(2, -2)}
        </strong>
      );
    }

    const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(part);
    if (link) {
      const [, label, href] = link;
      // Interne baner skrives som vanlig `<a>` og ikke som `<Link>`: `to` er
      // typet mot rutetreet og krever en literal rutebane, mens en lenke inne i
      // en artikkeltekst er en vilkårlig streng fra innholdsfila. Kostnaden er
      // en full sidelasting ved klikk – på en artikkelside er det greit.
      if (href.startsWith("/")) {
        return (
          <a key={i} href={href} className="underline underline-offset-[4px] hover:bg-sun-soft">
            {label}
          </a>
        );
      }
      return (
        <a
          key={i}
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          className="underline underline-offset-[4px] hover:bg-sun-soft"
        >
          {label}
        </a>
      );
    }

    return <Fragment key={i}>{part}</Fragment>;
  });
}

const P = "font-body text-[17px] font-light leading-[1.7] text-ink lg:text-[20px]";

function BlockView({ block, lang }: { block: Block; lang: ArticleLang }) {
  switch (block.type) {
    case "h2":
      return (
        <h2
          id={headingId(block.text)}
          className="mt-[56px] scroll-mt-[120px] font-display text-[25px] font-bold leading-[1.2] text-ink lg:text-[34px]"
        >
          {inline(block.text)}
        </h2>
      );

    case "h3":
      return (
        <h3 className="mt-[36px] font-body text-[20px] font-normal leading-[1.3] text-ink lg:text-[25px]">
          {inline(block.text)}
        </h3>
      );

    case "p":
      return <p className={`mt-[22px] ${P}`}>{inline(block.text)}</p>;

    case "list":
      // Nummerering i konturtall ville tatt 86 px per punkt; her er tallet en
      // vanlig displayvekt, og bulleten et kvadrat framfor et ikon.
      return block.ordered ? (
        <ol className="mt-[24px] flex flex-col gap-[16px]">
          {block.items.map((item, i) => (
            <li key={i} className="flex gap-[14px]">
              <span
                aria-hidden="true"
                className="mt-[2px] w-[26px] shrink-0 font-display text-[18px] font-bold tabular-nums text-ink lg:text-[21px]"
              >
                {i + 1}.
              </span>
              <span className={P}>{inline(item)}</span>
            </li>
          ))}
        </ol>
      ) : (
        <ul className="mt-[24px] flex flex-col gap-[16px]">
          {block.items.map((item, i) => (
            <li key={i} className="flex gap-[14px]">
              <span aria-hidden="true" className="mt-[12px] h-[7px] w-[7px] shrink-0 bg-ink" />
              <span className={P}>{inline(item)}</span>
            </li>
          ))}
        </ul>
      );

    case "checks":
      return (
        <ul className="stagger mt-[24px] flex flex-col gap-[14px]">
          {block.items.map((item, i) => (
            <li key={i} className="flex items-start gap-[12px]">
              <span className="mt-[3px]">
                <Mark on={item.on} size={22} />
              </span>
              <span className={P}>{inline(item.text)}</span>
            </li>
          ))}
        </ul>
      );

    case "table":
      return (
        <figure className="mt-[32px]">
          {/* Brede tabeller ruller i sin egen boks. Siden ruller aldri
              horisontalt – det er regelen som holder mobilvisningen hel. */}
          <div className="ink-card overflow-x-auto">
            <table className="w-full min-w-[520px] border-collapse text-left">
              <thead>
                <tr>
                  {block.head.map((cell, i) => (
                    <th
                      key={i}
                      scope="col"
                      className="border-b-2 border-line px-[18px] py-[14px] font-body text-[14px] font-bold uppercase tracking-[0.06em] text-ink"
                    >
                      {cell}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {block.rows.map((row, i) => (
                  <tr key={i} className={i > 0 ? "border-t border-hair" : undefined}>
                    {row.map((cell, j) => (
                      <td
                        key={j}
                        className={`px-[18px] py-[14px] font-body text-[15px] leading-[1.5] text-ink lg:text-[17px] ${
                          j === 0 ? "font-normal" : "font-light"
                        }`}
                      >
                        {inline(cell)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {block.caption && (
            <figcaption className="mt-[10px] font-body text-[14px] font-light text-ink/70">
              {block.caption}
            </figcaption>
          )}
        </figure>
      );

    case "code":
      return (
        <figure className="mt-[32px]">
          <div className="ink-card terminal-shell overflow-hidden">
            {block.caption && (
              <div className="terminal-bar px-[18px] py-[10px] font-body text-[14px]">
                {block.caption}
              </div>
            )}
            <pre className="terminal-body overflow-x-auto px-[18px] py-[16px] font-mono text-[13px] leading-[1.7] lg:text-[14px]">
              {block.lines.join("\n")}
            </pre>
          </div>
        </figure>
      );

    case "note":
      return (
        <aside className="ink-card-lg mt-[32px] px-[24px] py-[24px]">
          <span className="swoosh" aria-hidden="true" />
          {block.title && (
            <p className="mt-[12px] font-body text-[19px] font-normal text-ink lg:text-[22px]">
              {block.title}
            </p>
          )}
          <p
            className={`${block.title ? "mt-[10px]" : "mt-[14px]"} font-body text-[16px] font-light leading-[1.65] text-ink lg:text-[19px]`}
          >
            {inline(block.text)}
          </p>
        </aside>
      );

    case "faq":
      return (
        <>
          <h2
            id={headingId(ARTICLE_UI[lang].faq)}
            className="mt-[56px] scroll-mt-[120px] font-display text-[25px] font-bold leading-[1.2] text-ink lg:text-[34px]"
          >
            {ARTICLE_UI[lang].faq}
          </h2>
          <dl className="mt-[28px] flex flex-col gap-[26px]">
            {block.items.map((item, i) => (
              <div key={i}>
                <dt className="font-body text-[19px] font-normal leading-[1.3] text-ink lg:text-[23px]">
                  {item.q}
                </dt>
                <dd className={`mt-[10px] ${P}`}>{inline(item.a)}</dd>
              </div>
            ))}
          </dl>
        </>
      );

    case "cta":
      return (
        <aside className="ink-card-lg mt-[48px] flex flex-col gap-[18px] px-[26px] py-[30px]">
          <h2 className="font-display text-[24px] font-bold leading-[1.2] text-ink lg:text-[30px]">
            {block.title}
          </h2>
          {block.text && (
            <p className="font-body text-[16px] font-light leading-[1.6] text-ink lg:text-[19px]">
              {block.text}
            </p>
          )}
          <Link
            to="/login"
            className="btn-ink self-start px-[28px] py-[15px] font-display text-[16px] font-bold"
          >
            {block.label}
          </Link>
        </aside>
      );
  }
}

export function ArticleBody({ blocks, lang }: { blocks: Block[]; lang: ArticleLang }) {
  return (
    <>
      {blocks.map((block, i) => {
        // Overskriftene bærer rytmen i teksten, så de toner inn radvis mens man
        // ruller. Avsnitt gjør det ikke – da ville brødteksten blinket.
        const animated = block.type === "table" || block.type === "note" || block.type === "cta";
        return animated ? (
          <Reveal key={i} as="div">
            <BlockView block={block} lang={lang} />
          </Reveal>
        ) : (
          <BlockView key={i} block={block} lang={lang} />
        );
      })}
    </>
  );
}
