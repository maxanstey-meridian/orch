import { exec } from 'child_process';
import { promisify } from 'util';

const run = promisify(exec);

export type TestGateResult = {
  readonly passed: boolean;
  readonly output: string;
};

export type TestGateInput = {
  readonly testCommand?: string;
};

export const runTestGate = async (input: TestGateInput): Promise<TestGateResult> => {
  if (!input.testCommand) {
    return { passed: false, output: 'No test command configured in project profile.' };
  }

  try {
    await run(input.testCommand);
    return { passed: true, output: '' };
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string };
    const output = [e.stdout ?? '', e.stderr ?? ''].join('\n').trim();
    return { passed: false, output };
  }
};
