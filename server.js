const express = require('express');
const path = require('path');
const fs = require('fs');
const cors = require('cors');
const morgan = require('morgan');
const { v4: uuidv4 } = require('uuid');
const { exec, spawn } = require("child_process");
const sharp = require('sharp');
require('dotenv').config();

process.on('uncaughtException', (error) => {
  console.error('UNCAUGHT EXCEPTION - keeping process alive:', error);
});

process.on('unhandledRejection', (reason) => {
  console.error('UNHANDLED REJECTION - keeping process alive. Reason:', reason);
});

const app = express();
const PORT = process.env.PORT || 3000;

let successfulPrintCount = 0;

const DNP_PRINTER_CONFIG = {
  name: 'DNS XH1',
  paperSizes: [
    // Standard sizes
    { name: '5x3.5', width: 5, height: 3.5, actualSize: '(5x3.5)', cutEnabled: false },
    { name: '5x5', width: 5, height: 5, actualSize: '(5x5)', cutEnabled: false },
    { name: '5x7', width: 5, height: 7, actualSize: '(5x7)', cutEnabled: false },
    { name: '6x4', width: 6, height: 4, actualSize: '(6x4)', cutEnabled: false },
    { name: '6x6', width: 6, height: 6, actualSize: '(6x6)', cutEnabled: false },
    { name: '6x8', width: 6, height: 8, actualSize: '(6x8)', cutEnabled: false },

    // Special sizes with cutting
    { name: '2x6', width: 2, height: 6, actualSize: '(6x4) x 2', cutEnabled: true },
    { name: '3x4', width: 3, height: 4, actualSize: '(6x4) x 2', cutEnabled: true },

    // Passport sizes
    { name: '3.5x5', width: 3.5, height: 5, actualSize: 'PR (3.5x5)', cutEnabled: false },
    { name: '4x6', width: 4, height: 6, actualSize: 'PR (4x6)', cutEnabled: false },
    { name: '2x3', width: 2, height: 3, actualSize: 'PR (4x6) x 2', cutEnabled: true }
  ],
  defaultSize: '2x6'
};

// Function to get available Windows printers
const getPrinters = () => {
  return new Promise((resolve, reject) => {
    exec("Get-Printer | ConvertTo-Json", { shell: "powershell.exe" }, (err, stdout) => {
      if (err) {
        console.error("PowerShell error:", err);
        reject(err);
        return;
      }

      try {
        const printers = JSON.parse(stdout);
        const printerList = Array.isArray(printers) ? printers : [printers];
        resolve(printerList);
      } catch (parseErr) {
        console.error("JSON parse failed:", parseErr, stdout);
        reject(parseErr);
      }
    });
  });
};


