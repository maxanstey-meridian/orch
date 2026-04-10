import { buildContent, type Group, type Slice } from "#domain/plan.js";

export type ExecutionUnit = {
  readonly kind: "slice" | "group" | "direct";
  readonly label: string;
  readonly content: string;
  readonly sliceNumber: number;
  readonly slices: readonly Slice[];
  readonly groupName: string;
};

export const sliceUnit = (slice: Slice, groupName: string): ExecutionUnit => ({
  kind: "slice",
  label: `Slice ${slice.number}`,
  content: buildContent(slice),
  sliceNumber: slice.number,
  slices: [slice],
  groupName,
});

export const groupedUnit = (group: Group): ExecutionUnit => {
  const representativeSliceNumber = group.slices[group.slices.length - 1]?.number ?? 0;
  const content = group.slices
    .map((slice) => `### Slice ${slice.number}: ${slice.title}\n\n${slice.content}`)
    .join("\n\n---\n\n");

  return {
    kind: "group",
    label: `Group ${group.name}`,
    content,
    sliceNumber: representativeSliceNumber,
    slices: group.slices,
    groupName: group.name,
  };
};

export const directUnit = (
  requestContent: string,
  representativeSliceNumber: number,
): ExecutionUnit => ({
  kind: "direct",
  label: "Direct request",
  content: requestContent,
  sliceNumber: representativeSliceNumber,
  slices: [],
  groupName: "Direct",
});
