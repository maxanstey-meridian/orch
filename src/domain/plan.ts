export type FileAction = {
  readonly path: string;
  readonly action: "new" | "edit" | "delete";
};

export type Slice = {
  readonly number: number;
  readonly title: string;
  readonly content: string;
  readonly why: string;
  readonly files: readonly FileAction[];
  readonly details: string;
  readonly tests: string;
};

export type Group = {
  readonly name: string;
  readonly slices: readonly Slice[];
};

const formatFiles = (files: readonly FileAction[]): string =>
  files.map((f) => `\`${f.path}\` (${f.action})`).join(", ");

export const buildContent = (s: {
  readonly number: number;
  readonly title: string;
  readonly why: string;
  readonly files: readonly FileAction[];
  readonly details: string;
  readonly tests: string;
}): string =>
  `### Slice ${s.number}: ${s.title}\n\n**Why:** ${s.why}\n\n**Files:** ${formatFiles(s.files)}\n\n${s.details}\n\n**Tests:** ${s.tests}`;
