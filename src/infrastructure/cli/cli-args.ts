export const parseBranchFlag = (args: string[], planId: string): string | undefined => {
  const idx = args.indexOf("--branch");
  if (idx === -1) return undefined;
  const next = args[idx + 1];
  if (!next || next.startsWith("-")) return `orch/${planId}`;
  return next;
};
