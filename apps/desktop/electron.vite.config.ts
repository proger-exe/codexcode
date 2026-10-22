import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "electron-vite";
import react from "@vitejs/plugin-react";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const resolveAlias = {
  "@codex-code/core": path.resolve(__dirname, "../../packages/core/src/index.ts"),
  "@codex-code/ui": path.resolve(__dirname, "../../packages/ui/src/index.ts"),
  "@codex-code/templates": path.resolve(__dirname, "../../packages/templates/src/index.ts")
};

export default defineConfig({
  main: {
    resolve: {
      alias: resolveAlias
    }
  },
  preload: {
    resolve: {
      alias: resolveAlias
    }
  },
  renderer: {
    plugins: [react()],
    resolve: {
      alias: resolveAlias
    },
    build: {
      rollupOptions: {
        input: path.resolve(__dirname, "src/renderer/index.html")
      }
    }
  }
});
