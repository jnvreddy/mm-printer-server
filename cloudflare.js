const { spawn } = require('child_process');
const path = require('path');
const { app } = require('electron');

let tunnelProcess;

async function startCloudflareTunnel() {
  return new Promise((resolve, reject) => {
    const basePath = app.isPackaged ? process.resourcesPath : __dirname;
    const configPath = path.join(basePath, 'config', 'tunnel.yml');
    const binaryPath = path.join(basePath, 'cloudflared.exe');

    let resolved = false;

    tunnelProcess = spawn(binaryPath, ['tunnel', '--config', configPath, 'run'], {
      cwd: basePath,
      shell: false,
      windowsHide: true
    });

    console.log('🚀 cloudflared process started...');

    tunnelProcess.stdout.on('data', (data) => {
      const output = data.toString();
      console.log('[cloudflared]', output);

      const match = output.match(/https:\/\/[^\s]+/);
      if (match && !resolved) {
        resolved = true;
        resolve(match[0]);
      }
    });

    tunnelProcess.stderr.on('data', (data) => {
      console.error('[cloudflared ERROR]', data.toString());
    });

    tunnelProcess.on('close', (code) => {
      console.log(`cloudflared exited with code ${code}`);
    });

    tunnelProcess.on('error', (err) => {
      console.error('❌ Error running cloudflared:', err);
      if (!resolved) reject(err);
    });

    // ✅ Fallback: proceed with localhost if no URL in 7s
    setTimeout(() => {
      if (!resolved) {
        console.warn('⏱️ Timeout: cloudflared did not return a URL. Falling back to localhost.');
        resolved = true;
        resolve(null);
      }
    }, 7000);
  });
}

function stopCloudflareTunnel() {
  if (tunnelProcess) {
    tunnelProcess.kill();
  }
}

module.exports = { startCloudflareTunnel, stopCloudflareTunnel };
