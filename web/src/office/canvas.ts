/**
 * The PixiJS side of the office: one canvas, painted only when something changed or is moving.
 * Loaded on demand, so the board never waits for it. Everything it shows comes from `draw(scene)`.
 */
import { Application, Container } from 'pixi.js';
import { ART, setQuality } from './art/index.ts';
import { sync, tweens, type Drawn } from './draw.ts';
import { ROOM } from './layout.ts';
import type { SceneNode } from './scene.ts';

export type OfficeCanvas = {
  draw(scene: SceneNode[]): void;
  /** Room pixels to screen pixels. Text is redrawn so it stays sharp. */
  resize(scale: number): void;
  /** How wide a node came out, in room pixels: a bubble is as wide as its words. */
  widthOf(id: string): number | null;
  destroy(): void;
};

export async function mountCanvas(host: HTMLElement, startScale: number): Promise<OfficeCanvas> {
  const density = window.devicePixelRatio || 1;
  const app = new Application();
  await app.init({ width: ROOM.w * startScale, height: ROOM.h * startScale, backgroundAlpha: 0, antialias: true, resolution: density, autoDensity: true, autoStart: false });
  app.ticker.stop();
  host.appendChild(app.canvas);

  const room = new Container();
  app.stage.addChild(room);
  const moving = tweens();
  const art = { art: ART, tweens: moving };
  let drawn = new Map<string, Drawn>();
  let last: SceneNode[] = [];
  let scale = startScale;
  let frame = 0;
  let gone = false;

  // Nothing is painted while nothing changes: an office left open all day costs nothing.
  const paint = (): void => {
    frame = 0;
    if (gone) return;
    moving.step(performance.now());
    app.render();
    if (moving.size > 0) frame = requestAnimationFrame(paint);
  };
  const repaint = (): void => {
    if (!frame && !gone) frame = requestAnimationFrame(paint);
  };
  const rebuild = (): void => {
    setQuality(density * scale);
    room.scale.set(scale);
    drawn = sync(room, [], drawn, { art: ART });
    drawn = sync(room, last, drawn, { art: ART });
    repaint();
  };
  rebuild();
  // Words drawn before the typeface arrived are in the wrong one; draw them again once it is here.
  void document.fonts?.ready.then(() => !gone && rebuild());

  return {
    draw(scene) {
      last = scene;
      drawn = sync(room, scene, drawn, art);
      repaint();
    },
    resize(next) {
      if (next === scale) return;
      scale = next;
      app.renderer.resize(ROOM.w * scale, ROOM.h * scale);
      rebuild();
    },
    widthOf(id) {
      const object = drawn.get(id)?.object;
      return object instanceof Container ? object.width : null;
    },
    destroy() {
      gone = true;
      if (frame) cancelAnimationFrame(frame);
      app.destroy(true, { children: true });
    },
  };
}
