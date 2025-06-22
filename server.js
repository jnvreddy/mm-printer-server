const express = require('express');
const path = require('path');
const fs = require('fs');
const cors = require('cors');
const morgan = require('morgan');
const { v4: uuidv4 } = require('uuid');
const { getPrinters } = require('pdf-to-printer');
const chokidar = require('chokidar');
require('dotenv').config();

process.on('uncaughtException', (error) => {
  console.error('UNCAUGHT EXCEPTION - keeping process alive:', error);
});

process.on('unhandledRejection', (reason) => {
  console.error('UNHANDLED REJECTION - keeping process alive. Reason:', reason);
});

const app = express();
const PORT = process.env.PORT || 3000;

// Add print counter
let successfulPrintCount = 0;

const DNP_PRINTER_CONFIG = {
  name: 'DNS XH1',
  paperSizes: [
    { name: '2x6', width: 2, height: 6 },
    { name: '4x6', width: 4, height: 6 },
    { name: '6x8', width: 6, height: 8 },
    { name: '6x9', width: 6, height: 9 }
  ],
  defaultSize: '2x6'
};

const safeGetPrinters = async () => {
  try {
    const printers = await getPrinters();
    console.log("Detected printers:", printers);
    return printers;
  } catch (err) {
    console.error('Failed to fetch printers:', err);
    return [];
  }
};

app.use(cors({ origin: '*', methods: ['GET', 'POST'], allowedHeaders: ['Content-Type', 'Authorization', 'X-Copies', 'X-Size'] }));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

app.use((req, res, next) => {
  req.id = uuidv4();
  next();
});

app.use(morgan((tokens, req, res) => {
  return [
    `[${new Date().toISOString()}]`,
    `[${req.id}]`,
    tokens.method(req, res),
    tokens.url(req, res),
    tokens.status(req, res),
    tokens['response-time'](req, res), 'ms'
  ].join(' ');
}));

app.use(express.static(path.join(__dirname, 'public')));

const authenticateRequest = (req, res, next) => {
  try {
    const apiKey = req.headers.authorization;
    if (!process.env.API_KEY) return next();
    if (!apiKey || apiKey !== process.env.API_KEY) {
      return res.status(401).json({ success: false, error: 'Unauthorized', message: 'Invalid or missing API key' });
    }
    next();
  } catch (error) {
    console.error('Authentication error:', error);
    return res.status(500).json({ success: false, error: 'Authentication error' });
  }
};

