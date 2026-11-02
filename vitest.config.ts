import { defineConfig } from 'vitest/config';

export default defineConfig({
  define: { __SERVER_BUILD__: 'false' },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
  },
});
