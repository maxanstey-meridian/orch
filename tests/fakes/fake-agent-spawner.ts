import type { AgentHandle } from "#application/ports/agent-spawner.port.js";
import { AgentSpawner } from "#application/ports/agent-spawner.port.js";
import type { AgentResult, AgentRole, AgentStyle } from "#domain/agent-types.js";

const ROLE_STYLES: Record<string, AgentStyle> = {
  tdd: { label: "TDD", color: "#0ff", badge: "[TDD]" },
  review: { label: "REV", color: "#f0f", badge: "[REV]" },
  verify: { label: "VFY", color: "#0f0", badge: "[VFY]" },
  plan: { label: "PLN", color: "#fff", badge: "[PLN]" },
  gap: { label: "GAP", color: "#ff0", badge: "[GAP]" },
  final: { label: "FIN", color: "#0f0", badge: "[FIN]" },
  completeness: { label: "CMP", color: "#fff", badge: "[CMP]" },
  triage: { label: "TRI", color: "#888", badge: "[TRI]" },
};

export class FakeAgentHandle implements AgentHandle {
  readonly sessionId: string;
  readonly style: AgentStyle;
  alive = true;
  stderr = "";

  /** Every prompt passed to send(), in order. */
  readonly sentPrompts: string[] = [];
  /** Every prompt passed to sendQuiet(), in order. */
  readonly quietPrompts: string[] = [];
  /** Every message passed to inject(), in order. */
  readonly injectedMessages: string[] = [];

  private responses: Array<AgentResult | ((prompt: string) => AgentResult)> = [];
  private pipeOnText: ((text: string) => void) | null = null;
  private pipeOnToolUse: ((summary: string) => void) | null = null;

  constructor(sessionId: string, role: string) {
    this.sessionId = sessionId;
    this.style = ROLE_STYLES[role] ?? { label: role, color: "#fff", badge: `[${role}]` };
  }

  /** Queue one or more responses for send(). */
  queueResponse(...results: Array<AgentResult | ((prompt: string) => AgentResult)>): void {
    this.responses.push(...results);
  }

  async send(
    prompt: string,
    _onText?: (text: string) => void,
    _onToolUse?: (summary: string) => void,
  ): Promise<AgentResult> {
    this.sentPrompts.push(prompt);
    if (this.responses.length === 0) {
      throw new Error(
        `FakeAgentHandle(${this.sessionId}): no response queued for send(): "${prompt.slice(0, 80)}"`,
      );
    }
    const next = this.responses.shift()!;
    return typeof next === "function" ? next(prompt) : next;
  }

  async sendQuiet(prompt: string): Promise<string> {
    this.quietPrompts.push(prompt);
    return "ok";
  }

  inject(message: string): void {
    this.injectedMessages.push(message);
  }

  kill(): void {
    this.alive = false;
  }

  pipe(onText: (text: string) => void, onToolUse: (summary: string) => void): void {
    this.pipeOnText = onText;
    this.pipeOnToolUse = onToolUse;
  }
}

export class FakeAgentSpawner extends AgentSpawner {
  readonly spawned: Array<{ role: AgentRole; handle: FakeAgentHandle; opts?: Record<string, unknown> }> = [];
  private sessionCounter = 0;

  /**
   * Queue of response batches per role. Each onNextSpawn call adds one batch.
   * Each spawn() of that role consumes one batch (FIFO).
   */
  private spawnQueue = new Map<AgentRole, Array<Array<AgentResult | ((prompt: string) => AgentResult)>>>();

  /** Queue responses for the next spawn of this role. Each call = one spawn's worth. */
  onNextSpawn(role: AgentRole, ...responses: Array<AgentResult | ((prompt: string) => AgentResult)>): void {
    const queue = this.spawnQueue.get(role) ?? [];
    queue.push(responses);
    this.spawnQueue.set(role, queue);
  }

  spawn(
    role: AgentRole,
    opts?: { readonly resumeSessionId?: string; readonly systemPrompt?: string; readonly cwd?: string; readonly planMode?: boolean },
  ): FakeAgentHandle {
    const handle = new FakeAgentHandle(`${role}-${++this.sessionCounter}`, role);
    const queue = this.spawnQueue.get(role);
    if (queue && queue.length > 0) {
      const batch = queue.shift()!;
      handle.queueResponse(...batch);
      if (queue.length === 0) {
        this.spawnQueue.delete(role);
      }
    }
    this.spawned.push({ role, handle, opts: opts as Record<string, unknown> });
    return handle;
  }

  /** All handles spawned for a given role. */
  agentsForRole(role: AgentRole): FakeAgentHandle[] {
    return this.spawned.filter((s) => s.role === role).map((s) => s.handle);
  }

  /** The most recently spawned handle for a given role. */
  lastAgent(role: AgentRole): FakeAgentHandle {
    const agents = this.agentsForRole(role);
    if (agents.length === 0) {
      throw new Error(`No agents spawned for role: ${role}`);
    }
    return agents[agents.length - 1];
  }
}