app.get('/api/dashboard/stats', async (req, res) => {
  try {
    const printers = await safeGetPrinters();
    return res.json({
      success: true,
      stats: {
        successfulPrints: successfulPrintCount,
        apiKey: process.env.API_KEY || null,
        printers: printers.map(p => ({ name: p.name, isConnected: true, status: p.status || 'online' }))
      }
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Internal server error', message: err.message });
  }
});

app.get('/api/printers', async (req, res) => {
  try {
    const printers = await safeGetPrinters();
    return res.json({
      success: true,
      printers: printers.map(p => ({ id: p.name, name: p.name, isConnected: true }))
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Internal server error', message: err.message });
  }
});

//app.use('/api/printer', authenticateRequest);

const safeCleanupFiles = (files) => {
  if (!Array.isArray(files)) files = [files];
  files.forEach(file => {
    try {
      if (file && fs.existsSync(file)) fs.unlinkSync(file);
    } catch (e) {
      console.error(`Error removing file ${file}:`, e);
    }
  });
};

app.get('/api/printer', async (req, res) => {
  try {
    const printers = await safeGetPrinters();
    return res.json({
      success: true,
      printers: printers.map(p => ({ id: p.name, name: p.name, isConnected: true }))
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Internal server error', message: err.message });
  }
});

app.use('/api/printer', express.raw({ type: 'image/jpeg', limit: '10mb' }));

// app.post('/api/printer', (req, res) => {
//   const printerId = req.headers['x-printer-id'] || "DNP Printer";
//   let copies = parseInt(req.headers['x-copies'] || '1', 10);
//   const size = req.headers['x-size'] || '2x6';

//   if (size === '2x6' || size === '6x2') {
//     copies = Math.ceil(copies / 2); 
//   }

//   const sizeFolder = path.join(__dirname, size);
//   if (!fs.existsSync(sizeFolder)) {
//     return res.status(400).json({ success: false, error: `Size folder '${size}' does not exist` });
//   }

//   const baseFilename = `print_${printerId}_${Date.now()}`;
//   const imageFilename = `${baseFilename}.jpg`;
//   const jobFilename = `${baseFilename}.job`;

//   const imageFilepath = path.join(sizeFolder, imageFilename);
//   const jobFilepath = path.join(sizeFolder, jobFilename);

//   fs.writeFileSync(imageFilepath, req.body);
//   fs.writeFileSync(jobFilepath, `copies=${copies}\nprinter=${printerId}\nsize=${size}`);

//   const checkInterval = setInterval(() => {
//     if (!fs.existsSync(imageFilepath)) {
//       clearInterval(checkInterval);
//       clearTimeout(timeout);
      
//       if (fs.existsSync(jobFilepath)) {
//         fs.unlinkSync(jobFilepath);
//       }
      
//       successfulPrintCount++;
      
//       return res.status(200).json({
//         success: true,
//         status: 'Printed successfully',
//         file: imageFilename,
//         message: 'File processed and removed from queue'
//       });
//     }
//   }, 2000); 

//   const timeout = setTimeout(() => {
//     clearInterval(checkInterval);
    
//     try {
//       if (fs.existsSync(imageFilepath)) {
//         fs.unlinkSync(imageFilepath);
//       }
//       if (fs.existsSync(jobFilepath)) {
//         fs.unlinkSync(jobFilepath);
//       }
//     } catch (error) {
//       console.error('Error cleaning up files on timeout:', error);
//     }
    
//     return res.status(202).json({ 
//       success: false, 
//       message: 'Timed out waiting for printer response.' 
//     });
//   }, 30000);
// });

app.post('/api/printer', (req, res) => {
  const printerId = req.headers['x-printer-id'] || "DNP Printer";
  let copies = parseInt(req.headers['x-copies'] || '1', 10);
  const size = req.headers['x-size'] || '2x6';

  if (size === '2x6' || size === '6x2') {
    copies = Math.ceil(copies / 2);
  }

  const sizeFolder = path.join("C:","DNP","HotFolderPrint","Prints", `s${size}`);
  // const sizeFolder = path.join(__dirname,"Prints");
  if (!fs.existsSync(sizeFolder)) {
    return res.status(400).json({ success: false, error: `Size folder '${size}' does not exist` });
  }

  const baseFilename = `print_${printerId}_${Date.now()}`;
  const savedFiles = [];

  for (let i = 1; i <= copies; i++) {
    const filename = `${baseFilename}_c${i}.jpg`;
    const filepath = path.join(sizeFolder, filename);

    fs.writeFileSync(filepath, req.body);
    savedFiles.push(filename);
  }

  const firstFilePath = path.join(sizeFolder, `${baseFilename}_c1.jpg`);

  const checkInterval = setInterval(() => {
    if (!fs.existsSync(firstFilePath)) {
      clearInterval(checkInterval);
      clearTimeout(timeout);

      for (const filename of savedFiles) {
        const fp = path.join(sizeFolder, filename);
        if (fs.existsSync(fp)) fs.unlinkSync(fp);
      }

      successfulPrintCount++;

      return res.status(200).json({
        success: true,
        status: 'Printed successfully',
        files: savedFiles,
        message: 'Files processed and removed from queue'
      });
    }
  }, 2000);

  const timeout = setTimeout(() => {
    clearInterval(checkInterval);

    try {
      for (const filename of savedFiles) {
        const fp = path.join(sizeFolder, filename);
        if (fs.existsSync(fp)) fs.unlinkSync(fp);
      }
    } catch (error) {
      console.error('Error cleaning up files on timeout:', error);
    }

    return res.status(202).json({ 
      success: false, 
      message: 'Timed out waiting for printer response.' 
    });
  }, 30000);
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/health', (req, res) => {
  res.json({
    status: 'UP',
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
  });
});

app.use('/api', (req, res) => {
  res.status(404).json({
    success: false,
    error: 'Not Found',
    message: `The requested endpoint '${req.originalUrl}' does not exist.`
  });
});

app.use((err, req, res, next) => {
  console.error(`Error in request ${req.id}:`, err);
  if (res.headersSent) return next(err);
  res.status(500).json({ success: false, error: 'Server error', message: err.message, requestId: req.id });
});

app.use((req, res) => {
  if (req.accepts('html')) {
    res.status(404).sendFile(path.join(__dirname, 'public', '404.html'));
  } else {
    res.status(404).json({ success: false, error: 'Not Found' });
  }
});

// 404 fallback page generation
const notFoundPath = path.join(__dirname, 'public', '404.html');
if (!fs.existsSync(notFoundPath)) {
  if (!fs.existsSync(path.join(__dirname, 'public'))) {
    fs.mkdirSync(path.join(__dirname, 'public'), { recursive: true });
  }
  fs.writeFileSync(notFoundPath, `
    <!DOCTYPE html>
    <html><head><title>404</title></head><body><h1>404 - Not Found</h1></body></html>
  `);
}

let serverInstance;

async function start() {
  return new Promise((resolve, reject) => {
    serverInstance = app.listen(PORT, '0.0.0.0', async () => {
      console.log(`Server running on port ${PORT}`);
      try {
        const printers = await safeGetPrinters();
        if (printers.length > 0) {
          console.log('Available printers:');
          printers.forEach(p => console.log(`- ${p.name}`));
        } else {
          console.log('⚠️ No printers detected.');
        }
      } catch (err) {
        console.error('Error detecting printers:', err);
      }
      resolve();
    });

    serverInstance.on('error', (error) => {
      if (error.code === 'EADDRINUSE') {
        console.error(`Port ${PORT} is in use. Retrying...`);
        setTimeout(() => {
          serverInstance.close();
          start();
        }, 5000);
      } else {
        console.error('Server error:', error);
        reject(error);
      }
    });
  });
}

async function stop() {
  return new Promise((resolve, reject) => {
    if (serverInstance) {
      serverInstance.close((err) => {
        if (err) {
          reject(err);
        } else {
          console.log('Server stopped');
          resolve();
        }
      });
    } else {
      resolve();
    }
  });
}

// Export start and stop to use from Electron
module.exports = { start, stop };

