/** The few things every drawing uses: text at the screen's sharpness, the wood of the desks, soft light and shade. */
import { FillGradient, Graphics, Text } from 'pixi.js';

let quality = 2;
/** How many device pixels one room pixel is. Text drawn after this is sharp at that size. */
export const setQuality = (value: number): void => void (quality = Math.max(1, Math.min(4, value)));

export type Words = { size: number; color: string; weight?: '400' | '500' | '600' | '700'; spacing?: number; wrap?: number; lineHeight?: number; align?: 'left' | 'center' };

export function words(value: string, style: Words): Text {
  const text = new Text({
    text: value,
    style: {
      fontFamily: 'Inter, system-ui, sans-serif',
      fontSize: style.size,
      fontWeight: style.weight ?? '400',
      fill: style.color,
      letterSpacing: style.spacing ?? 0,
      align: style.align ?? 'left',
      ...(style.wrap ? { wordWrap: true, wordWrapWidth: style.wrap } : {}),
      ...(style.lineHeight ? { lineHeight: style.lineHeight } : {}),
    },
  });
  text.resolution = quality;
  return text;
}

let woodFill: FillGradient | undefined;
/** Desk and table tops: lighter at the back edge, darker at the front. */
export const wood = (): FillGradient =>
  (woodFill ??= new FillGradient({ type: 'linear', start: { x: 0, y: 0 }, end: { x: 0, y: 1 }, colorStops: [{ offset: 0, color: '#8A6A4A' }, { offset: 1, color: '#6E5238' }], textureSpace: 'local' }));

/** A soft shadow under a rounded box: a few wider, fainter boxes. */
export function shade(g: Graphics, x: number, y: number, w: number, h: number, radius: number, reach = 12): Graphics {
  for (let i = 3; i >= 1; i--) g.roundRect(x - (i * reach) / 6, y + reach / 2 + (i * reach) / 6, w + (i * reach) / 3, h, radius + (i * reach) / 6).fill({ color: 0x000000, alpha: 0.14 });
  return g;
}

/** Light spilling from a rounded box: rings that fade with distance. */
export function glow(g: Graphics, x: number, y: number, w: number, h: number, radius: number, color: string, reach: number, strength = 0.35): Graphics {
  const rings = 7;
  for (let i = rings; i >= 1; i--) {
    const out = (i * reach) / rings;
    g.roundRect(x - out, y - out, w + out * 2, h + out * 2, radius + out).fill({ color, alpha: strength / rings });
  }
  return g;
}
