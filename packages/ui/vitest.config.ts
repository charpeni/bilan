import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'happy-dom',
    // The golden dashboard files hold local-time figures (merge hour, busiest day).
    env: { TZ: 'UTC' },
  },
});
