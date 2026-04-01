import type { Hud, HudState, WriteFn, KeyHandler, InterruptSubmitHandler } from "#ui/hud.js";

export class FakeHud implements Hud {
  private keyHandler: KeyHandler | null = null;
  private interruptHandler: InterruptSubmitHandler | null = null;

  /** Every prompt string passed to askUser(), in order. */
  readonly askPrompts: string[] = [];
  /** Pre-programmed answers for askUser(), consumed FIFO. */
  private askAnswers: Array<string | (() => string)> = [];

  /** Every setSkipping() call value, in order. */
  readonly skippingHistory: boolean[] = [];
  /** Every setActivity() call, in order. */
  readonly activityHistory: string[] = [];
  /** Every update() partial, in order. */
  readonly updates: Array<Partial<HudState>> = [];
  /** All text written via wrapLog() and createWriter(). */
  readonly logs: string[] = [];
  /** Every startPrompt() mode, in order. */
  readonly promptsStarted: string[] = [];
  /** Whether teardown was called. */
  tornDown = false;

  // ── Hud interface implementation ──

  update(partial: Partial<HudState>): void {
    this.updates.push(partial);
  }

  teardown(): void {
    this.tornDown = true;
  }

  wrapLog(_logFn: (...args: unknown[]) => void): (...args: unknown[]) => void {
    return (...args: unknown[]) => {
      this.logs.push(args.map(String).join(" "));
    };
  }

  createWriter(): WriteFn {
    return (text: string) => {
      this.logs.push(text);
    };
  }

  onKey(handler: KeyHandler): void {
    this.keyHandler = handler;
  }

  onInterruptSubmit(handler: InterruptSubmitHandler): void {
    this.interruptHandler = handler;
  }

  startPrompt(mode: "guide" | "interrupt"): void {
    this.promptsStarted.push(mode);
  }

  setSkipping(v: boolean): void {
    this.skippingHistory.push(v);
  }

  setActivity(text: string): void {
    this.activityHistory.push(text);
  }

  askUser(prompt: string): Promise<string> {
    this.askPrompts.push(prompt);
    if (this.askAnswers.length === 0) {
      throw new Error(`FakeHud.askUser: no answer queued for prompt: "${prompt.slice(0, 80)}"`);
    }
    const next = this.askAnswers.shift()!;
    const answer = typeof next === "function" ? next() : next;
    return Promise.resolve(answer);
  }

  // ── Test interaction methods ──

  /** Pre-program answers for askUser(). Consumed FIFO. */
  queueAskAnswer(...answers: Array<string | (() => string)>): void {
    this.askAnswers.push(...answers);
  }

  /** Simulate a keypress through the real onKey handler. */
  simulateKey(key: string): void {
    if (!this.keyHandler) {
      throw new Error(`FakeHud.simulateKey: no keyHandler registered yet`);
    }
    this.keyHandler(key);
  }

  /** Simulate submitting text from guide/interrupt prompt. */
  simulateInterruptSubmit(text: string, mode: "guide" | "interrupt"): void {
    if (!this.interruptHandler) {
      throw new Error(`FakeHud.simulateInterruptSubmit: no interruptHandler registered yet`);
    }
    this.interruptHandler(text, mode);
  }

  /** True if a keyHandler has been registered (i.e. registerInterrupts was called). */
  get hasKeyHandler(): boolean {
    return this.keyHandler !== null;
  }
}
