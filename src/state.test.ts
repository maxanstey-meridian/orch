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

  it('persists lastCompletedSlice and loads it back', async () => {
    const state = { lastCompletedSlice: 5 };
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
    await saveState(testPath, { lastCompletedSlice: 1 });
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
  });

  it('discards fields with wrong types from valid JSON', async () => {
    await writeFile(testPath, JSON.stringify({ lastCompletedSlice: 'not-a-number' }));
    const loaded = await loadState(testPath);
    expect(loaded).toEqual({});
  });

  it('discards lastCompletedGroup with wrong type and lastSliceImplemented with wrong type', async () => {
    await writeFile(testPath, JSON.stringify({ lastCompletedGroup: 123, lastSliceImplemented: 'nope' }));
    const loaded = await loadState(testPath);
    expect(loaded).toEqual({});
  });

  it('discards empty string lastCompletedGroup and negative lastSliceImplemented', async () => {
    await writeFile(testPath, JSON.stringify({ lastCompletedGroup: '', lastSliceImplemented: -1 }));
    const loaded = await loadState(testPath);
    expect(loaded).toEqual({});
  });

  it('persists lastCompletedGroup and loads it back', async () => {
    const state = { lastCompletedSlice: 3, lastCompletedGroup: 'group-a' };
    await saveState(testPath, state);
    const loaded = await loadState(testPath);
    expect(loaded).toEqual(state);
  });

  it('persists lastSliceImplemented and loads it back', async () => {
    const state = { lastCompletedSlice: 2, lastSliceImplemented: 3 };
    await saveState(testPath, state);
    const loaded = await loadState(testPath);
    expect(loaded).toEqual(state);
  });

  it('overwrites previous state completely on save', async () => {
    await saveState(testPath, { lastCompletedSlice: 5 });
    await saveState(testPath, { lastCompletedSlice: 6 });
    const loaded = await loadState(testPath);
    expect(loaded).toEqual({ lastCompletedSlice: 6 });
  });

  it('discards NaN, Infinity, and negative lastCompletedSlice values', async () => {
    await writeFile(testPath, '{"lastCompletedSlice": NaN}');
    expect(await loadState(testPath)).toEqual({});

    await writeFile(testPath, JSON.stringify({ lastCompletedSlice: Infinity }));
    expect(await loadState(testPath)).toEqual({});

    await writeFile(testPath, JSON.stringify({ lastCompletedSlice: -1 }));
    expect(await loadState(testPath)).toEqual({});
  });

  it('returns default state for non-object JSON values', async () => {
    await writeFile(testPath, '[1,2,3]');
    expect(await loadState(testPath)).toEqual({});

    await writeFile(testPath, '"hello"');
    expect(await loadState(testPath)).toEqual({});
  });
});
