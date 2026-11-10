import { describe, expect, it } from 'vitest';
import { storyAt } from '../fixtures/story.ts';
import { ALL_KINDS, ART } from './art/index.ts';
import { sync, tweens, type Art, type Drawn, type Shape } from './draw.ts';
import { officeScene, type SceneNode } from './scene.ts';

// A stage that only keeps a list, and artwork that only remembers what it was asked to draw. No WebGL.
type Stub = Shape & { node: SceneNode; destroyed: boolean };
const stage = () => {
  const children: Stub[] = [];
  return { children, sortableChildren: false, addChild: (child: Shape) => void children.push(child as Stub), removeChild: (child: Shape) => void children.splice(children.indexOf(child as Stub), 1) };
};
const stubArt = Object.fromEntries(
  ALL_KINDS.map((kind) => [
    kind,
    (node: SceneNode): Stub => ({
      node,
      x: 0,
      y: 0,
      alpha: 1,
      zIndex: 0,
      destroyed: false,
      destroy() {
        this.destroyed = true;
      },
    }),
  ]),
) as unknown as Art;
const sceneAt = (mark: string) => {
  const { store, now } = storyAt(mark);
  return { store, scene: officeScene(store, now) };
};
const nh = (store: ReturnType<typeof storyAt>['store']) => [...store.employees.values()].find((employee) => employee.name === 'NH')!.id;

describe('sync', () => {
  it('adds one display object per scene node and removes those that left', () => {
    const room = stage();
    const first = sceneAt('parts_running').scene;
    let drawn = sync(room, first, new Map<string, Drawn>(), { art: stubArt });
    expect(room.children).toHaveLength(first.length);
    expect(drawn.size).toBe(first.length);
    const bubbles = room.children.filter((child) => child.node.kind === 'bubble');
    expect(bubbles.length).toBeGreaterThan(0);

    const second = sceneAt('start').scene;
    drawn = sync(room, second, drawn, { art: stubArt });
    expect(room.children).toHaveLength(second.length);
    expect(room.children.some((child) => child.node.kind === 'bubble')).toBe(false);
    expect(bubbles.every((bubble) => bubble.destroyed)).toBe(true);
  });

  it('puts every object where its node is, in the order of the scene', () => {
    const room = stage();
    const { scene } = sceneAt('cards_open');
    const drawn = sync(room, scene, new Map(), { art: stubArt });
    expect(room.sortableChildren).toBe(true);
    for (const [index, node] of scene.entries()) {
      const { object } = drawn.get(node.id)!;
      expect([object.x, object.y, object.zIndex], node.id).toEqual([node.x, node.y, index]);
    }
  });

  it('reuses the object of a node that stayed, and redraws one whose look changed', () => {
    const room = stage();
    const before = sceneAt('start');
    const after = sceneAt('parts_running');
    const first = sync(room, before.scene, new Map(), { art: stubArt });
    const second = sync(room, after.scene, first, { art: stubArt });
    expect(second.get('floor')!.object).toBe(first.get('floor')!.object);
    expect(second.get('table')!.object).toBe(first.get('table')!.object);

    const lit = after.scene.find((node) => node.kind === 'monitor' && node.props.lit === true)!;
    expect(second.get(lit.id)!.object).not.toBe(first.get(lit.id)!.object);
    expect((first.get(lit.id)!.object as Stub).destroyed).toBe(true);
    expect(second.get('wallboard')!.object).not.toBe(first.get('wallboard')!.object);
  });

  it('moves a person to a new seat instead of recreating them', () => {
    const room = stage();
    const before = sceneAt('start');
    const after = sceneAt('cards_open');
    // MW sits at a full-size desk and ends on the couch, behind a refused write.
    const id = `person:${[...before.store.employees.values()].find((employee) => employee.name === 'MW')!.id}`;
    const desk = before.scene.find((node) => node.id === id)!;
    const couch = after.scene.find((node) => node.id === id)!;
    expect(couch.props.where).toBe('stuck');
    expect([desk.x, desk.y]).not.toEqual([couch.x, couch.y]);

    const first = sync(room, before.scene, new Map(), { art: stubArt });
    const second = sync(room, after.scene, first, { art: stubArt });
    const person = second.get(id)!.object;
    expect(person).toBe(first.get(id)!.object);
    expect([person.x, person.y]).toEqual([couch.x, couch.y]); // with nothing to animate with, at once
  });

  it('walks a person to the new seat over 600 ms', () => {
    const room = stage();
    const moving = tweens();
    const before = sceneAt('nh_running');
    const after = sceneAt('lease_card');
    const id = `person:${nh(before.store)}`;
    const desk = before.scene.find((node) => node.id === id)!;
    const couch = after.scene.find((node) => node.id === id)!;

    const first = sync(room, before.scene, new Map(), { art: stubArt, tweens: moving });
    const person = sync(room, after.scene, first, { art: stubArt, tweens: moving }).get(id)!.object;
    expect([person.x, person.y]).toEqual([desk.x, desk.y]);
    moving.step(1000);
    moving.step(1300);
    expect(person.x).toBeCloseTo((desk.x + couch.x) / 2, 5);
    moving.step(1600);
    expect([person.x, person.y]).toEqual([couch.x, couch.y]);
    expect(moving.size).toBe(0);
  });

  it('fades a newly lit screen in over 300 ms, over the dark one', () => {
    const room = stage();
    const fading = tweens();
    const before = sceneAt('start');
    const after = sceneAt('parts_running');
    const lit = after.scene.find((node) => node.kind === 'monitor' && node.props.lit === true)!;
    const first = sync(room, before.scene, new Map(), { art: stubArt, tweens: fading });
    const dark = first.get(lit.id)!.object as Stub;
    const screen = sync(room, after.scene, first, { art: stubArt, tweens: fading }).get(lit.id)!.object;
    expect(screen.alpha).toBe(0);
    expect(dark.destroyed).toBe(false);
    fading.step(0);
    fading.step(300);
    expect(screen.alpha).toBe(1);
    expect(dark.destroyed).toBe(true);
    expect(room.children).toHaveLength(after.scene.length);
  });
});

describe('a redraw while someone is walking', () => {
  it('forgets the walk of an object it has just removed, so the next frame has nothing dead to move', () => {
    const room = stage();
    const moving = tweens();
    const before = sceneAt('nh_running');
    const after = sceneAt('lease_card');
    let drawn = sync(room, before.scene, new Map(), { art: stubArt, tweens: moving });
    drawn = sync(room, after.scene, drawn, { art: stubArt, tweens: moving });
    expect(moving.size).toBeGreaterThan(0);
    const walking = drawn.get(`person:${nh(before.store)}`)!.object as Stub;

    // The window is resized: everything is dropped and drawn again at the new size.
    drawn = sync(room, [], drawn, { art: stubArt, tweens: moving });
    expect(walking.destroyed).toBe(true);
    expect(moving.size).toBe(0);
    drawn = sync(room, after.scene, drawn, { art: stubArt, tweens: moving });
    moving.step(0);
    moving.step(1000);
    expect(room.children).toHaveLength(after.scene.length);
  });
});

describe('the artwork', () => {
  it('has a drawing function for every node kind', () => {
    for (const kind of ALL_KINDS) expect(ART[kind], kind).toBeTypeOf('function');
    const used = new Set(['start', 'parts_running', 'review_running', 'cards_open', 'paused'].flatMap((mark) => sceneAt(mark).scene.map((node) => node.kind)));
    for (const kind of used) expect(ALL_KINDS, kind).toContain(kind);
  });
});
