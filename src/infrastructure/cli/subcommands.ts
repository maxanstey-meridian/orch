export type SubcommandResult =
  | { command: "work"; planPath: string; flags: string[] }
  | { command: "dash" }
  | { command: "status"; id?: string; follow?: boolean }
  | { command: "queue"; action: "add" | "list" | "remove"; planPath?: string; id?: string; flags?: string[] }
  | { command: "plan"; inventoryPath: string; flags: string[] }
  | { command: "legacy"; args: string[] };

export const parseSubcommand = (argv: string[]): SubcommandResult => {
  if (argv[2] === "work") {
    return {
      command: "work",
      planPath: argv[3] ?? "",
      flags: argv.slice(4),
    };
  }

  if (argv[2] === "dash") {
    return {
      command: "dash",
    };
  }

  if (argv[2] === "status") {
    const statusArgs = argv.slice(3);
    const id = statusArgs.find((arg) => !arg.startsWith("-"));
    const follow = statusArgs.includes("-f");
    return {
      command: "status",
      ...(id ? { id } : {}),
      ...(follow ? { follow: true } : {}),
    };
  }

  if (argv[2] === "queue" && argv[3] === "add") {
    return {
      command: "queue",
      action: "add",
      planPath: argv[4],
      flags: argv.slice(5),
    };
  }

  if (argv[2] === "queue" && argv[3] === "list") {
    return {
      command: "queue",
      action: "list",
    };
  }

  if (argv[2] === "queue" && argv[3] === "remove") {
    return {
      command: "queue",
      action: "remove",
      id: argv[4],
    };
  }

  if (argv[2] === "plan") {
    return {
      command: "plan",
      inventoryPath: argv[3] ?? "",
      flags: argv.slice(4),
    };
  }

  return {
    command: "legacy",
    args: argv.slice(2),
  };
};
