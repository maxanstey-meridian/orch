const CLEAN_PATTERNS = [
  /\bno\s+issues?\s+found\b/i,
  /\bno\s+findings\b/i,
  /\bno\s+action\s+required\b/i,
  /\bno\s+bugs\b/i,
  /\bno\s+problems\b/i,
  /\blgtm\b/i,
  /\blooks\s+good\b/i,
  /\bship\s+it\b/i,
  /\bno\s+changes?\s+(needed|required|necessary)\b/i,
  /\bapproved\b/i,
  /\ball\s+good\b/i,
  /\bnothing\s+to\s+(fix|change|report)\b/i,
  /\bcode\s+is\s+clean\b/i,
];

export const isCleanReview = (text: string): boolean => {
  const trimmed = text.trim();
  if (!trimmed) return true;
  if (trimmed === "NO_ISSUES_FOUND") return true;
  return CLEAN_PATTERNS.some((p) => p.test(trimmed));
};
