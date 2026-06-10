import { defineConfig } from 'vite';
import wasm from 'vite-plugin-wasm';
import topLevelAwait from 'vite-plugin-top-level-await';

// Rapier ships as a WASM module and uses top-level await; both plugins are
// required for Vite to bundle it correctly.
export default defineConfig({
  plugins: [wasm(), topLevelAwait()],
  optimizeDeps: {
    // Rapier's compat build needs to be excluded from dep pre-bundling so the
    // WASM plugin can handle it.
    exclude: ['@dimforge/rapier3d-compat'],
  },
  build: {
    target: 'esnext',
  },
});
