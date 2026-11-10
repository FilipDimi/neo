import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

// Without vitest's globals the testing library cannot register this itself.
afterEach(cleanup);
