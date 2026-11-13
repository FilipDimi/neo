import { useEffect, useMemo, useRef, useState } from 'react';
import { useUi, type Ui } from '../app/context.ts';
import { money } from '../format.ts';
import { ChatLine } from '../frame/ChatLine.tsx';
import { DecisionsButton, ViewPills } from '../frame/Header.tsx';
import { header } from '../model/select.ts';
import { useNow, useStore } from '../store/store.ts';
import type { OfficeCanvas } from './canvas.ts';
import { ROOM } from './layout.ts';
import './office.css';
import { officeScene, type SceneNode } from './scene.ts';

/** Something in the room that can be clicked: a button in the page, exactly over what the canvas shows. */
type Hit = { id: string; x: number; y: number; w: number; h: number; label: string; quiet?: boolean; act(): void };

function hitsOf(scene: SceneNode[], ui: Ui, widthOf: (id: string) => number | null): Hit[] {
  const hits: Hit[] = [];
  const text = (value: unknown): string => (typeof value === 'string' ? value : '');
  for (const node of scene) {
    const { props } = node;
    if (node.kind === 'person') {
      const saying = text(props.saying);
      hits.push({ id: node.id, x: node.x - 10, y: node.y - 6, w: node.w + 20, h: node.h + 12, label: `${text(props.name)}, ${text(props.status)}${saying ? `: ${saying}` : ''}`, act: () => ui.openPerson(text(props.employeeId)) });
    } else if (node.kind === 'bubble' && typeof props.taskId === 'string') {
      const taskId = props.taskId;
      const w = widthOf(node.id) ?? Math.max(...text(props.text).split('\n').map((line) => line.length)) * 6.2 + 22; // until the canvas has measured it
      hits.push({ id: node.id, x: props.side === 'left' ? node.x - w : node.x, y: node.y, w, h: node.h, label: `Open the task: ${text(props.full) || text(props.text).replace(/\n/g, ' ')}`, act: () => ui.openTask(taskId) });
    } else if (node.kind === 'monitor' && typeof props.taskId === 'string') {
      const taskId = props.taskId;
      // The lit screen opens the same task as the bubble beside it: a bigger target for a mouse, not a second thing to read out.
      hits.push({ id: node.id, x: node.x, y: node.y, w: node.w, h: node.h, label: `Open the task ${text(props.name)} is working on`, quiet: true, act: () => ui.openTask(taskId) });
    } else if (node.kind === 'button') {
      hits.push({ id: node.id, x: node.x, y: node.y, w: node.w, h: node.h, label: `${text(props.label)} for ${text(props.name)}`, act: () => ui.openDeck(text(props.decisionId) || undefined) });
    } else if (node.kind === 'tray' && typeof props.count === 'number' && props.count > 0) {
      hits.push({ id: node.id, x: node.x - 4, y: node.y - 4, w: node.w + 8, h: node.h + 8, label: `The chief of staff's tray, ${props.count} waiting for you`, act: () => ui.openDeck() });
    }
  }
  return hits;
}

/**
 * The office: the same company as the board, drawn as a room. The canvas only paints; every
 * word that matters and everything that can be clicked is also in the page, over the canvas.
 */
export function Office() {
  const ui = useUi();
  const now = useNow(5000);
  const scene = useStore((store) => officeScene(store, now), [now]);
  const top = useStore((store) => header(store, now), [now]);
  const frame = useRef<HTMLDivElement>(null);
  const host = useRef<HTMLDivElement>(null);
  const canvas = useRef<OfficeCanvas | null>(null);
  const [size, setSize] = useState({ w: ROOM.w, h: ROOM.h });
  const [painter, setPainter] = useState<'starting' | 'ready' | 'failed'>('starting');
  const scale = Math.max(0.4, Math.min(2.5, size.w / ROOM.w, size.h / ROOM.h));
  const scaleNow = useRef(scale);
  scaleNow.current = scale;

  useEffect(() => {
    if (typeof ResizeObserver === 'undefined' || !frame.current) return;
    const watcher = new ResizeObserver(([entry]) => entry && entry.contentRect.width > 0 && setSize({ w: entry.contentRect.width, h: entry.contentRect.height }));
    watcher.observe(frame.current);
    return () => watcher.disconnect();
  }, []);

  useEffect(() => {
    let gone = false;
    void import('./canvas.ts')
      .then((module) => module.mountCanvas(host.current!, scaleNow.current))
      .then((mounted) => {
        if (gone) return mounted.destroy();
        canvas.current = mounted;
        setPainter('ready');
      })
      .catch(() => !gone && setPainter('failed'));
    return () => {
      gone = true;
      canvas.current?.destroy();
      canvas.current = null;
    };
  }, []);

  useEffect(() => canvas.current?.resize(scale), [scale, painter]);
  useEffect(() => canvas.current?.draw(scene), [scene, painter]);

  const hits = useMemo(() => hitsOf(scene, ui, (id) => canvas.current?.widthOf(id) ?? null), [scene, ui, painter]);
  const wall = scene.find((node) => node.kind === 'wallboard')?.props as { counts: { label: string; count: number }[]; sentence: string } | undefined;

  return (
    <div className="office" ref={frame}>
      <div className="office-room" style={{ left: (size.w - ROOM.w * scale) / 2, top: (size.h - ROOM.h * scale) / 2, width: ROOM.w * scale, height: ROOM.h * scale }}>
        <div className="office-canvas" ref={host} aria-hidden="true" />
        <div className="office-overlay" style={{ transform: `scale(${scale})` }}>
          {hits.map((hit) => (
            <button key={hit.id} type="button" className="hit" style={{ left: hit.x, top: hit.y, width: hit.w, height: hit.h }} title={hit.label} {...(hit.quiet ? { tabIndex: -1, 'aria-hidden': true } : { 'aria-label': hit.label })} onClick={hit.act} />
          ))}
          <div className="office-chat">
            <ChatLine />
          </div>
        </div>
      </div>

      <div className="office-strip" data-testid="office-strip">
        <div className="company">{top.company}</div>
        <div className="muted">
          {top.clock} · {top.seatsBusy} of {top.seats} seats busy{top.priced ? ` · ${money(top.spentToday)} today` : ''}
        </div>
        {top.paused && <div className="paused">{top.paused}</div>}
      </div>
      <div className="office-pills">
        <ViewPills />
        <DecisionsButton label={(count) => `${count} on your desk`} />
      </div>
      <div className="office-legend" aria-label="What the room shows">
        <span><i className="screen" style={{ background: 'var(--working)' }} />lit screen = working</span>
        <span><i style={{ background: 'var(--review)' }} />meeting room = a review</span>
        <span><i style={{ background: 'var(--silent)' }} />red lamp = stuck, needs you</span>
        <span><i style={{ background: 'var(--text)' }} />white shirt = a lead</span>
      </div>
      {wall && (
        <p className="sr-only" data-testid="wallboard-text">
          {`Wall board: ${wall.counts.map((cell) => `${cell.label} ${cell.count}`).join(', ')}. ${wall.sentence}`}
        </p>
      )}
      {painter === 'failed' && (
        <div className="office-notice" role="status">
          The room cannot be drawn here: this browser has no WebGL. The board shows the same company.
        </div>
      )}
    </div>
  );
}
