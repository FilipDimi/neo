/**
 * Where things are in the office: a 1440 × 900 room, as on the Office artboard. Pure geometry.
 * The fixed rooms never move; team rugs and their desks are laid out for however many teams and
 * people the company has.
 */
export type Rect = { x: number; y: number; w: number; h: number };

export const ROOM = { w: 1440, h: 900 };
export const FLOOR: Rect = { x: 40, y: 40, w: 1360, h: 820 };
export const MEETING: Rect = { x: 970, y: 118, w: 380, h: 330 };
export const CHIEF: Rect = { x: 430, y: 490, w: 360, h: 220 };
export const STUCK: Rect = { x: 830, y: 490, w: 240, h: 220 };
export const KITCHEN: Rect = { x: 1110, y: 490, w: 240, h: 220 };
export const WALL: Rect = { x: 92, y: 740, w: 1258, h: 90 };

const TOP = { x: 92, y: 118, w: 838, h: 330, gap: 38 };
const CORNER: Rect = { x: 92, y: 490, w: 300, h: 220 };

/**
 * One rug per team. Up to three teams sit where the artboard has them: two on the top band, the
 * third bottom left. Four and five put three and four on top. Past five, the corner is shared.
 */
export function rugs(teamCount: number): Rect[] {
  if (teamCount <= 0) return [];
  const onTop = teamCount <= 2 ? teamCount : teamCount === 3 ? 2 : Math.min(4, teamCount - 1);
  const top: Rect[] =
    onTop <= 2
      ? [{ x: 92, y: 118, w: 470, h: 330 }, { x: 600, y: 118, w: 330, h: 330 }].slice(0, onTop)
      : Array.from({ length: onTop }, (_, i) => {
          const w = (TOP.w - TOP.gap * (onTop - 1)) / onTop;
          return { x: TOP.x + i * (w + TOP.gap), y: TOP.y, w, h: TOP.h };
        });
  const inCorner = teamCount - onTop;
  const gap = 10;
  const sliceH = inCorner > 0 ? (CORNER.h - gap * (inCorner - 1)) / inCorner : 0;
  const corner = Array.from({ length: inCorner }, (_, i) => ({ x: CORNER.x, y: CORNER.y + i * (sliceH + gap), w: CORNER.w, h: sliceH }));
  return [...top, ...corner];
}

// A seat as drawn at full size: a 120 × 56 desk, a monitor above it, a chair, a person and a name tag below.
export const DESK = { w: 120, h: 56, pitchX: 180, pitchY: 160, left: 28, top: 42, footprint: 128 };
export const LEAD_DESK = { w: 70, h: 120, fromRight: 92, top: 122, reserve: 110 };

/**
 * Desks for a team inside its rug: members on a grid from the top left, the lead's desk at the
 * right edge. Everything shrinks together when the team is too big for the rug.
 */
export function seats(rug: Rect, memberCount: number, hasLead: boolean): { desks: Rect[]; lead: Rect | null; scale: number } {
  for (let scale = 1; scale >= 0.08; scale = Math.round((scale - 0.04) * 100) / 100) {
    const top = Math.min(DESK.top, rug.h * 0.2) * Math.max(scale, 0.5);
    const left = DESK.left * scale;
    const reserve = hasLead ? LEAD_DESK.reserve * scale : left;
    const cols = Math.max(1, Math.floor((rug.w - left - reserve + (DESK.pitchX - DESK.w) * scale) / (DESK.pitchX * scale)));
    const rows = Math.ceil(Math.max(1, memberCount) / cols);
    const leadFits = !hasLead || top + (LEAD_DESK.h + 80) * scale <= rug.h;
    // The last row needs its desk, the person in front of it and the name tag: 128 at full size.
    const height = top + ((rows - 1) * DESK.pitchY + DESK.footprint) * scale;
    if (height > rug.h || left + DESK.w * scale + reserve > rug.w || !leadFits) continue;
    const desks = Array.from({ length: memberCount }, (_, i) => ({ x: rug.x + left + (i % cols) * DESK.pitchX * scale, y: rug.y + top + Math.floor(i / cols) * DESK.pitchY * scale, w: DESK.w * scale, h: DESK.h * scale }));
    const leadTop = Math.min(LEAD_DESK.top * scale, rug.h - (LEAD_DESK.h + 80) * scale);
    const lead = hasLead ? { x: rug.x + rug.w - LEAD_DESK.fromRight * scale, y: rug.y + Math.max(top * 0.5, leadTop), w: LEAD_DESK.w * scale, h: LEAD_DESK.h * scale } : null;
    return { desks, lead, scale };
  }
  return { desks: Array.from({ length: memberCount }, () => ({ x: rug.x, y: rug.y, w: 1, h: 1 })), lead: hasLead ? { x: rug.x, y: rug.y, w: 1, h: 1 } : null, scale: 0.05 };
}

/** Rug, rug edge, label and shirt colour per team: the artboard's three, then three more of the same weight. */
export const PALETTE = [
  { rug: '#1A2434', edge: '#1F2C40', label: '#6C7A95', shirt: '#4A7DE0' },
  { rug: '#2E1F1B', edge: '#3A2823', label: '#9A6E62', shirt: '#D94A48' },
  { rug: '#2A2A1A', edge: '#35351F', label: '#8A8A5A', shirt: '#F2C76B' },
  { rug: '#1B2A22', edge: '#223629', label: '#6A9580', shirt: '#4CB782' },
  { rug: '#251E33', edge: '#30273F', label: '#857A9E', shirt: '#9B7BE0' },
  { rug: '#172A2C', edge: '#1E3538', label: '#6A9396', shirt: '#3FB6C4' },
];
export const SKIN = ['#E8C39E', '#8D5A3C', '#C98B6B'];
