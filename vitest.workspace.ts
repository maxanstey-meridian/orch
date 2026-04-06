export default [
  {
    extends: "./vitest.config.ts",
    test: {
      name: "unit",
      include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"],
      exclude: [
        "tests/registry/run-registry.test.ts",
        "tests/queue/queue-store.test.ts",
        "tests/cli/verify.test.ts",
      ],
    },
  },
  {
    extends: "./vitest.config.ts",
    test: {
      name: "cross-process",
      include: [
        "tests/registry/run-registry.test.ts",
        "tests/queue/queue-store.test.ts",
        "tests/cli/verify.test.ts",
      ],
      pool: "forks" as const,
      poolOptions: {
        forks: { singleFork: true },
      },
    },
  },
];
