import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    globals: true,
  },
  resolve: {
    alias: {
      '@mi/contracts': path.resolve(__dirname, './src/contracts/index.ts'),
      '@mi/research': path.resolve(__dirname, './src/research/index.ts'),
    },
  },
});
