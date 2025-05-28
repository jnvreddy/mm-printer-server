const { app, BrowserWindow } = require('electron');
const path = require('path');
const server = require('./server'); // Your Express server file

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1000,
    height: 800,
    webPreferences: {
      nodeIntegration: false, // Usually false for security
      contextIsolation: true,
    }
  });

  // Load your Express server URL
  mainWindow.loadURL(`http://localhost:${process.env.PORT || 3000}`);

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// Start Express server then launch Electron window
app.whenReady().then(() => {
  server.start().then(() => {
    createWindow();
  });
});

// Graceful shutdown of Express when Electron app quits
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    server.stop().then(() => {
      app.quit();
    });
  }
});

app.on('activate', () => {
  if (mainWindow === null) createWindow();
});
