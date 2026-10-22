import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { emitAppCommand, registerIpcHandlers, shutdownBackgroundServices } from "./registerIpcHandlers";
import type { AppCommand } from "@codex-code/core";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { Menu, app, BrowserWindow } = require("electron") as typeof import("electron");

let mainWindow: InstanceType<typeof BrowserWindow> | null = null;

const sendCommand = (command: AppCommand) => {
  emitAppCommand(command);
};

const buildMenu = (): void => {
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: "File",
      submenu: [
        {
          label: "Open Folder...",
          click: () => sendCommand("project.openFolder")
        },
        {
          label: "Save",
          accelerator: "CmdOrCtrl+S",
          click: () => sendCommand("file.save")
        },
        {
          label: "Quick Open",
          accelerator: "CmdOrCtrl+P",
          click: () => sendCommand("file.quickOpen")
        },
        {
          label: "Close Tab",
          accelerator: "CmdOrCtrl+W",
          click: () => sendCommand("file.closeActive")
        },
        {
          type: "separator"
        },
        {
          label: "Format Document",
          accelerator: "Shift+Alt+F",
          click: () => sendCommand("lsp.formatDocument")
        },
        {
          label: "Go to Definition",
          accelerator: "F12",
          click: () => sendCommand("lsp.goToDefinition")
        }
      ]
    },
    {
      label: "View",
      submenu: [
        {
          label: "Focus Explorer",
          accelerator: "CmdOrCtrl+Shift+E",
          click: () => sendCommand("pane.focusExplorer")
        },
        {
          label: "Focus Editor",
          accelerator: "CmdOrCtrl+1",
          click: () => sendCommand("pane.focusEditor")
        },
        {
          label: "Focus Chat",
          accelerator: "CmdOrCtrl+3",
          click: () => sendCommand("pane.focusChat")
        },
        {
          label: "Toggle Terminal",
          accelerator: "CmdOrCtrl+`",
          click: () => sendCommand("terminal.toggle")
        },
        {
          label: "Focus Terminal",
          accelerator: "CmdOrCtrl+2",
          click: () => sendCommand("terminal.focus")
        }
      ]
    },
    {
      label: "LSP",
      submenu: [
        {
          label: "Restart Server",
          click: () => sendCommand("lsp.restartServer")
        },
        {
          label: "Stop Server",
          click: () => sendCommand("lsp.stopServer")
        },
        {
          label: "Show Server Status",
          click: () => sendCommand("lsp.showStatus")
        }
      ]
    }
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
};

const createWindow = async (): Promise<void> => {
  mainWindow = new BrowserWindow({
    width: 1600,
    height: 980,
    minWidth: 1200,
    minHeight: 780,
    backgroundColor: "#0d1117",
    titleBarStyle: "hiddenInset",
    webPreferences: {
      preload: path.join(__dirname, "../preload/index.mjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  registerIpcHandlers(mainWindow);
  mainWindow.on("closed", () => {
    void shutdownBackgroundServices();
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    await mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    await mainWindow.loadFile(path.join(__dirname, "../renderer/index.html"));
  }
};

app.whenReady().then(async () => {
  buildMenu();
  await createWindow();

  app.on("activate", async () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      await createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
