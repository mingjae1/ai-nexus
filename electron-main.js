'use strict';

const { app, BrowserWindow, session } = require('electron');
const path = require('path');
const { fork } = require('child_process');
const net = require('net');

let mainWindow;
let serverProcess;
const PORT = 7899;
const isPortable = app.isPackaged && Boolean(process.env.PORTABLE_EXECUTABLE_DIR);

function checkServerReady(callback) {
  const client = new net.Socket();
  const tryConnection = () => {
    client.connect({ port: PORT, host: '127.0.0.1' }, () => {
      client.destroy();
      callback();
    });
  };

  client.on('error', () => {
    setTimeout(tryConnection, 200);
  });

  tryConnection();
}

function createWindow() {
  const windowTitle = isPortable
    ? 'AI Nexus: Ultimate AI Orchestrator (Portable)'
    : 'AI Nexus: Ultimate AI Orchestrator';

  mainWindow = new BrowserWindow({
    width: 600,
    height: 800,
    resizable: true,
    title: windowTitle,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      additionalArguments: ['--is-portable=' + isPortable]
    },
    backgroundColor: '#0a0e17'
  });

  mainWindow.setMenuBarVisibility(false);

  checkServerReady(() => {
    mainWindow.loadURL(`http://127.0.0.1:${PORT}`);
  });

  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const allowed = `http://127.0.0.1:${PORT}`;
    if (!url.startsWith(allowed)) {
      event.preventDefault();
    }
  });

  mainWindow.on('closed', function () {
    mainWindow = null;
  });
}

function startServer() {
  const serverCwd = isPortable ? process.env.PORTABLE_EXECUTABLE_DIR : __dirname;
  
  serverProcess = fork(path.join(__dirname, 'server.js'), [], {
    cwd: serverCwd,
    env: { 
      ...process.env, 
      ELECTRON_RUNNING: 'true',
      IS_PORTABLE: String(isPortable),
      RESOURCES_PATH: process.resourcesPath,
      APP_DIR: __dirname
    },
    stdio: 'inherit'
  });

  serverProcess.on('exit', (code) => {
    if (code !== 0 && code !== null) {
      console.error(`Server process exited with code ${code}`);
    }
  });
}

app.on('ready', () => {
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(false);
  });
  startServer();
  createWindow();
});

app.on('window-all-closed', function () {
  if (process.platform !== 'darwin') {
    if (serverProcess) serverProcess.kill();
    app.quit();
  }
});

app.on('activate', function () {
  if (mainWindow === null) createWindow();
});

app.on('will-quit', () => {
  if (serverProcess) serverProcess.kill();
});
