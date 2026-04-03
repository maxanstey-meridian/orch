import { describe, it, expect, vi } from 'vitest';
import { PassThrough } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import { createJsonRpcClient } from '../../src/infrastructure/codex/codex-json-rpc.js';

const makeMockProc = () => {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const kill = vi.fn();
  return { proc: { stdin, stdout, kill } as unknown as ChildProcess, stdin, stdout, kill };
};

const pushLine = (stdout: PassThrough, obj: Record<string, unknown>) =>
  stdout.push(JSON.stringify(obj) + '\n');

describe('JsonRpcClient', () => {
  it('sends request and resolves on matching response', async () => {
    const { proc, stdout } = makeMockProc();
    const client = createJsonRpcClient(proc);

    const promise = client.request('foo', { bar: 1 });
    pushLine(stdout, { jsonrpc: '2.0', id: 1, result: 'ok' });

    await expect(promise).resolves.toBe('ok');
  });

  it('correlates multiple concurrent requests responded out of order', async () => {
    const { proc, stdout } = makeMockProc();
    const client = createJsonRpcClient(proc);

    const p1 = client.request('first', {});
    const p2 = client.request('second', {});

    // Respond to second request first
    pushLine(stdout, { jsonrpc: '2.0', id: 2, result: 'result-2' });
    pushLine(stdout, { jsonrpc: '2.0', id: 1, result: 'result-1' });

    await expect(p1).resolves.toBe('result-1');
    await expect(p2).resolves.toBe('result-2');
  });

  it('routes notifications to handler', async () => {
    const { proc, stdout } = makeMockProc();
    const client = createJsonRpcClient(proc);
    const handler = vi.fn();

    client.onNotification(handler);
    pushLine(stdout, { jsonrpc: '2.0', method: 'item/delta', params: { text: 'hi' } });

    // readline is async — yield to let the line handler fire
    await new Promise((r) => setTimeout(r, 0));

    expect(handler).toHaveBeenCalledWith({ method: 'item/delta', params: { text: 'hi' } });
  });

  it('skips malformed lines and still processes subsequent valid messages', async () => {
    const { proc, stdout } = makeMockProc();
    const client = createJsonRpcClient(proc);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const promise = client.request('test', {});
    stdout.push('not json at all\n');
    pushLine(stdout, { jsonrpc: '2.0', id: 1, result: 'still works' });

    await expect(promise).resolves.toBe('still works');
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('close() kills the process', () => {
    const { proc, kill } = makeMockProc();
    const client = createJsonRpcClient(proc);

    client.close();

    expect(kill).toHaveBeenCalled();
  });

  it('close() rejects pending requests with client closed error', async () => {
    const { proc } = makeMockProc();
    const client = createJsonRpcClient(proc);

    const promise = client.request('willNotResolve', {});
    client.close();

    await expect(promise).rejects.toThrow('client closed');
  });

  it('error responses reject the promise with an Error carrying structured info', async () => {
    const { proc, stdout } = makeMockProc();
    const client = createJsonRpcClient(proc);

    const promise = client.request('bad', {});
    pushLine(stdout, {
      jsonrpc: '2.0',
      id: 1,
      error: { code: -32600, message: 'Invalid Request', data: { detail: 'missing field' } },
    });

    await expect(promise).rejects.toMatchObject({
      message: 'Invalid Request',
      code: -32600,
      data: { detail: 'missing field' },
    });
  });

  it('rejects pending requests when process dies unexpectedly', async () => {
    const { proc, stdout } = makeMockProc();
    const client = createJsonRpcClient(proc);

    const promise = client.request('willHang', {});

    // Simulate process death — stdout closes
    stdout.push(null);

    await expect(promise).rejects.toThrow('process exited');
  });

  it('writes correctly formatted JSON-RPC message to stdin', async () => {
    const { proc, stdin, stdout } = makeMockProc();
    const client = createJsonRpcClient(proc);

    const chunks: Buffer[] = [];
    stdin.on('data', (chunk: Buffer) => chunks.push(chunk));

    const promise = client.request('foo', { bar: 1 });
    pushLine(stdout, { jsonrpc: '2.0', id: 1, result: 'ok' });
    await promise;

    const written = Buffer.concat(chunks).toString();
    expect(written).toBe('{"jsonrpc":"2.0","id":1,"method":"foo","params":{"bar":1}}\n');
  });

  it('error response with non-object error rejects with Error', async () => {
    const { proc, stdout } = makeMockProc();
    const client = createJsonRpcClient(proc);

    const promise = client.request('bad', {});
    pushLine(stdout, { jsonrpc: '2.0', id: 1, error: 'just a string' });

    await expect(promise).rejects.toThrow('just a string');
  });
});
