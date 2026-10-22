/// <reference types="vite/client" />

import type { DesktopApi } from "@codex-code/core";

declare global {
  interface Window {
    codexCode: DesktopApi;
  }
}

export {};
