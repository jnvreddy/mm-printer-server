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

    // For DNP printers, we need to use a different approach
    // We'll use the Windows print command with proper paper size specification
    let printCommand;

    if (cutEnabled) {
      // For sizes with cutting (like 2x6 -> (6x4) x 2), we need to handle the cutting
      // Each print job will create multiple strips, so we adjust the number of copies
      const stripsPerJob = actualPaperSize.includes('x 2') ? 2 : 1;
      const actualCopies = Math.ceil(copies / stripsPerJob);

      printCommand = `powershell.exe -Command "& {Get-Content '${filePath}' -Raw | Out-Printer -Name '${printer}' -Copies ${actualCopies} -PaperSize '${actualPaperSize}'}"`;

      console.log(`Cut-enabled print: ${copies} requested copies, ${actualCopies} print jobs (${stripsPerJob} strips per job)`);
    } else {
      // For regular sizes without cutting
      printCommand = `powershell.exe -Command "& {Get-Content '${filePath}' -Raw | Out-Printer -Name '${printer}' -Copies ${copies} -PaperSize '${actualPaperSize}'}"`;
    }

    exec(printCommand, (error, stdout, stderr) => {
      if (error) {
        console.error(`Print error:`, error);
        reject(error);
        return;
      }

      if (stderr) {
        console.warn(`Print warning:`, stderr);
      }

      console.log(`Successfully sent print job to printer ${printer} with size ${actualPaperSize}`);
      resolve({
        success: true,
        copies: copies,
        paperSize: actualPaperSize,
        cutEnabled: cutEnabled,
        requestedSize: paperSize
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

