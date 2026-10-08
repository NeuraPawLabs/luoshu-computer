import {defineConfig} from 'vitest/config';
export default defineConfig({test:{include:['apps/worker/tests/**/*.test.ts','packages/*/tests/**/*.test.ts'],testTimeout:15000,hookTimeout:15000,pool:'forks',maxWorkers:2}});
