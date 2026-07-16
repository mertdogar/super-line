import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts', 'src/server.ts', 'src/client.ts', 'src/react.tsx', 'src/ai.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  target: 'es2022',
  clean: true,
  external: ['@super-line/core', '@super-line/server', '@super-line/client', '@super-line/plugin-auth', 'zod', 'react', 'react/jsx-runtime', 'ai'],
})
