/**
 * Where what people say goes on a team's rug. Pure geometry, like the rest of the room.
 *
 * A bubble sits over its speaker's own desk with its tail down at them, and grows upwards. It never lies on a face,
 * a name, the rug's edge or someone else's words: each one is given the most of its sentence that fits where it is,
 * looking at what is really around that seat. On a small or crowded rug that is fewer words; where not even a few
 * letters fit, three dots; where not even those, nothing: the lit screen still says someone is at work, and the whole
 * sentence is one click away.
 */
import type { Rect } from './layout.ts';
import { wrap } from './placement.ts';

/**
 * A bubble of one line is `h` tall, and `line` taller for every line after it. It ends `gap` above its speaker's
 * head, where its tail points. A letter is `letter` wide and the words have `pad` around them.
 */
export const BUBBLE = { h: 21, line: 13, gap: 5, letter: 6.2, pad: 22 };
/** A bubble narrower than this many letters says nothing worth reading: it is three dots instead. */
const FEWEST = 8;
/** A sentence cut to fewer letters than this is worth moving up for: into the band the rug's name is written in, then over the name itself. */
const WORTH = 12;
const DOTS = '…';

export type Speaker = {
  id: string;
  text: string;
  desk: Rect;
  /** The person as drawn: the bubble ends just above it. */
  head: Rect;
  scale: number;
  /** A lead's desk stands at the rug's right edge: their bubble opens to the left from there. */
  lead: boolean;
};

export type Said = { id: string; lines: string[]; x: number; y: number; h: number; side: 'left' | 'right'; /** Where the tail is, from the bubble's left end; from its right end when negative. */ tailAt: number };

const hits = (a: Rect, b: Rect): boolean => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const lettersIn = (width: number): number => Math.floor((width - BUBBLE.pad) / BUBBLE.letter);
export const widthOf = (lines: string[]): number => Math.max(...lines.map((line) => line.length)) * BUBBLE.letter + BUBBLE.pad;
const heightOf = (lines: string[]): number => BUBBLE.h + (lines.length - 1) * BUBBLE.line;
/** How much of the sentence a bubble says. */
const shown = (lines: string[]): number => lines.join(' ').replace(/…$/, '').length;

type Try = { lines: string[]; box: Rect; /** Lower is better, among tries that say as much. */ rank: number };

/**
 * The bubbles of one rug. `solid` is what must never be behind words: every person and name tag on the rug. `name` is
 * where the rug's own name is written: the band across the rug at that height is kept clear, so that a row of bubbles
 * ends on one line, and the name itself is left alone, whenever a few words fit without it. `pitch` is the distance
 * from one desk to the next; `leadDesk` is where a member's words stop, when the team has a lead.
 */
export function layBubbles(rug: Rect, name: Rect, speakers: Speaker[], solid: Rect[], pitch: number, leadDesk: Rect | null): Said[] {
  const said: Said[] = [];
  const taken: Rect[] = [];
  const inside = (box: Rect): boolean => box.x >= rug.x + 2 && box.y >= rug.y + 2 && box.x + box.w <= rug.x + rug.w - 2;
  const band: Rect = { x: rug.x, y: rug.y, w: rug.w, h: name.y + name.h - rug.y };
  const free = (box: Rect, clearOf: Rect[]): boolean => inside(box) && ![...solid, ...taken, ...clearOf].some((one) => hits(box, one));
  /** The best of the tries that fit: the one that says the most, then the one that keeps closest to its speaker. */
  const best = (tries: Try[], clearOf: Rect[]): Try | undefined =>
    tries.filter((one) => free(one.box, clearOf)).sort((a, b) => shown(b.lines) - shown(a.lines) || a.rank - b.rank || a.lines.length - b.lines.length)[0];
  const pick = (speaker: Speaker, tries: Try[], dots: Rect): Try | undefined => {
    const enough = (one: Try | undefined): one is Try => one !== undefined && shown(one.lines) >= Math.min(speaker.text.length, WORTH);
    // Under the band of the rug's name; in the band but beside the name; over the name. A few letters lower down say
    // less than a sentence further up.
    const [under, beside, over] = [best(tries, [band]), best(tries, [name]), best(tries, [])];
    if (enough(under)) return under;
    if (enough(beside)) return beside;
    // None says enough: the one that says the most, and of those the lowest.
    const most = [under, beside, over].filter((one): one is Try => one !== undefined).sort((a, b) => shown(b.lines) - shown(a.lines))[0];
    return most ?? (free(dots, []) ? { lines: [DOTS], box: dots, rank: 0 } : undefined);
  };

  // The members first, row by row; the lead after them, in what room they leave.
  for (const speaker of [...speakers].sort((a, b) => Number(a.lead) - Number(b.lead))) {
    const { desk, head, scale, text } = speaker;
    const bottom = head.y - BUBBLE.gap;
    const tries: Try[] = [];
    if (!speaker.lead) {
      // From the desk's left edge to the next desk: its own seat. Further, over a neighbour who is saying nothing,
      // when that says more of the sentence: never past the seat after the next, the lead's desk or the rug's edge.
      const edge = Math.min(rug.x + rug.w - 4, leadDesk ? leadDesk.x - 4 : Infinity);
      const next = Math.min(...speakers.filter((other) => !other.lead && other.desk.y === desk.y && other.desk.x > desk.x).map((other) => other.desk.x - 8), Infinity);
      const widths = [Math.min(desk.x + pitch * scale - 8, edge), Math.min(desk.x + 2 * pitch * scale - 8, next, edge)];
      for (const [rank, right] of widths.entries()) {
        for (let letters = lettersIn(right - desk.x); letters >= FEWEST; letters--) {
          for (const lines of [3, 2, 1]) {
            const words = wrap(text, letters, lines);
            const h = heightOf(words);
            tries.push({ lines: words, box: { x: desk.x, y: bottom - h, w: widthOf(words), h }, rank });
          }
        }
      }
      const chosen = pick(speaker, tries, { x: desk.x, y: bottom - BUBBLE.h, w: widthOf([DOTS]), h: BUBBLE.h });
      if (!chosen) continue;
      taken.push(chosen.box);
      said.push({ id: speaker.id, lines: chosen.lines, x: chosen.box.x, y: chosen.box.y, h: chosen.box.h, side: 'right', tailAt: head.x + head.w / 2 - desk.x });
    } else {
      // A lead's bubble opens to the left from the rug's edge. Over the far end of their own desk, in the aisle
      // between two rows, when the sentence fits there; else just above their head.
      const right = rug.x + rug.w - 4;
      for (const [rank, foot] of [desk.y + 44 * scale, bottom].entries()) {
        for (let letters = Math.min(22, lettersIn(right - rug.x - 4)); letters >= FEWEST; letters--) {
          for (const lines of [3, 2, 1]) {
            const words = wrap(text, letters, lines);
            const [w, h] = [widthOf(words), heightOf(words)];
            tries.push({ lines: words, box: { x: right - w, y: foot - h, w, h }, rank });
          }
        }
      }
      const dots = widthOf([DOTS]);
      const chosen = pick(speaker, tries, { x: right - dots, y: bottom - BUBBLE.h, w: dots, h: BUBBLE.h });
      if (!chosen) continue;
      taken.push(chosen.box);
      said.push({ id: speaker.id, lines: chosen.lines, x: right, y: chosen.box.y, h: chosen.box.h, side: 'left', tailAt: -(right - (head.x + head.w / 2)) });
    }
  }
  return said;
}
