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

app.use(cors({ origin: '*', methods: ['GET', 'POST'], allowedHeaders: ['Content-Type', 'Authorization', 'X-Copies', 'X-Size','bypass-tunnel-reminder'] }));
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
        printers: printers.map(p => ({ name: p.name, isConnected: true, status: p.status || 'online' }))
      }
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Internal server error', message: err.message });
  }
});

app.get('/api/tunnel', (req, res) => {
  if (publicUrl) {
    res.json({ success: true, url: publicUrl });
  } else {
    res.status(503).json({ success: false, message: 'Tunnel not ready' });
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

app.post('/api/printer', (req, res) => {
  let copies = parseInt(req.headers['x-copies'] || '1', 10);
  const size = req.headers['x-size'] || '2x6';

  let actualCopies = copies;
  if (size === '2x6' || size === '6x2') {
    actualCopies = Math.ceil(copies / 2);
  }

  //   const sizeFolder = path.join("C:","DNP","HotFolderPrint","Prints", `s${size}`);
  const sizeFolder = path.join(__dirname, "Prints");
  if (!fs.existsSync(sizeFolder)) {
    return res.status(400).json({ 
      success: false, 
      error: `Size folder '${size}' does not exist` 
    });
  }

  const baseTimestamp = Date.now();
  let processedCount = 0;
  let hasResponded = false;
  let currentCopyIndex = 1;

  const createNextFile = () => {
    if (currentCopyIndex > actualCopies || hasResponded) {
      return;
    }

    const baseFilename = `img`;
    const imageFilename = `${baseFilename}.jpg`;
    const jobFilename = `${baseFilename}.job`;

    const imageFilepath = path.join(sizeFolder, imageFilename);
    const jobFilepath = path.join(sizeFolder, jobFilename);

    try {
      // Create image and job files
      fs.writeFileSync(imageFilepath, req.body);
      fs.writeFileSync(jobFilepath, 'copies=1');

      console.log(`Created file set ${currentCopyIndex} of ${actualCopies}: ${imageFilename}`);

      let checkCount = 0;
      const maxChecks = 60; 

      const checkFileProcessed = () => {
        checkCount++;

        // Check if image file has been processed (deleted by printer)
        if (!fs.existsSync(imageFilepath)) {
          console.log(`File ${currentCopyIndex} processed: ${imageFilename}`);
          processedCount++;

          // Delete job file immediately after image is deleted
          if (fs.existsSync(jobFilepath)) {
            try {
              fs.unlinkSync(jobFilepath);
              console.log(`Deleted job file immediately: ${jobFilename}`);
            } catch (err) {
              console.error(`Error deleting job file ${jobFilename}:`, err);
            }
          }

          // Check if this is the last copy
          if (currentCopyIndex === actualCopies) {
            // This is the last copy, send response
            if (!hasResponded) {
              hasResponded = true;
              successfulPrintCount += actualCopies;
              
              return res.status(200).json({
                success: true,
                status: 'All copies printed successfully',
                totalCopies: actualCopies,
                processedCopies: processedCount,
                message: `All ${actualCopies} copies processed and removed from queue`
              });
            }
          } else {
            // Not the last copy, wait 1 second then create next file
            setTimeout(() => {
              currentCopyIndex++;
              createNextFile();
            }, 1000);
          }

          return;
        }

        // Check if we've exceeded the timeout (30 seconds)
        if (checkCount >= maxChecks) {
          console.log(`Timeout for file ${currentCopyIndex}: ${imageFilename}`);
          
          // Clean up current file
          try {
            if (fs.existsSync(imageFilepath)) {
              fs.unlinkSync(imageFilepath);
              console.log(`Timeout cleanup: removed ${imageFilename}`);
            }
            if (fs.existsSync(jobFilepath)) {
              fs.unlinkSync(jobFilepath);
              console.log(`Timeout cleanup: removed ${jobFilename}`);
            }
          } catch (error) {
            console.error(`Error cleaning up files for copy ${currentCopyIndex}:`, error);
          }

          // Send failure response
          if (!hasResponded) {
            hasResponded = true;
            const partialSuccess = processedCount > 0;
            
            return res.status(partialSuccess ? 206 : 408).json({ 
              success: false,
              status: 'Print job failed',
              totalCopies: actualCopies,
              processedCopies: processedCount,
              failedCopies: actualCopies - processedCount,
              message: partialSuccess 
                ? `${processedCount} of ${actualCopies} copies completed before timeout on copy ${currentCopyIndex}`
                : `Print job timed out on copy ${currentCopyIndex} after 30 seconds`
            });
          }
          return;
        }

        // Continue checking every 1 second
        setTimeout(checkFileProcessed, 1000);
      };

      // Start checking this file
      checkFileProcessed();

    } catch (error) {
      console.error(`Error creating print files for copy ${currentCopyIndex}:`, error);
      
      if (!hasResponded) {
        hasResponded = true;
        return res.status(500).json({
          success: false,
          error: 'Failed to create print files',
          details: error.message
        });
      }
    }
  };

  // Start the sequential process
  createNextFile();
});


// app.post('/api/printer', (req, res) => {
//   let copies = parseInt(req.headers['x-copies'] || '1', 10);
//   const size = req.headers['x-size'] || '2x6';

//   if (size === '2x6' || size === '6x2') {
//     copies = Math.ceil(copies / 2);
//   }

//   const sizeFolder = path.join("C:","DNP","HotFolderPrint","Prints", `s${size}`,"RX1HS");
//   // const sizeFolder = path.join(__dirname,"Prints");
//   if (!fs.existsSync(sizeFolder)) {
//     return res.status(400).json({ success: false, error: `Size folder '${size}' does not exist` });
//   }

//   const baseFilename = `print_${printerId}_${Date.now()}`;
//   const savedFiles = [];

//   for (let i = 1; i <= copies; i++) {
//     const filename = `${baseFilename}_c${i}.jpg`;
//     const filepath = path.join(sizeFolder, filename);

//     fs.writeFileSync(filepath, req.body);
//     savedFiles.push(filename);
//   }

//   const firstFilePath = path.join(sizeFolder, `${baseFilename}_c1.jpg`);

//   const checkInterval = setInterval(() => {
//     if (!fs.existsSync(firstFilePath)) {
//       clearInterval(checkInterval);
//       clearTimeout(timeout);

//       for (const filename of savedFiles) {
//         const fp = path.join(sizeFolder, filename);
//         if (fs.existsSync(fp)) fs.unlinkSync(fp);
//       }

//       successfulPrintCount++;

//       return res.status(200).json({
//         success: true,
//         status: 'Printed successfully',
//         files: savedFiles,
//         message: 'Files processed and removed from queue'
//       });
//     }
//   }, 2000);

//   const timeout = setTimeout(() => {
//     clearInterval(checkInterval);

//     try {
//       for (const filename of savedFiles) {
//         const fp = path.join(sizeFolder, filename);
//         if (fs.existsSync(fp)) fs.unlinkSync(fp);
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

let publicUrl = null;

async function start() {
  return new Promise((resolve, reject) => {
    serverInstance = app.listen(PORT, () => {
      console.log(`🚀 Local server running at http://localhost:${PORT}`);
      resolve();
    });

    serverInstance.on('error', (err) => {
      reject(err);
    });
  });
}

async function stop() {
  if (serverInstance) {
    serverInstance.close(() => {
      console.log('🛑 Server stopped');
    });
  }
}
module.exports = { start, stop };

