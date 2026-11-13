/**
 * Keeps a stage in step with a scene: one display object per node, by id. It knows nothing about
 * how anything looks (the artwork is passed in) and nothing about the company (the scene is data).
 * Two things animate and nothing else: a person walks to a new seat, and a screen fades on.
 */
import type { SceneKind, SceneNode } from './scene.ts';

/** What sync needs from a display object. A PixiJS Container is one; so is a test's plain object. */
export type Shape = { x: number; y: number; alpha: number; zIndex: number; destroy(options?: unknown): void };
export type Stage = { sortableChildren: boolean; addChild(child: Shape): unknown; removeChild(child: Shape): unknown };
export type Art<S extends Shape = Shape> = Record<SceneKind, (node: SceneNode) => S>;
export type Drawn = { object: Shape; look: string; x: number; y: number };

export const WALK_MS = 600;
export const FADE_MS = 300;
const WALKS: ReadonlySet<SceneKind> = new Set(['person', 'tag']);
// What a node carries for clicks and labels. None of it changes a pixel.
const NOT_LOOK = new Set(['employeeId', 'name', 'decisionId', 'taskId', 'status', 'saying', 'where', 'full']);

/** Everything about a node that changes how it is drawn. The same look means the same object is kept. */
function lookOf(node: SceneNode): string {
  const props = Object.entries(node.props).filter(([key]) => !NOT_LOOK.has(key) && !(node.kind === 'person' && key === 'tone'));
  return JSON.stringify([node.kind, node.w, node.h, props]);
}

type Tween = { target: Shape; to: Partial<Record<'x' | 'y' | 'alpha', number>>; from: Partial<Record<'x' | 'y' | 'alpha', number>>; ms: number; started: number | null; done: (() => void) | undefined };
export type Tweens = ReturnType<typeof tweens>;

/** Values on their way somewhere. `step` is called with the time of each frame, in milliseconds. */
export function tweens() {
  let active: Tween[] = [];
  const ease = (t: number): number => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);
  const keysOf = (tween: Tween) => Object.keys(tween.to) as ('x' | 'y' | 'alpha')[];
  return {
    get size(): number {
      return active.length;
    },
    /** Starts on the next frame. A new destination for the same value replaces the old one. */
    to(target: Shape, to: Tween['to'], ms: number, done?: () => void): void {
      const replaced = active.filter((tween) => tween.target === target && keysOf(tween).some((key) => key in to));
      active = active.filter((tween) => !replaced.includes(tween));
      const from: Tween['from'] = {};
      for (const key of Object.keys(to) as ('x' | 'y' | 'alpha')[]) from[key] = target[key];
      active.push({ target, to, from, ms, started: null, done });
      for (const tween of replaced) tween.done?.();
    },
    step(now: number): void {
      const finished: Tween[] = [];
      for (const tween of active) {
        tween.started ??= now;
        const t = Math.min(1, (now - tween.started) / tween.ms);
        for (const key of keysOf(tween)) tween.target[key] = t === 1 ? tween.to[key]! : tween.from[key]! + (tween.to[key]! - tween.from[key]!) * ease(t);
        if (t === 1) finished.push(tween);
      }
      active = active.filter((tween) => !finished.includes(tween));
      for (const tween of finished) tween.done?.();
    },
    /** Forgets a target that is leaving the stage. Whatever waited on it still happens. */
    cancel(target: Shape): void {
      const dropped = active.filter((tween) => tween.target === target);
      active = active.filter((tween) => tween.target !== target);
      for (const tween of dropped) tween.done?.();
    },
  };
}

/**
 * Adds, moves, redraws and removes display objects so the stage shows the scene, back to front.
 * Returns what is on the stage now, to pass in next time. Without `tweens` everything is immediate.
 */
export function sync(stage: Stage, scene: SceneNode[], previous: Map<string, Drawn>, options: { art: Art; tweens?: Tweens | undefined }): Map<string, Drawn> {
  const { art, tweens: moving } = options;
  const drop = (object: Shape): void => {
    moving?.cancel(object);
    stage.removeChild(object);
    object.destroy({ children: true });
  };
  const next = new Map<string, Drawn>();
  stage.sortableChildren = true;
  for (const [index, node] of scene.entries()) {
    const look = lookOf(node);
    const old = previous.get(node.id);
    const moved = old !== undefined && (old.x !== node.x || old.y !== node.y);
    const walks = moving !== undefined && moved && WALKS.has(node.kind);
    let object: Shape;
    if (old?.look === look) {
      object = old.object;
      if (walks) moving.to(object, { x: node.x, y: node.y }, WALK_MS);
      else if (moved) [object.x, object.y] = [node.x, node.y];
    } else {
      object = art[node.kind](node);
      [object.x, object.y] = [node.x, node.y];
      stage.addChild(object);
      if (old && walks) {
        // Redrawn on the way (a name tag changes colour as its person gets up): it carries on from where the old one was.
        [object.x, object.y] = [old.object.x, old.object.y];
        drop(old.object);
        moving.to(object, { x: node.x, y: node.y }, WALK_MS);
      } else if (old && moving && node.kind === 'monitor' && node.props.lit === true) {
        const dark = old.object;
        object.alpha = 0;
        moving.to(object, { alpha: 1 }, FADE_MS, () => drop(dark));
      } else if (old) drop(old.object);
    }
    object.zIndex = index;
    next.set(node.id, { object, look, x: node.x, y: node.y });
  }
  for (const [id, old] of previous) if (!next.has(id)) drop(old.object);
  return next;
}
