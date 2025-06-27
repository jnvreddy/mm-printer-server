const express = require('express');
const path = require('path');
const fs = require('fs');
const cors = require('cors');
const morgan = require('morgan');
const localtunnel = require('localtunnel');
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
        apiKey: process.env.API_KEY || null,
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

  // Apply the halving logic for 2x6 and 6x2 sizes
  let actualCopies = copies;
  if (size === '2x6' || size === '6x2') {
    actualCopies = Math.ceil(copies / 2);
  }

  const sizeFolder = path.join("C:", "DNP", "HotFolderPrint", "Prints", `s${size}`);

  //const sizeFolder = path.join(__dirname, "Prints");
  if (!fs.existsSync(sizeFolder)) {
    return res.status(400).json({ 
      success: false, 
      error: `Size folder '${size}' does not exist` 
    });
  }

  const baseTimestamp = Date.now();
  const createdFiles = [];
  
  try {
    // Create separate image and job files for each copy
    for (let i = 1; i <= actualCopies; i++) {
      const baseFilename = `print_DS1HX_${baseTimestamp}_copy${i}`;
      const imageFilename = `${baseFilename}.jpg`;
      const jobFilename = `${baseFilename}.job`;

      const imageFilepath = path.join(sizeFolder, imageFilename);
      const jobFilepath = path.join(sizeFolder, jobFilename);

      // Write the image file (same image for each copy)
      fs.writeFileSync(imageFilepath, req.body);
      
      // Write the job file (1 copy per job file since we're creating multiple files)
      fs.writeFileSync(jobFilepath, 'copies=1');

      createdFiles.push({
        copyNumber: i,
        imageFilename,
        jobFilename,
        imageFilepath,
        jobFilepath,
        processed: false
      });
    }

    console.log(`Created ${actualCopies} sets of files for printing`);

    // Track the processing of all files
    let processedCount = 0;
    let hasResponded = false;

    const checkAllFiles = () => {
      let allProcessed = true;
      let currentProcessedCount = 0;

      createdFiles.forEach(file => {
        if (!file.processed && !fs.existsSync(file.imageFilepath)) {
          file.processed = true;
          currentProcessedCount++;
          console.log(`File ${file.copyNumber} processed: ${file.imageFilename}`);
          
          // Clean up job file if it still exists
          if (fs.existsSync(file.jobFilepath)) {
            setTimeout(() => {
              try {
                if (fs.existsSync(file.jobFilepath)) {
                  fs.unlinkSync(file.jobFilepath);
                  console.log(`Cleaned up job file: ${file.jobFilename}`);
                }
              } catch (err) {
                console.error(`Error deleting job file ${file.jobFilename}:`, err);
              }
            }, 2000);
          }
        }
        
        if (file.processed) {
          currentProcessedCount++;
        } else if (fs.existsSync(file.imageFilepath)) {
          allProcessed = false;
        }
      });

      processedCount = currentProcessedCount;

      // Send response when all files are processed
      if (allProcessed && processedCount === actualCopies && !hasResponded) {
        hasResponded = true;
        clearInterval(checkInterval);
        clearTimeout(timeout);

        setTimeout(() => {
          successfulPrintCount += actualCopies;
          return res.status(200).json({
            success: true,
            status: 'All copies printed successfully',
            totalCopies: actualCopies,
            processedCopies: processedCount,
            message: `All ${actualCopies} copies processed and removed from queue`
          });
        }, 3000);
      }
    };

    // Check every 2 seconds for file processing
    const checkInterval = setInterval(checkAllFiles, 2000);

    // Timeout after 60 seconds
    const timeout = setTimeout(() => {
      if (hasResponded) return;
      
      hasResponded = true;
      clearInterval(checkInterval);

      // Clean up any remaining files
      createdFiles.forEach(file => {
        try {
          if (fs.existsSync(file.imageFilepath)) {
            fs.unlinkSync(file.imageFilepath);
            console.log(`Timeout cleanup: removed ${file.imageFilename}`);
          }
          if (fs.existsSync(file.jobFilepath)) {
            fs.unlinkSync(file.jobFilepath);
            console.log(`Timeout cleanup: removed ${file.jobFilename}`);
          }
        } catch (error) {
          console.error(`Error cleaning up files for copy ${file.copyNumber}:`, error);
        }
      });

      const partialSuccess = processedCount > 0;
      
      return res.status(partialSuccess ? 206 : 202).json({ 
        success: partialSuccess,
        status: partialSuccess ? 'Partially completed' : 'Timed out',
        totalCopies: actualCopies,
        processedCopies: processedCount,
        failedCopies: actualCopies - processedCount,
        message: partialSuccess 
          ? `${processedCount} of ${actualCopies} copies completed before timeout`
          : 'Timed out waiting for printer response'
      });
    }, 60000);

  } catch (error) {
    console.error('Error creating print files:', error);
    
    // Clean up any files that were created
    createdFiles.forEach(file => {
      try {
        if (fs.existsSync(file.imageFilepath)) {
          fs.unlinkSync(file.imageFilepath);
        }
        if (fs.existsSync(file.jobFilepath)) {
          fs.unlinkSync(file.jobFilepath);
        }
      } catch (cleanupError) {
        console.error(`Error cleaning up file ${file.imageFilename}:`, cleanupError);
      }
    });

    return res.status(500).json({
      success: false,
      error: 'Failed to create print files',
      details: error.message
    });
  }
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

let publicUrl = null;

async function start() {
  return new Promise((resolve, reject) => {
    const serverInstance = app.listen(PORT, async () => {
      console.log(`🚀 Local server running at http://localhost:${PORT}`);
      try {
        tunnel = await localtunnel({ port: PORT, subdomain: null }); // or specify subdomain
        console.log(`🌐 Public URL: ${tunnel.url}`);
        publicUrl = tunnel.url;
        tunnel.on('close', () => {
          console.log('🛑 Tunnel closed');
        });
        resolve(tunnel.url);
      } catch (err) {
        reject(err);
      }
    });

    serverInstance.on('error', (err) => {
      reject(err);
    });
  });
}


async function stop() {
  if (tunnel) {
    await tunnel.close();
    console.log('🔌 Tunnel closed');
  }
}


// Export start and stop to use from Electron
module.exports = { start, stop };

