import { randomUUID } from "crypto";
import { Box, Text, useInput } from "ink";
import { resolve } from "path";
import React, { useMemo, useRef, useState } from "react";
import { addToQueue } from "#infrastructure/queue/queue-store.js";

type QueuePromptProps = {
  readonly queuePath: string;
  readonly onDone: () => void;
  readonly onCancel: () => void;
  readonly defaultRepo?: string;
  readonly addToQueueFn?: typeof addToQueue;
  readonly createId?: () => string;
  readonly now?: () => string;
};

type FieldId = "repo" | "plan" | "branch" | "flags";

const fieldOrder: readonly FieldId[] = ["repo", "plan", "branch", "flags"];

const fieldLabel: Record<FieldId, string> = {
  repo: "Repo",
  plan: "Plan",
  branch: "Branch",
  flags: "Flags",
};

const splitFlags = (value: string): string[] =>
  value
    .split(/\s+/u)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

const ensureQueuedRunFlags = (flags: readonly string[]): string[] => {
  if (flags.includes("--auto")) {
    return [...flags];
  }

  return ["--auto", ...flags];
};

const moveField = (currentField: FieldId, direction: 1 | -1): FieldId => {
  const currentIndex = fieldOrder.indexOf(currentField);
  const nextIndex = (currentIndex + direction + fieldOrder.length) % fieldOrder.length;
  return fieldOrder[nextIndex] ?? currentField;
};

export const QueuePrompt = ({
  queuePath,
  onDone,
  onCancel,
  defaultRepo = process.cwd(),
  addToQueueFn = addToQueue,
  createId = randomUUID,
  now = () => new Date().toISOString(),
}: QueuePromptProps) => {
  const [activeField, setActiveField] = useState<FieldId>("plan");
  const [repoValue, setRepoValue] = useState(defaultRepo);
  const [planValue, setPlanValue] = useState("");
  const [branchValue, setBranchValue] = useState("");
  const [flagsValue, setFlagsValue] = useState("--auto");
  const [errorMessage, setErrorMessage] = useState<string | undefined>(undefined);
  const [submitting, setSubmitting] = useState(false);
  const formStateRef = useRef({
    repoValue: defaultRepo,
    planValue: "",
    branchValue: "",
    flagsValue: "--auto",
  });

  formStateRef.current = {
    repoValue,
    planValue,
    branchValue,
    flagsValue,
  };

  const fields = useMemo(
    () => ({
      repo: {
        value: repoValue,
        setValue: setRepoValue,
      },
      plan: {
        value: planValue,
        setValue: setPlanValue,
      },
      branch: {
        value: branchValue,
        setValue: setBranchValue,
      },
      flags: {
        value: flagsValue,
        setValue: setFlagsValue,
      },
    }),
    [branchValue, flagsValue, planValue, repoValue],
  );

  const submit = async (): Promise<void> => {
    const currentForm = formStateRef.current;
    const trimmedPlan = currentForm.planValue.trim();
    if (trimmedPlan.length === 0) {
      setActiveField("plan");
      setErrorMessage("Plan path is required.");
      return;
    }

    setSubmitting(true);
    setErrorMessage(undefined);

    try {
      await addToQueueFn(queuePath, {
        id: createId(),
        repo: resolve(
          currentForm.repoValue.trim().length === 0 ? defaultRepo : currentForm.repoValue.trim(),
        ),
        planPath: resolve(trimmedPlan),
        ...(currentForm.branchValue.trim().length === 0
          ? {}
          : { branch: currentForm.branchValue.trim() }),
        flags: ensureQueuedRunFlags(splitFlags(currentForm.flagsValue)),
        addedAt: now(),
      });
      onDone();
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setSubmitting(false);
    }
  };

  useInput((input, key) => {
    if (key.escape || key.leftArrow) {
      if (!submitting) {
        onCancel();
      }
      return;
    }

    if (submitting) {
      return;
    }

    if (key.return) {
      void submit();
      return;
    }

    if (key.upArrow) {
      setActiveField((currentField) => moveField(currentField, -1));
      return;
    }

    if (key.downArrow || input === "\t") {
      setActiveField((currentField) => moveField(currentField, 1));
      return;
    }

    if (key.backspace || key.delete) {
      fields[activeField].setValue((currentValue) => currentValue.slice(0, -1));
      return;
    }

    if (input.length > 0 && !key.ctrl && !key.meta) {
      setErrorMessage(undefined);
      fields[activeField].setValue((currentValue) => currentValue + input);
    }
  });

  return (
    <Box flexDirection="column">
      <Text>Queue plan</Text>
      <Text dimColor>↑↓ change field Enter submit ←/Esc cancel</Text>
      {fieldOrder.map((fieldId) => {
        const isActive = fieldId === activeField;
        const value = fields[fieldId].value;

        return (
          <Text key={fieldId} bold={isActive} inverse={isActive}>
            {`${isActive ? ">" : " "} ${fieldLabel[fieldId]}: ${value}${isActive ? "█" : ""}`}
          </Text>
        );
      })}
      {errorMessage === undefined ? null : <Text color="red">{errorMessage}</Text>}
      {submitting ? <Text dimColor>Adding queue entry…</Text> : null}
    </Box>
  );
};
