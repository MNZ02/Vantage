import { defineConfig } from "vite";

export default defineConfig({
  build: {
    // Keep the stable rendering engine separate from rapidly changing game
    // code so repeat deployments and browser caches do not redownload both.
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes("/node_modules/three/")) return "three-vendor";
          return undefined;
        },
      },
    },
    chunkSizeWarningLimit: 650,
  },
});
