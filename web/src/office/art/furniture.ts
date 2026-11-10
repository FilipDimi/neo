/** The room and everything in it that does not move. Colours and proportions are the Office artboard's. */
import { Container, FillGradient, Graphics } from 'pixi.js';
import type { SceneNode } from '../scene.ts';
import { glow, shade, wood, words } from './kit.ts';

const at = (...children: Container[]): Container => {
  const box = new Container();
  box.addChild(...children);
  return box;
};
const scaleOf = (node: SceneNode): number => (typeof node.props.scale === 'number' ? node.props.scale : 1);
const str = (value: unknown, fallback = ''): string => (typeof value === 'string' ? value : fallback);

export function floor(node: SceneNode): Container {
  const g = new Graphics();
  g.roundRect(0, 0, node.w, node.h, 14).fill('#2B241F');
  for (let x = 118; x < node.w - 10; x += 120) g.rect(x, 10, 2, node.h - 20).fill('#221C18'); // planks
  for (let y = 238; y < node.h - 10; y += 240) g.rect(10, y, node.w - 20, 2).fill({ color: 0x000000, alpha: 0.18 }); // where boards end
  g.roundRect(5, 5, node.w - 10, node.h - 10, 10).stroke({ width: 10, color: '#1C1714' });
  g.rect(10, 10, node.w - 20, 26).fill('#1C1714'); // the back wall
  g.rect(10, 36, node.w - 20, 2).fill('#0E0B09');
  return at(g);
}

let night: FillGradient | undefined;
export function windowPane(node: SceneNode): Container {
  night ??= new FillGradient({ type: 'linear', start: { x: 0, y: 0 }, end: { x: 0, y: 1 }, colorStops: [{ offset: 0, color: '#0F1D33' }, { offset: 1, color: '#162A4A' }], textureSpace: 'local' });
  const g = new Graphics();
  g.roundRect(0, 0, node.w, node.h, 3).fill('#3A3028');
  g.roundRect(2, 2, node.w - 4, node.h - 4, 2).fill(night);
  for (const [x, y] of [[30, 8], [54, 10], [90, 7], [128, 11], [170, 8], [202, 10]] as const) g.rect(x, y, 3, 3).fill('#F2C76B'); // lights across the street
  return at(g);
}

export function rug(node: SceneNode): Container {
  const g = new Graphics();
  if (node.props.style === 'meeting') {
    // A glass room, not a rug.
    g.roundRect(0, 0, node.w, node.h, 16).fill({ color: '#76D3CC', alpha: 0.07 });
    g.roundRect(1.5, 1.5, node.w - 3, node.h - 3, 14.5).stroke({ width: 3, color: '#76D3CC', alpha: 0.45 });
  } else {
    g.roundRect(0, 0, node.w, node.h, 16).fill(str(node.props.edge, '#242426'));
    g.roundRect(6, 6, node.w - 12, node.h - 12, 10).fill(str(node.props.fill, '#1A1A1C'));
  }
  const label = words(str(node.props.label).toUpperCase(), { size: 10, weight: '700', spacing: 1.2, color: str(node.props.labelColor, '#6F6F78') });
  label.position.set(20, 10);
  return at(g, label);
}

export function label(node: SceneNode): Container {
  const size = typeof node.props.size === 'number' ? node.props.size : 10;
  const text = words(str(node.props.text), { size, color: str(node.props.color, '#6F6F78'), wrap: node.w, align: 'center' });
  text.anchor.set(0.5, 0);
  text.position.set(node.w / 2, 0);
  return at(text);
}

export function desk(node: SceneNode): Container {
  const s = scaleOf(node);
  const g = shade(new Graphics(), 0, 0, node.w, node.h, 8 * s, 12 * s);
  g.roundRect(0, 6 * s, node.w, node.h, 8 * s).fill('#4A3626');
  g.roundRect(0, 0, node.w, node.h, 8 * s).fill(wood());
  return at(g);
}

