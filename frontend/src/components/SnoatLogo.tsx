/**
 * Snoat-merket i «Ink & Sun»-uttrykket.
 *
 * Figma-referansen (node 0:1686) er et heldekkende svart merke på 23,419 px i
 * et 937-artboard — altså 36 px i 1440-skalaen — med ordmerket i Helvetica Bold
 * 31 px og 19 px mellomrom. Vi beholder Snoats heksagon som identitet, men
 * bytter den tynne konturstreken mot den fylte svarte flaten designet bruker.
 */
export function SnoatLogo({
  className,
  size = 36,
  showWordmark = true,
}: {
  className?: string;
  size?: number;
  showWordmark?: boolean;
}) {
  // Ordmerket og mellomrommet følger merket, slik at logoen krymper i ett stykke.
  const wordSize = Math.round(size * 0.86);
  const gap = Math.round(size * 0.53);

  return (
    <span className={`inline-flex items-center ${className ?? ""}`} style={{ gap: `${gap}px` }}>
      <svg
        viewBox="0 0 80 90"
        aria-hidden="true"
        style={{ width: size, height: size }}
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
      >
        <polygon points="40,2 77,23.5 77,66.5 40,88 3,66.5 3,23.5" fill="currentColor" />
        <path
          d="M 55,31 L 31,31 L 31,45 L 49,45 L 49,59 L 25,59"
          fill="none"
          stroke="#ffffff"
          strokeWidth="6"
          strokeLinecap="square"
          strokeLinejoin="miter"
        />
      </svg>
      {showWordmark && (
        <span
          className="font-display font-bold leading-none tracking-[-0.01em]"
          style={{ fontSize: `${wordSize}px` }}
        >
          Snoat
        </span>
      )}
    </span>
  );
}
