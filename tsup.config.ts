import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['cjs'],
  target: 'node18',
  clean: true,
  // Make dist/index.js a runnable executable.
  banner: { js: '#!/usr/bin/env node' },
});
