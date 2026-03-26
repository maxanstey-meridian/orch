export type VerifyResult = {
  readonly passed: boolean;
  readonly output: string;
  readonly newFailures: string[];
};

const extractSection = (text: string, header: string): string[] => {
  const pattern = new RegExp(`\\*\\*${header}\\*\\*[^:]*:\\s*\\n([\\s\\S]*?)(?=\\n\\*\\*|$)`);
  const match = text.match(pattern);
  if (!match) return [];
  return match[1]
    .split("\n")
    .map((l) => l.replace(/^- /, "").trim())
    .filter((l) => l && l.toLowerCase() !== "none");
};

export const parseVerifyResult = (text: string): VerifyResult => {
  const block = text.match(/### VERIFY_RESULT[\s\S]*$/);
  if (!block) {
    // No structured output — treat as failure with the full text as context
    return { passed: false, output: text, newFailures: [text.slice(0, 500)] };
  }

  const result = block[0];
  const statusMatch = result.match(/\*\*Status:\*\*\s*(PASS|FAIL|PASS_WITH_WARNINGS)/);
  const status = statusMatch?.[1] ?? "FAIL";
  const newFailures = extractSection(result, "New failures");

  return {
    passed: status !== "FAIL",
    output: text,
    newFailures,
  };
};
