import { defineConfig } from 'vitest/config';
import { resolve } from 'path';

export default defineConfig({
  resolve: {
    alias: {
      "#application": resolve(__dirname, "src/application"),
      "#domain": resolve(__dirname, "src/domain"),
      "#infrastructure": resolve(__dirname, "src/infrastructure"),
      "#ui": resolve(__dirname, "src/ui"),
    },
  },
  test: {
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
  },
});
