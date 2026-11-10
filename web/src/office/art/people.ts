/** The people, their name tags and what they are saying. */
import { Container, Graphics } from 'pixi.js';
import type { SceneNode } from '../scene.ts';
import { shade, words } from './kit.ts';

const str = (value: unknown, fallback = ''): string => (typeof value === 'string' ? value : fallback);

/** A head and a shirt, seen from in front. The shirt is the team's colour; a lead's is white. */
export function person(node: SceneNode): Container {
  const s = typeof node.props.scale === 'number' ? node.props.scale : 1;
  const g = new Graphics();
  g.roundRect(0, 18 * s, 24 * s, 28 * s, 8 * s).fill(str(node.props.shirt, '#4A7DE0'));
  g.circle(12 * s, 10 * s, 10 * s).fill(str(node.props.skin, '#E8C39E'));
  const box = new Container();
  box.addChild(g);
  return box;
}

const TAG_TEXT: Record<string, string> = { active: '#F4F4F6', idle: '#9A9AA2', review: '#76D3CC', stuck: '#F4F4F6' };

export function tag(node: SceneNode): Container {
  const g = new Graphics().roundRect(0, 0, node.w, node.h, node.h / 2).fill({ color: '#0B0B0C', alpha: 0.8 });
  const text = words(str(node.props.text), { size: 10, weight: '600', color: TAG_TEXT[str(node.props.tone, 'idle')] ?? '#9A9AA2' });
  text.anchor.set(0.5, 0.5);
  text.position.set(node.w / 2, node.h / 2);
  const box = new Container();
  box.addChild(g, text);
  return box;
}

const BUBBLE: Record<string, { fill: string; alpha: number; text: string; weight: '600' | '700' }> = {
  plain: { fill: '#F4F4F6', alpha: 1, text: '#0B0B0C', weight: '600' },
  review: { fill: '#76D3CC', alpha: 0.18, text: '#76D3CC', weight: '600' },
  stuck: { fill: '#E0625A', alpha: 1, text: '#1A0A09', weight: '700' },
};

/** Words beside a person. The box is as wide as the words; `side` says which way it opens from its anchor. */
export function bubble(node: SceneNode): Container {
  const look = BUBBLE[str(node.props.tone, 'plain')] ?? BUBBLE.plain!;
  const text = words(str(node.props.text), { size: 10, weight: look.weight, color: look.text });
  const w = Math.ceil(text.width) + 18;
  const h = node.h;
  const left = node.props.side === 'left' ? -w : 0;
  const g = new Graphics();
  if (look.alpha === 1) shade(g, left, 0, w, h, 10, 8);
  g.roundRect(left, 0, w, h, 10).fill({ color: look.fill, alpha: look.alpha });
  // The corner nearest the speaker is square, as a speech bubble's is.
  if (node.props.side === 'right') g.roundRect(left, h - 10, 10, 10, 2).fill(look.fill);
  if (node.props.side === 'left') g.roundRect(left + w - 10, h - 10, 10, 10, 2).fill(look.fill);
  text.anchor.set(0, 0.5);
  text.position.set(left + 9, h / 2);
  const box = new Container();
  box.addChild(g, text);
  return box;
}
