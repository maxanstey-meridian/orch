const CLEAN_PATTERNS = [
  /\bno\s+issues?\s+found\b/i,
  /\bno\s+findings\b/i,
  /\bno\s+action\s+required\b/i,
  /\bno\s+bugs\b/i,
  /\bno\s+problems\b/i,
  /\blgtm\b/i,
  /\blooks\s+good\b/i,
];

export const isCleanReview = (text: string): boolean => {
  const trimmed = text.trim();
  if (!trimmed) return true;
  if (trimmed === 'NO_ISSUES_FOUND') return true;
  return CLEAN_PATTERNS.some(p => p.test(trimmed));
};
