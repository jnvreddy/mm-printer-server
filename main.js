const { app, BrowserWindow } = require('electron');
const server = require('./server');
const { startCloudflareTunnel, stopCloudflareTunnel } = require('./cloudflare');

let mainWindow;

function createWindow(urlToLoad = 'http://localhost:3000') {
  console.log(`🪟 Creating window with URL: ${urlToLoad}`);

  mainWindow = new BrowserWindow({
    width: 1000,
    height: 800,
    show: false,
    autoHideMenuBar: true,
    skipTaskbar: false,
    focusable: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true
    }
  });

  mainWindow.loadURL(urlToLoad)
    .then(() => console.log(`✅ Loaded: ${urlToLoad}`))
    .catch(err => console.error(`❌ Failed to load ${urlToLoad}`, err));

  mainWindow.once('ready-to-show', () => {
    console.log(`✅ Window ready to show`);
    mainWindow.show();
});

  setTimeout(() => {
    if (!mainWindow.isVisible()) {
      console.warn('⚠️ Forcing window show after 10s delay');
      mainWindow.show();
    }
  }, 10000);

  mainWindow.on('closed', () => {
    console.log('🧹 Window closed.');
    mainWindow = null;
  });

  //mainWindow.webContents.openDevTools({ mode: 'detach' });
}

app.whenReady().then(async () => {
  try {
    console.log('🔧 Starting local server...');
    await server.start();
    console.log('✅ Local server running at http://localhost:3000');

    let tunnelUrl;
    try {
      console.log('🌐 Starting Cloudflare tunnel...');
      tunnelUrl = await startCloudflareTunnel();
      console.log(`🌐 Cloudflare tunnel: ${tunnelUrl}`);
    } catch (err) {
      console.error('⚠️ Tunnel failed. Falling back to localhost.', err.message);
    }

    createWindow(tunnelUrl || 'http://localhost:3000');
  } catch (err) {
    console.error('❌ Startup failed:', err);
    app.quit();
  }
});

app.on('window-all-closed', () => {
  stopCloudflareTunnel();
  if (process.platform !== 'darwin') {
    server.stop().then(() => app.quit());
  }
});

app.on('activate', () => {
  if (mainWindow === null) {
    createWindow('http://localhost:3000');
  }
});
