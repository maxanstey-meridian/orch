export type SubcommandResult =
  | { command: "work"; planPath: string; flags: string[] }
  | { command: "dash" }
  | { command: "status"; id?: string; follow?: boolean }
  | { command: "queue"; action: "add"; planPath: string; flags: string[] }
  | { command: "queue"; action: "list" }
  | { command: "queue"; action: "remove"; id: string }
  | { command: "plan"; inventoryPath: string; flags: string[] }
  | { command: "legacy"; args: string[] };

export const parseSubcommand = (argv: string[]): SubcommandResult => {
  if (argv[2] === "work") {
    const planPath = argv[3];
    if (!planPath || planPath.startsWith("-")) {
      return {
        command: "legacy",
        args: argv.slice(2),
      };
    }

    return {
      command: "work",
      planPath,
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
    const planPath = argv[4];
    if (!planPath || planPath.startsWith("-")) {
      return {
        command: "legacy",
        args: argv.slice(2),
      };
    }

    return {
      command: "queue",
      action: "add",
      planPath,
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
    const id = argv[4];
    if (!id || id.startsWith("-")) {
      return {
        command: "legacy",
        args: argv.slice(2),
      };
    }

    return {
      command: "queue",
      action: "remove",
      id,
    };
  }

  if (argv[2] === "plan") {
    const inventoryPath = argv[3];
    if (!inventoryPath || inventoryPath.startsWith("-")) {
      return {
        command: "legacy",
        args: argv.slice(2),
      };
    }

    return {
      command: "plan",
      inventoryPath,
      flags: argv.slice(4),
    };
  }

  return {
    command: "legacy",
    args: argv.slice(2),
  };
};
