/**
 * Å plukke unntak ut av en bolk stderr.
 *
 * stderr er ikke et feillogg-felt. Rammeverk skriver oppstartsbanner, advarsler
 * om utdaterte pakker og fremdriftsindikatorer dit. Denne modulen plukker ut det
 * som faktisk har form som et unntak og forkaster resten.
 *
 * Den bommer med vilje i én retning: en app som logger feilene sine i et format
 * vi ikke kjenner, blir ikke fanget. Motsatt vei – et feilverktøy som roper om
 * hver `npm WARN deprecated` – blir slått av innen en uke, og da fanger det
 * ingenting i det hele tatt.
 *
 * Uten dependencies, slik at testen kan importere modulen uten å dra inn config,
 * Supabase-klienten eller Docker.
 */

/** Første linje i et unntak: «TypeError: ...», «Error: ...», «Uncaught ...». */
const EXCEPTION_HEAD =
  /^(?:\s*)((?:Uncaught\s+)?(?:[A-Z][A-Za-z0-9_]*(?:Error|Exception)|Error|Exception|panic|Traceback \(most recent call last\))\b.*)$/;

/** En stack-ramme: «    at foo (/app/x.js:12:3)», «  File "x.py", line 12». */
const STACK_FRAME = /^\s+(?:at\s|File\s"|\tat\s)/;

/** Fil og linje ut av den øverste ramma som peker inn i appens egen kode. */
const FRAME_LOCATION = /\(?((?:\/|\.\/|[A-Za-z]:\\)[^\s():]+):(\d+)(?::(\d+))?\)?/;

export interface ParsedException {
  message: string;
  file: string | null;
  line: number | null;
  col: number | null;
  stack: string;
}

/**
 * Docker prefikser hver linje med et RFC3339-tidsstempel når `timestamps: true`.
 * Vi ber om dem for å vite hvor langt vi har lest, men de skal ikke være med i
 * stacktracen – og de ville ødelagt fingerprinten, siden hvert tidsstempel er
 * unikt og hver forekomst dermed ville blitt sin egen gruppe.
 */
export function stripDockerPrefix(line: string): string {
  return line.replace(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z?\s?/, "");
}

export function parseStderr(text: string): ParsedException[] {
  const lines = text.split("\n");
  const found: ParsedException[] = [];

  for (let i = 0; i < lines.length; i += 1) {
    const line = stripDockerPrefix(lines[i] ?? "");
    const head = EXCEPTION_HEAD.exec(line);
    if (!head) continue;

    // Rammene som hører til dette unntaket. Vi stopper ved første linje som ikke
    // er en ramme – da er unntaket over og noe annet har begynt.
    const frames: string[] = [];
    let j = i + 1;
    while (j < lines.length && frames.length < 30) {
      const next = stripDockerPrefix(lines[j] ?? "");
      if (!STACK_FRAME.test(next)) break;
      frames.push(next);
      j += 1;
    }

    // En «feil» uten en eneste ramme er som oftest en app som logger ordet Error
    // i en helt vanlig melding. For å få få falske positiver krever vi minst én
    // ramme før vi tror på den.
    if (frames.length === 0) {
      i = j - 1;
      continue;
    }

    // Første ramme som peker på en fil utenfor node_modules er den mest
    // spesifikke. Dypere rammer er rammeverkskode, og å gruppere på dem ville
    // slått sammen feil som ikke har noe med hverandre å gjøre – alle feil som
    // passerer gjennom Express' router ville blitt én gruppe.
    let file: string | null = null;
    let lineNo: number | null = null;
    let col: number | null = null;

    for (const frame of frames) {
      const location = FRAME_LOCATION.exec(frame);
      if (!location) continue;
      if (location[1]?.includes("node_modules")) continue;
      file = location[1] ?? null;
      lineNo = location[2] ? Number(location[2]) : null;
      col = location[3] ? Number(location[3]) : null;
      break;
    }

    found.push({
      message: (head[1] ?? "").trim().slice(0, 500),
      file,
      line: lineNo,
      col,
      stack: [line, ...frames].join("\n").slice(0, 8000),
    });

    i = j - 1;
  }

  return found;
}
