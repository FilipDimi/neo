/**
 * The artwork: one drawing function per kind of scene node. This folder is the only place that
 * knows how anything in the office looks; replacing it replaces the look and nothing else.
 */
import type { Container } from 'pixi.js';
import type { SceneKind, SceneNode } from '../scene.ts';
import { button, chair, couch, counter, desk, floor, label, lamp, monitor, plant, rug, table, tray, wallboard, whiteboard, windowPane } from './furniture.ts';
import { bubble, person, tag } from './people.ts';

export { setQuality } from './kit.ts';

export const ART: Record<SceneKind, (node: SceneNode) => Container> = { floor, window: windowPane, rug, label, desk, monitor, chair, person, tag, bubble, whiteboard, table, couch, lamp, tray, counter, plant, wallboard, button };
export const ALL_KINDS = Object.keys(ART) as SceneKind[];
