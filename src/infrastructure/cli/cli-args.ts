import {
  DEFAULT_EXECUTION_PREFERENCE,
  type ExecutionPreference,
  type Provider,
} from "#domain/config.js";

const VALID_PROVIDERS: Provider[] = ["claude", "codex"];
const EXECUTION_PREFERENCE_FLAGS = [
  ["--quick", "quick"],
  ["--grouped", "grouped"],
  ["--long", "long"],
] as const satisfies ReadonlyArray<readonly [string, Exclude<ExecutionPreference, "auto">]>;

const isProvider = (v: string): v is Provider => (VALID_PROVIDERS as readonly string[]).includes(v);

export const parseProviderFlag = (args: string[]): Provider => {
  const idx = args.indexOf("--provider");
  if (idx === -1) {
    return "codex";
  }
  const value = args[idx + 1];
  if (!value || value.startsWith("-")) {
    throw new Error(`--provider requires a value (${VALID_PROVIDERS.join(", ")})`);
  }
  if (!isProvider(value)) {
    throw new Error(`Invalid provider '${value}'. Valid providers: ${VALID_PROVIDERS.join(", ")}`);
  }
  return value;
};

export const parseBranchFlag = (args: string[], planId: string): string | undefined => {
  const idx = args.indexOf("--branch");
  if (idx === -1) {
    return undefined;
  }
  const next = args[idx + 1];
  if (!next || next.startsWith("-")) {
    return `orch/${planId}`;
  }
  return next;
};

export const parseTreeFlag = (args: string[]): string | undefined => {
  const idx = args.indexOf("--tree");
  if (idx === -1) {
    return undefined;
  }

  const value = args[idx + 1];
  if (!value || value.startsWith("-")) {
    throw new Error("--tree requires a path value.");
  }

  return value;
};

export const parseExecutionPreference = (args: string[]): ExecutionPreference => {
  const selectedFlags = EXECUTION_PREFERENCE_FLAGS.filter(([flag]) => args.includes(flag));
  if (selectedFlags.length === 0) {
    return DEFAULT_EXECUTION_PREFERENCE;
  }

  if (selectedFlags.length > 1) {
    const selectedFlagList = selectedFlags.map(([flag]) => flag).join(", ");
    throw new Error(
      `Execution mode flags are mutually exclusive: ${selectedFlagList}. Choose only one of --quick, --grouped, or --long.`,
    );
  }

  return selectedFlags[0][1];
};
