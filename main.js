/*============================================================
  main.js
  Processo principal do Electron. Cria a janela do app e carrega
  o index.html existente do Kapo Analytics. Nenhuma lógica do
  dashboard foi alterada — este arquivo só empacota o que já
  existe como um programa desktop.
==============================================================*/

const { app, BrowserWindow } = require("electron");
const path = require("path");

let mainWindow = null;

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1400,
        height: 900,
        minWidth: 1000,
        minHeight: 650,
        icon: path.join(__dirname, "build", "icon.ico"),
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true
        },
        autoHideMenuBar: true, // remove a barra de menu padrão (File/Edit/View...)
        show: false
    });

    mainWindow.loadFile(path.join(__dirname, "HTML", "index.html"));

    // Só mostra a janela quando o conteúdo já carregou, evita "flash" branco
    mainWindow.once("ready-to-show", () => {
        mainWindow.show();
    });

    mainWindow.on("closed", () => {
        mainWindow = null;
    });
}

app.whenReady().then(createWindow);

app.on("window-all-closed", () => {
    if (process.platform !== "darwin") {
        app.quit();
    }
});

app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
    }
});