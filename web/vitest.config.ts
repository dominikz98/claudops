import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Everything tested here is deliberately DOM-free, so no jsdom is needed:
    // the views are thin and the logic worth asserting lives beside them.
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
});