export function monitor(node: SceneNode): Container {
  const s = scaleOf(node);
  const g = new Graphics();
  if (node.props.lit === true) glow(g, 6 * s, 6 * s, node.w - 12 * s, node.h - 12 * s, 2 * s, '#F5B700', 26 * s);
  g.roundRect(0, 0, node.w, node.h, 5 * s).fill('#2E2E33');
  g.roundRect(3 * s, 3 * s, node.w - 6 * s, node.h - 6 * s, 3 * s).fill('#1A1A1E');
  if (node.props.lit === true) g.roundRect(6 * s, 6 * s, node.w - 12 * s, node.h - 12 * s, 2 * s).fill('#F5B700');
  return at(g);
}

export function chair(node: SceneNode): Container {
  const r = node.w / 2;
  const g = new Graphics();
  g.circle(r, r, r).fill('#2A211D');
  g.circle(r, r, r * 0.85).fill('#3A2E28');
  return at(g);
}

export function whiteboard(node: SceneNode): Container {
  const g = new Graphics();
  g.roundRect(0, 0, node.w, node.h, 6).fill('#D9D9DE');
  g.roundRect(6, 6, node.w - 12, node.h - 12, 3).fill('#F4F4F6');
  for (const y of [18, 30, 42]) g.roundRect(20, y, 120, 3, 1.5).fill('#2A2A2E');
  const note = new Graphics().roundRect(0, 0, 110, 34, 6).stroke({ width: 3, color: '#E0625A' });
  note.position.set(160, 19);
  note.rotation = -0.05;
  const text = words('no hand-off', { size: 9, weight: '700', color: '#E0625A' });
  text.position.set(170, 28);
  text.rotation = -0.05;
  return at(g, note, text);
}

export function table(node: SceneNode): Container {
  const g = shade(new Graphics(), 0, 4, node.w, node.h, node.h / 2, 16);
  g.roundRect(0, 8, node.w, node.h, node.h / 2).fill('#4A3626');
  g.roundRect(0, 0, node.w, node.h, node.h / 2).fill(wood());
  g.roundRect(70, 28, 120, 46, 4).fill('#C7C7CC'); // the work under review, printed
  g.roundRect(70, 26, 120, 46, 4).fill('#F4F4F6');
  for (const [i, color] of ['#9A9AA2', '#9A9AA2', '#9A9AA2', '#C7C7CC'].entries()) g.roundRect(80, 36 + i * 8, 70, 3, 1.5).fill(color);
  return at(g);
}

export function couch(node: SceneNode): Container {
  const g = new Graphics();
  g.roundRect(0, 6, node.w, node.h, 12).fill('#2E2420');
  g.roundRect(0, 0, node.w, node.h, 12).fill('#4A3A36');
  g.roundRect(0, 0, node.w, 20, 12).fill('#5A4842'); // the back
  g.rect(0, 10, node.w, 12).fill('#4A3A36');
  return at(g);
}

export function lamp(node: SceneNode): Container {
  const g = new Graphics();
  for (let i = 9; i >= 1; i--) g.ellipse(node.w / 2, 34, 30 + i * 9, 18 + i * 8).fill({ color: '#E0625A', alpha: 0.032 }); // the red light it throws
  g.rect(node.w / 2 - 4, 14, 8, 60).fill('#3A3A40');
  g.moveTo(0, 22).bezierCurveTo(0, -7, node.w, -7, node.w, 22).closePath().fill('#E0625A');
  return at(g);
}

