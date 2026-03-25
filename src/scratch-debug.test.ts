import { expect, test } from 'vitest';
import { ping } from './scratch-debug';

test('ping returns pong', () => {
  expect(ping()).toBe('pong');
});
