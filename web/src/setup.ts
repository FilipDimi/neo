import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

// Without vitest's globals the testing library cannot register this itself.
afterEach(cleanup);

// jsdom has no canvas. PixiJS asks for one when the office mounts and is told, quietly, that there is none.
if (typeof HTMLCanvasElement !== 'undefined') HTMLCanvasElement.prototype.getContext = (() => null) as typeof HTMLCanvasElement.prototype.getContext;