/** The chief of staff's tray: an envelope for each decision waiting, up to a stack of three. */
export function tray(node: SceneNode): Container {
  const count = typeof node.props.count === 'number' ? node.props.count : 0;
  const g = new Graphics();
  g.roundRect(0, 17, 56, 40, 4).fill('#B8923F');
  g.roundRect(0, 14, 56, 40, 4).fill('#F2C76B');
  if (count >= 3) g.roundRect(6, 0, 44, 30, 3).fill('#D4D4DA');
  if (count >= 2) g.roundRect(6, 4, 44, 30, 3).fill('#E4E4E8');
  if (count >= 1) g.roundRect(6, 8, 44, 30, 3).fill('#F4F4F6');
  const text = words(str(node.props.label), { size: 9, weight: '700', color: count > 0 ? '#F2C76B' : '#7A6E66' });
  text.anchor.set(0.5, 0);
  text.position.set(28, 62);
  return at(g, text);
}

export function counter(_node: SceneNode): Container {
  const g = new Graphics();
  g.roundRect(0, 30, 190, 40, 6).fill('#26262A');
  g.roundRect(0, 24, 190, 40, 6).fill('#3A3A40');
  // The coffee machine, on. It stands a little right of where the artboard has it, clear of the room's name.
  g.roundRect(60, 0, 40, 34, 6).fill('#45454B');
  g.roundRect(62, 2, 36, 30, 4).fill('#2A2A2E');
  g.circle(80, 16, 4).fill('#7CF0BF');
  for (const x of [118, 138, 158]) g.roundRect(x, 6, 14, 12, 3).fill('#F4F4F6');
  g.roundRect(10, 100, 160, 36, 18).fill('#1A1A1C'); // a bench nobody is sitting on
  g.roundRect(10, 94, 160, 36, 18).fill('#2A2A2E');
  return at(g);
}

export function plant(_node: SceneNode): Container {
  const g = new Graphics();
  g.roundRect(12, 38, 16, 26, 3).fill('#2E4A3A');
  g.roundRect(14, 40, 12, 22, 2).fill('#1E2A24');
  g.circle(8, 30, 12).fill('#3A8A5C');
  g.circle(30, 32, 9).fill('#27593D');
  g.circle(20, 20, 19).fill('#2E6B4A');
  return at(g);
}

/** The wall board: the six counts of the board, and one sentence about the floor. The chat line sits on its right, in the page. */
export function wallboard(node: SceneNode): Container {
  const g = new Graphics();
  g.roundRect(0, 0, node.w, node.h, 14).fill('#24201B');
  g.roundRect(4, 4, node.w - 8, node.h - 8, 10).fill('#1A1714');
  g.roundRect(18, 12, 360, 66, 8).fill('#2A2A2E');
  g.roundRect(21, 15, 354, 60, 5).fill('#0B0B0C');
  const box = at(g);
  const counts = Array.isArray(node.props.counts) ? (node.props.counts as { label: string; count: number; color: string }[]) : [];
  for (const [index, cell] of counts.entries()) {
    const x = 18 + (360 / counts.length) * (index + 0.5);
    const number = words(String(cell.count), { size: 18, weight: '700', color: cell.color });
    number.anchor.set(0.5, 0);
    number.position.set(x, 22);
    const name = words(cell.label, { size: 11, color: '#9A9AA2' });
    name.anchor.set(0.5, 0);
    name.position.set(x, 47);
    box.addChild(number, name);
  }
  const title = words('WALL BOARD', { size: 10, weight: '700', spacing: 1.2, color: '#6F6F78' });
  title.position.set(398, 22);
  const sentence = words(str(node.props.sentence), { size: 12, lineHeight: 18, color: '#C7C7CC', wrap: 520 });
  sentence.position.set(398, 38);
  box.addChild(title, sentence);
  return box;
}

export function button(node: SceneNode): Container {
  const g = new Graphics().roundRect(0, 0, node.w, node.h, node.h / 2).fill('#F4F4F6');
  const text = words(str(node.props.label), { size: 10, weight: '700', color: '#0B0B0C' });
  text.anchor.set(0.5, 0.5);
  text.position.set(node.w / 2, node.h / 2);
  return at(g, text);
}
