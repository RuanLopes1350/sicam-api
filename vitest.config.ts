import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		environment: 'node',
		globals: false,
		include: ['tests/**/*.test.ts'],
		testTimeout: 20000,
		hookTimeout: 20000,
		coverage: {
			provider: 'v8',
			reporter: ['text', 'json-summary'],
			include: ['src/utils/geo/core/**/*.ts', 'src/utils/geo/cartography/**/*.ts'],
			exclude: ['src/utils/geo/core/index.ts', 'src/utils/geo/cartography/index.ts'],
			thresholds: {
				lines: 85,
				functions: 85,
				statements: 85,
				branches: 80,
			},
		},
	},
});
