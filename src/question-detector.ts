const TAIL_LENGTH = 500;

export const detectQuestion = (output: string): boolean => {
  if (!output) return false;

  const tail = output.slice(-TAIL_LENGTH);
  const stripped = tail.replace(/[\s`]*$/, '');

  if (stripped.endsWith('?')) return true;

  const PATTERNS = [
    /what do you think/i,
    /should (?:I|we)\b/i,
    /want me to\b/i,
    /before I proceed/i,
    /any (?:thoughts|feedback|preferences)/i,
    /let me know/i,
    /how would you like/i,
  ];

  for (const pattern of PATTERNS) {
    if (pattern.test(stripped)) return true;
  }

  return false;
};
