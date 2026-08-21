// Vite+ per-package settings. No build: Node 24 runs `src/index.ts` directly (type stripping), the
// same way the repo runs `scripts/deploy.ts`. `types:check` is the only gate.
export default {
  run: {
    tasks: {
      build: {
        command: 'tsc --noEmit',
        input: [{ auto: true }],
        output: [],
      },
    },
  },
}
