import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['agent/**/*.test.js', 'studio/**/*.test.ts'],
    environment: 'node',
  },
})