// Function to print file to Windows printer spooler
const printFile = (filePath, options = {}) => {
  return new Promise((resolve, reject) => {
    const { printer, paperSize, copies = 1, cut = false } = options;

    if (!printer) {
      reject(new Error('Printer name is required'));
      return;
    }

    // Find the paper size configuration
    const sizeConfig = DNP_PRINTER_CONFIG.paperSizes.find(s => s.name === paperSize);
    if (!sizeConfig) {
      reject(new Error(`Unsupported paper size: ${paperSize}`));
      return;
    }

    const actualPaperSize = sizeConfig.actualSize;
    const cutEnabled = sizeConfig.cutEnabled;

    console.log(`Printing to ${printer}: ${copies} copies of ${paperSize} (DNP size: ${actualPaperSize}, cut: ${cutEnabled})`);

    // Method 1: Use mspaint to print - very reliable for images
    const printCommand = `mspaint /p "${filePath}"`;

    console.log(`Executing print command: ${printCommand}`);

    // Add timeout to prevent hanging
    const timeout = setTimeout(() => {
      console.log('Print command timed out, trying alternative method...');
      // Try alternative method immediately
      tryAlternativeMethod();
    }, 10000); // 10 second timeout

    const tryAlternativeMethod = () => {
      clearTimeout(timeout);
      // Method 2: Use PowerShell with Start-Process and Print verb
      const altScript = `
        $process = Start-Process -FilePath '${filePath.replace(/\\/g, '\\\\')}' -Verb Print -PassThru -WindowStyle Hidden
        $process.WaitForExit(5000)
        if ($process.ExitCode -eq 0) { Write-Output "Print job queued successfully" }
      `;

      const altCommand = `powershell.exe -Command "${altScript}"`;

      exec(altCommand, { timeout: 15000 }, (altError, altStdout, altStderr) => {
        if (altError) {
          console.error(`Alternative print error:`, altError);
          // Method 3: Use Windows ShellExecute via rundll32
          console.log('Trying final fallback method...');

          const fallbackCommand = `rundll32.exe shell32.dll,ShellExec_RunDLL "${filePath}"`;

          exec(fallbackCommand, { timeout: 10000 }, (fallbackError, fallbackStdout, fallbackStderr) => {
            if (fallbackError) {
              console.error(`Fallback print error:`, fallbackError);
              reject(new Error(`All print methods failed: ${fallbackError.message}`));
              return;
            }

            console.log('Fallback print method succeeded');
            resolve({
              success: true,
              copies: copies,
              paperSize: actualPaperSize,
              cutEnabled: cutEnabled,
              requestedSize: paperSize,
              queued: true,
              message: 'Print job queued via fallback method'
            });
          });
          return;
        }

        console.log('Alternative print method succeeded');
        console.log('Alternative output:', altStdout);
        resolve({
          success: true,
          copies: copies,
          paperSize: actualPaperSize,
          cutEnabled: cutEnabled,
          requestedSize: paperSize,
          queued: true,
          message: 'Print job queued via alternative method'
        });
      });
    };

    exec(printCommand, { timeout: 10000 }, (error, stdout, stderr) => {
      clearTimeout(timeout);
      if (error) {
        console.error(`Print error:`, error);
        // Try alternative method if mspaint fails
        tryAlternativeMethod();
        return;
      }

      if (stderr) {
        console.warn(`Print warning:`, stderr);
      }

      console.log(`Successfully sent print job to printer ${printer} with size ${actualPaperSize}`);
      console.log('Print output:', stdout);

      resolve({
        success: true,
        copies: copies,
        paperSize: actualPaperSize,
        cutEnabled: cutEnabled,
        requestedSize: paperSize,
        queued: true,
        message: 'Print job queued successfully'
      });
    });
  });
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

// Function to check print queue for a specific printer
const checkPrintQueue = (printerName) => {
  return new Promise((resolve, reject) => {
    const queueCommand = `powershell.exe -Command "Get-PrintJob -PrinterName '${printerName}' | ConvertTo-Json"`;

    exec(queueCommand, (error, stdout, stderr) => {
      if (error) {
        console.error(`Queue check error:`, error);
        resolve([]);
        return;
      }

      try {
        const jobs = JSON.parse(stdout);
        const jobList = Array.isArray(jobs) ? jobs : [jobs];
        console.log(`Print queue for ${printerName}:`, jobList);
        resolve(jobList);
      } catch (parseErr) {
        console.error("JSON parse failed for queue:", parseErr);
        resolve([]);
      }
    });
  });
};

app.use(cors({ origin: '*', methods: ['GET', 'POST'], allowedHeaders: ['Content-Type', 'Authorization', 'X-Copies', 'X-Size', 'bypass-tunnel-reminder'] }));
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
    // Filter only DNP printers for dashboard
    const dnpPrinters = printers.filter(p =>
      p.Name && /RX1|RX1HS|DNP/i.test(p.Name)
    );

    return res.json({
      success: true,
      stats: {
        successfulPrints: successfulPrintCount,
        printers: dnpPrinters.map(p => ({
          name: p.Name,
          isConnected: p.PrinterStatus === 'Normal',
          status: p.PrinterStatus || 'Unknown'
        }))
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


//app.use('/api/printer', authenticateRequest);

app.use('/api/printer', express.raw({ type: 'image/jpeg', limit: '10mb' }));

app.post('/api/printer', async (req, res) => {
  let tempFilePath = null;

  // Set a timeout for the entire request
  const requestTimeout = setTimeout(() => {
    if (!res.headersSent) {
      res.status(408).json({
        success: false,
        error: 'Request timeout',
        message: 'Print request took too long to process'
      });
    }
  }, 30000); // 30 second timeout

  try {
    // Validate request
    if (!req.body || !req.body.length) {
      clearTimeout(requestTimeout);
      return res.status(400).json({ success: false, error: 'No image data received' });
    }

    const copies = parseInt(req.headers['x-copies'] || '1', 10);
    const requestedSize = (req.headers['x-size'] || DNP_PRINTER_CONFIG.defaultSize).toLowerCase();

    // Validate copies
    if (copies < 1 || copies > 100) {
      clearTimeout(requestTimeout);
      return res.status(400).json({ success: false, error: 'Invalid number of copies. Must be between 1 and 100.' });
    }

    // Validate paper size
    const sizeConfig = DNP_PRINTER_CONFIG.paperSizes.find(s => s.name === requestedSize);
    if (!sizeConfig) {
      clearTimeout(requestTimeout);
      return res.status(400).json({
        success: false,
        error: `Unsupported paper size: ${requestedSize}`,
        supportedSizes: DNP_PRINTER_CONFIG.paperSizes.map(s => s.name)
      });
    }

    // Get available printers and validate DNP printer exists
    const availablePrinters = await getPrinters();
    const dnpPrinter = availablePrinters.find(p =>
      p.Name && (p.Name.includes('RX1') || p.Name.includes('RX1HS') || p.Name.includes('DNP'))
    );

    if (!dnpPrinter) {
      clearTimeout(requestTimeout);
      return res.status(404).json({
        success: false,
        error: 'DNP printer not found',
        availablePrinters: availablePrinters.map(p => p.Name)
      });
    }

    const dnpPrinterName = dnpPrinter.Name;
    console.log(`Using DNP printer: ${dnpPrinterName}`);

    // Create temporary file
    tempFilePath = path.join(__dirname, `temp_${Date.now()}.jpg`);
    fs.writeFileSync(tempFilePath, req.body);

    // Save image to Prints folder
    try {
      const printsDir = path.join(__dirname, 'Prints');

      // Ensure Prints directory exists
      if (!fs.existsSync(printsDir)) {
        fs.mkdirSync(printsDir, { recursive: true });
        console.log(`Created Prints directory: ${printsDir}`);
      }

      // Generate unique filename with timestamp
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const savedImagePath = path.join(printsDir, `print-${timestamp}.jpg`);

      // Save the original image to Prints folder
      fs.writeFileSync(savedImagePath, req.body);
      console.log(`Saved image to Prints folder: ${savedImagePath}`);
    } catch (saveError) {
      console.error('Failed to save image to Prints folder:', saveError);
      // Continue with printing even if saving fails
    }

    // Debug: Check the image file
    try {
      const stats = fs.statSync(tempFilePath);
      console.log(`Created temp image file: ${tempFilePath}, size: ${stats.size} bytes`);

      // Verify the image can be read by Sharp
      const imageInfo = await sharp(tempFilePath).metadata();
      console.log(`Image metadata: ${imageInfo.width}x${imageInfo.height}, format: ${imageInfo.format}, size: ${imageInfo.size} bytes`);
    } catch (imageError) {
      console.error('Error reading image file:', imageError);
    }

    // Get the actual paper size for Windows printer spooler
    const actualPaperSize = sizeConfig.actualSize;
    const cutEnabled = sizeConfig.cutEnabled;

    console.log(`Printing ${requestedSize} image as ${actualPaperSize} on Windows printer spooler`);

    let successCount = 0;

    // Send print jobs - just send the original image with the correct paper size
    for (let i = 0; i < copies; i++) {
      try {
        const printResult = await printFile(tempFilePath, {
          printer: dnpPrinterName,
          paperSize: requestedSize,
          cut: cutEnabled,
          copies: 1
        });
        successCount++;
        console.log(`Print job ${i + 1} result:`, printResult);
      } catch (printError) {
        console.error(`Print job ${i + 1} failed:`, printError);
        // Continue with remaining jobs even if one fails
      }
    }

    // Check print queue to verify jobs were queued
    try {
      const queueJobs = await checkPrintQueue(dnpPrinterName);
      console.log(`Print queue status: ${queueJobs.length} jobs in queue`);
    } catch (queueError) {
      console.error('Failed to check print queue:', queueError);
    }

    // Clean up temporary files
    if (tempFilePath && fs.existsSync(tempFilePath)) {
      fs.unlinkSync(tempFilePath);
      tempFilePath = null;
    }

    // Update success count
    successfulPrintCount += successCount;

    // Prepare response
    const response = {
      success: true,
      message: `${successCount} print jobs sent to printer ${dnpPrinterName}`,
      requestedCopies: copies,
      actualPrintJobs: successCount,
      requestedSize: requestedSize,
      windowsPaperSize: actualPaperSize,
      cutEnabled: cutEnabled,
      printer: dnpPrinterName
    };

    // Add warning if not all jobs succeeded
    if (successCount < copies) {
      response.warning = `${copies - successCount} print jobs failed`;
    }

    clearTimeout(requestTimeout);
    res.json(response);

  } catch (err) {
    console.error('Printing failed:', err);

    // Clean up temporary files on error
    if (tempFilePath && fs.existsSync(tempFilePath)) {
      try {
        fs.unlinkSync(tempFilePath);
      } catch (cleanupError) {
        console.error('Failed to cleanup temp file:', cleanupError);
      }
    }

    clearTimeout(requestTimeout);
    res.status(500).json({
      success: false,
      error: 'Printing failed',
      details: err.message
    });
  }
});

app.get("/api/printer", async (req, res) => {
  try {
    const printers = await getPrinters();

    // Filter only DNP printers (names containing RX1, RX1HS, or DNP)
    const dnpPrinters = printers.filter(p =>
      p.Name && /RX1|RX1HS|DNP/i.test(p.Name)
    );

    if (dnpPrinters.length === 0) {
      return res.json({
        success: true,
        printers: [],
        message: "No DNP printers found",
        allPrinters: printers.map(p => ({ name: p.Name, status: p.PrinterStatus }))
      });
    }

    res.json({
      success: true,
      printers: dnpPrinters.map(p => ({
        name: p.Name,
        status: p.PrinterStatus,
        driverName: p.DriverName,
        isConnected: p.PrinterStatus === 'Normal'
      }))
    });
  } catch (err) {
    console.error("Failed to fetch printers:", err);
    res.status(500).json({ success: false, error: "Failed to fetch printers", details: err.message });
  }
});

// Get available paper sizes
app.get("/api/printer/sizes", (req, res) => {
  try {
    const sizes = DNP_PRINTER_CONFIG.paperSizes.map(size => ({
      name: size.name,
      width: size.width,
      height: size.height,
      dnpSize: size.actualSize,
      cutEnabled: size.cutEnabled,
      description: size.cutEnabled ?
        `${size.name} prints on ${size.actualSize} with cutting enabled` :
        `${size.name} prints on ${size.actualSize}`
    }));

    res.json({
      success: true,
      sizes: sizes,
      defaultSize: DNP_PRINTER_CONFIG.defaultSize
    });
  } catch (err) {
    console.error("Failed to get paper sizes:", err);
    res.status(500).json({ success: false, error: "Failed to get paper sizes", details: err.message });
  }
});

// Check print queue for a specific printer
app.get("/api/printer/queue/:printerName", async (req, res) => {
  try {
    const { printerName } = req.params;
    const queueJobs = await checkPrintQueue(printerName);

    res.json({
      success: true,
      printer: printerName,
      queueCount: queueJobs.length,
      jobs: queueJobs.map(job => ({
        id: job.Id,
        name: job.Name,
        status: job.JobStatus,
        pages: job.PagesPrinted,
        submittedTime: job.SubmittedTime
      }))
    });
  } catch (err) {
    console.error("Failed to check print queue:", err);
    res.status(500).json({ success: false, error: "Failed to check print queue", details: err.message });
  }
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

