const { app, BrowserWindow, session  } = require('electron');
const path = require('path');
const server = require('./server');

let mainWindow;

function createWindow(tunnelUrl) {
  mainWindow = new BrowserWindow({
    width: 1000,
    height: 800,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    }
  });

  mainWindow.loadURL(tunnelUrl);
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(async () => {
  try {
    const tunnelUrl = await server.start();
    session.defaultSession.webRequest.onBeforeSendHeaders((details, callback) => {
      details.requestHeaders['bypass-tunnel-reminder'] = 'true';
      callback({ requestHeaders: details.requestHeaders });
    });
    createWindow(tunnelUrl);
  } catch (error) {
    console.error('❌ Failed to start tunnel:', error);
    app.quit();
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    server.stop().then(() => {
      app.quit();
    });
  }
});

app.on('activate', () => {
  if (mainWindow === null) {
    createWindow('http://localhost:3000');
  }
});
