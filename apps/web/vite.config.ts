import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';

export default defineConfig({
  plugins: [preact()],
  root: '.',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    copyPublicDir: false, // Copied manually post-build to avoid EPERM on overlayfs (copy_file_range)
    rollupOptions: {
      output: {
        manualChunks: {
          // Split xterm (283KB, 42% of bundle) into its own chunk.
          // Loads in parallel with the main app but doesn't block first paint.
          xterm: ['@xterm/xterm', '@xterm/addon-fit'],
        },
      },
    },
  },
  server: {
    proxy: {
      '/api': 'http://localhost:8080',
      '/ws': { target: 'ws://localhost:8080', ws: true },
    },
  },
});
