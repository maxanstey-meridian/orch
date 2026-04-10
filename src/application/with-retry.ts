import { isRespawnableRole, type AgentPool } from "#application/agent-pool.js";
import type { InterruptState } from "#application/interrupt-state.js";
import type { StateAccessor } from "#application/pipeline-context.js";
import type { AgentHandle } from "#application/ports/agent-spawner.port.js";
import type { LogWriter } from "#application/ports/log-writer.port.js";
import type { OperatorGate } from "#application/ports/operator-gate.port.js";
import type { ProgressSink } from "#application/ports/progress-sink.port.js";
import type { StatePersistence } from "#application/ports/state-persistence.port.js";
import type { AgentResult, AgentRole } from "#domain/agent-types.js";
import { collectAgentFailureText, detectApiError, type ApiError } from "#domain/api-errors.js";
import type { OrchestratorConfig } from "#domain/config.js";
import { CreditExhaustedError } from "#domain/errors.js";

const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_DELAY_MS = 5_000;
const DEFAULT_MIN_DURATION_MS = 3_000;
const DEFAULT_USAGE_PROBE_DELAY_MS = 60_000;
const DEFAULT_USAGE_PROBE_MAX_DELAY_MS = 300_000;
const PROBE_PROMPT = "Reply with exactly OK.";

const sleep = async (delayMs: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, delayMs));

const describeCreditExhaustion = (
  apiError: ApiError,
  result: AgentResult,
  agent: AgentHandle,
): string => {
  const failureText = collectAgentFailureText(result, agent.stderr);
  return `${apiError.kind}: ${failureText.slice(0, 200)}`;
};

export type WithRetryOpts = {
  readonly maxRetries?: number;
  readonly delayMs?: number;
  readonly minDurationMs?: number;
  readonly usageProbeDelayMs?: number;
  readonly usageProbeMaxDelayMs?: number;
  readonly pool: AgentPool;
  readonly interrupts: InterruptState;
  readonly gate: OperatorGate;
  readonly progress: ProgressSink;
  readonly log: LogWriter;
  readonly persistence: StatePersistence;
  readonly config: OrchestratorConfig;
  readonly stateAccessor: StateAccessor;
};

const waitForUsageAvailability = async (
  apiError: ApiError,
  role: AgentRole,
  label: string,
  opts: WithRetryOpts,
): Promise<boolean> => {
  if (!opts.config.auto || apiError.kind !== "credit-exhausted") {
    return false;
  }

  const probeDelayMs = opts.usageProbeDelayMs ?? DEFAULT_USAGE_PROBE_DELAY_MS;
  const probeMaxDelayMs = opts.usageProbeMaxDelayMs ?? DEFAULT_USAGE_PROBE_MAX_DELAY_MS;

  let attempt = 0;
  while (true) {
    const waitMs = Math.min(probeDelayMs * 2 ** attempt, probeMaxDelayMs);
    opts.progress.setActivity(
      `usage limited; probing ${role} again in ${Math.round(waitMs / 1000)}s`,
    );
    await opts.persistence.save(opts.stateAccessor.get());
    await sleep(waitMs);

    const probe = opts.pool.spawnDetached(role);
    try {
      const probeResult = await probe.send(PROBE_PROMPT);
      const probeError = detectApiError(probeResult, probe.stderr);
      if (probeError === null) {
        opts.progress.setActivity(`usage available again; retrying ${label}...`);
        return true;
      }
    } finally {
      probe.kill();
    }

    attempt++;
  }
};

export const withRetry = async (
  fn: () => Promise<AgentResult>,
  agent: AgentHandle,
  role: AgentRole,
  label: string,
  opts: WithRetryOpts,
): Promise<AgentResult> => {
  const maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES;
  const delayMs = opts.delayMs ?? DEFAULT_DELAY_MS;
  const minDurationMs = opts.minDurationMs ?? DEFAULT_MIN_DURATION_MS;

  let currentAgent = agent;
  let attempt = 0;

  while (true) {
    const start = Date.now();
    const result = await fn();
    const elapsed = Date.now() - start;

    if (!currentAgent.alive) {
      if (opts.interrupts.hardInterrupt() !== null || opts.interrupts.quitRequested()) {
        return result;
      }

      if (!isRespawnableRole(role)) {
        throw new Error(`Ephemeral ${role} agent died during ${label} — cannot respawn`);
      }

      attempt++;
      if (attempt > maxRetries) {
        throw new Error(`Agent died after ${maxRetries} respawn attempts (${label})`);
      }

      opts.progress.setActivity(`${role} agent died, respawning ${attempt}/${maxRetries}...`);
      currentAgent = await opts.pool.respawn(role);
      await sleep(delayMs * attempt);
      continue;
    }

    const apiError = detectApiError(result, currentAgent.stderr);

    if (apiError === null && elapsed < minDurationMs) {
      attempt++;
      if (attempt > maxRetries) {
        throw new Error(
          `Agent returned in ${elapsed}ms without doing work after ${maxRetries} retries (${label})`,
        );
      }

      opts.progress.setActivity(
        `agent returned too quickly (${elapsed}ms), retrying ${attempt}/${maxRetries}...`,
      );
      await sleep(delayMs * attempt);
      continue;
    }

    if (apiError === null) {
      return result;
    }

    if (!apiError.retryable) {
      if (await waitForUsageAvailability(apiError, role, label, opts)) {
        continue;
      }

      await opts.persistence.save(opts.stateAccessor.get());
      const decision = await opts.gate.creditExhausted(
        label,
        describeCreditExhaustion(apiError, result, currentAgent),
      );
      if (decision.kind === "quit") {
        throw new CreditExhaustedError(
          `Terminal API error during ${label}: ${apiError.kind}`,
          result.assistantText.length > 0 ? "mid-response" : "rejected",
        );
      }

      continue;
    }

    attempt++;
    if (attempt > maxRetries) {
      throw new Error(`Max retries (${maxRetries}) exceeded for ${label}: ${apiError.kind}`);
    }

    opts.progress.setActivity(`waiting to retry (${apiError.kind})...`);
    await sleep(delayMs * attempt);
  }
};
