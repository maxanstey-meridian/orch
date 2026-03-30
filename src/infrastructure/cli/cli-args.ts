import type { Provider } from "../../domain/config.js";

const VALID_PROVIDERS: Provider[] = ["claude", "codex"];

export const parseProviderFlag = (args: string[]): Provider => {
  const idx = args.indexOf("--provider");
  if (idx === -1) return "claude";
  const value = args[idx + 1];
  if (!value || value.startsWith("-")) {
    throw new Error(`--provider requires a value (${VALID_PROVIDERS.join(", ")})`);
  }
  if (!VALID_PROVIDERS.includes(value as Provider)) {
    throw new Error(
      `Invalid provider '${value}'. Valid providers: ${VALID_PROVIDERS.join(", ")}`,
    );
  }
  return value as Provider;
};

export const parseBranchFlag = (args: string[], planId: string): string | undefined => {
  const idx = args.indexOf("--branch");
  if (idx === -1) return undefined;
  const next = args[idx + 1];
  if (!next || next.startsWith("-")) return `orch/${planId}`;
  return next;
};
