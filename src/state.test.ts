import { describe, it, expect, beforeEach } from 'vitest';
import { rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { loadState, saveState, clearState } from './state.js';

const testPath = join(tmpdir(), `orch-state-test-${process.pid}.json`);

beforeEach(async () => {
  await rm(testPath, { force: true });
});

describe('state', () => {
  it('returns default state when file does not exist', async () => {
    const state = await loadState(testPath);
    expect(state).toEqual({});
  });

  it('persists state and loads it back', async () => {
    const state = {
      implSessionId: 'sess-1',
      reviewSessionId: 'sess-2',
      gapSessionId: 'sess-3',
      lastCompletedSlice: 5,
    };
    await saveState(testPath, state);
    const loaded = await loadState(testPath);
    expect(loaded).toEqual(state);
  });

  it('returns default state when file contains corrupt JSON', async () => {
    await writeFile(testPath, '{not valid json!!!');
    const state = await loadState(testPath);
    expect(state).toEqual({});
  });

  it('deletes state file on clear', async () => {
    await saveState(testPath, { implSessionId: 'sess-1' });
    await clearState(testPath);
    const state = await loadState(testPath);
    expect(state).toEqual({});
  });

  it('silently ignores clear when file does not exist', async () => {
    await expect(clearState(testPath)).resolves.toBeUndefined();
  });

  it('persists partial state with only some fields set', async () => {
    await saveState(testPath, { lastCompletedSlice: 3 });
    const loaded = await loadState(testPath);
    expect(loaded).toEqual({ lastCompletedSlice: 3 });
    expect(loaded.implSessionId).toBeUndefined();
  });

  it('discards fields with wrong types from valid JSON', async () => {
    await writeFile(testPath, JSON.stringify({ implSessionId: 42, lastCompletedSlice: 'not-a-number', reviewSessionId: 'valid' }));
    const loaded = await loadState(testPath);
    expect(loaded).toEqual({ reviewSessionId: 'valid' });
  });

  it('returns default state for non-object JSON values', async () => {
    await writeFile(testPath, '[1,2,3]');
    expect(await loadState(testPath)).toEqual({});

    await writeFile(testPath, '"hello"');
    expect(await loadState(testPath)).toEqual({});
  });
});
