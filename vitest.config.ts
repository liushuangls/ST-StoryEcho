import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      // These modules are browser-only DOM wiring. Their user-visible contracts
      // are checked by source/style tests and host regression; the V8 thresholds
      // remain focused on executable context-management logic.
      exclude: [
        'src/ui/notifications.ts',
        'src/ui/prompt-stats-card.ts',
        'src/ui/settings-panel.ts',
        'src/ui/summary-manager.ts',
      ],
      reporter: ['text', 'json-summary'],
      thresholds: {
        statements: 74,
        branches: 78,
        functions: 91,
        lines: 74,
      },
    },
  },
});
