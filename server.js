const express = require('express');
const path = require('path');
const fs = require('fs');
const cors = require('cors');
const morgan = require('morgan');
const printer = require('printer-lp');
const sharp = require('sharp');
const { v4: uuidv4 } = require('uuid');
const WebSocket = require('ws');
const { getPrinters } = require('pdf-to-printer');
require('dotenv').config();

process.on('uncaughtException', (error) => {
  console.error('UNCAUGHT EXCEPTION - keeping process alive:', error);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('UNHANDLED REJECTION - keeping process alive. Reason:', reason);
});

const app = express();
const PORT = process.env.PORT || 3000;

const wss = new WebSocket.Server({ noServer: true });

const clients = new Set();

const safeSendMessage = (client, message) => {
  try {
    if (client.readyState === WebSocket.OPEN) {
      client.send(typeof message === 'string' ? message : JSON.stringify(message));
    }
  } catch (error) {
    console.error('Error sending WebSocket message:', error);
  }
};

wss.on('connection', (ws) => {
  try {
    clients.add(ws);
    console.log(`WebSocket client connected (total: ${clients.size})`);

    broadcastPrinterStatus(DNP_PRINTER_CONFIG.name);

    ws.on('close', () => {
      try {
        clients.delete(ws);
        console.log(`WebSocket client disconnected (remaining: ${clients.size})`);
      } catch (error) {
        console.error('Error handling WebSocket close event:', error);
      }
    });

    ws.on('error', (error) => {
      console.error('WebSocket client error:', error);
      try {
        clients.delete(ws);
      } catch (innerError) {
        console.error('Error removing client after error:', innerError);
      }
    });
  } catch (error) {
    console.error('Error handling WebSocket connection:', error);
  }
});

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

const broadcastPrinterStatus = async (printerName) => {
  try {
    const printers = await safeGetPrinters();
    const printer = printers.find(p => p.name === printerName);

    if (printer) {
      const status = {
        type: 'printer_status',
        printer: {
          name: printer.name,
          status: printer.status || 'unknown',
          paperSizes: DNP_PRINTER_CONFIG.paperSizes,
          isConnected: true
        },
        timestamp: new Date().toISOString()
      };

      clients.forEach(client => {
        safeSendMessage(client, status);
      });
    } else {
      const offlineStatus = {
        type: 'printer_status',
        printer: {
          name: printerName,
          status: 'offline',
          paperSizes: DNP_PRINTER_CONFIG.paperSizes,
          isConnected: false
        },
        timestamp: new Date().toISOString()
      };

      clients.forEach(client => {
        safeSendMessage(client, offlineStatus);
      });
    }
  } catch (error) {
    console.error('Error broadcasting printer status:', error);

    const errorStatus = {
      type: 'printer_status',
      error: error.message,
      printer: {
        name: printerName,
        status: 'error',
        paperSizes: DNP_PRINTER_CONFIG.paperSizes,
        isConnected: false
      },
      timestamp: new Date().toISOString()
    };

    clients.forEach(client => {
      safeSendMessage(client, errorStatus);
    });
  }
};

app.use(cors({
  origin: '*',
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Copies', 'X-Size']
}));

app.use(express.json({ 
  limit: '10mb'
}));

app.use(express.urlencoded({ 
  extended: true,
  limit: '10mb' 
}));

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
    if (!process.env.API_KEY) {
      console.warn('WARNING: No API_KEY set in environment. Authentication is disabled.');
      return next();
    }

    if (!apiKey || apiKey !== process.env.API_KEY) {
      return res.status(401).json({ 
        success: false,
        error: 'Unauthorized',
        message: 'Invalid or missing API key' 
      });
    }
    next();
  } catch (error) {
    console.error('Authentication error:', error);
    return res.status(500).json({ 
      success: false, 
      error: 'Authentication error',
      message: 'An error occurred during authentication'
    });
  }
};

app.use('/api/printer', authenticateRequest);

const safeCleanupFiles = (files) => {
  if (!Array.isArray(files)) {
    files = [files];
  }
  
  files.forEach(file => {
    if (file && typeof file === 'string') {
      try {
        if (fs.existsSync(file)) {
          fs.unlinkSync(file);
        }
      } catch (e) {
        console.error(`Error removing file ${file}:`, e);
      }
    }
  });
};

// 1. GET /api/printer - Return all printers
app.get('/api/printer', async (req, res) => {
  try {
    console.log(`[${req.id}] Fetching all printers`);
    const printers = await safeGetPrinters();
    
    const formattedPrinters = printers.map(printer => ({
      id: printer.name,
      name: printer.name,
      isConnected: true
    }));

    console.log(`[${req.id}] Found ${formattedPrinters.length} printers`);
    return res.json({
      success: true,
      printers: formattedPrinters
    });
  } catch (err) {
    console.error(`[${req.id}] Error fetching printers:`, err);
    return res.status(500).json({ 
      success: false, 
      error: 'Internal server error', 
      message: err.message,
      requestId: req.id
    });
  }
});

app.use('/api/printer', express.raw({ type: 'image/jpeg', limit: '10mb' }));

app.post('/api/printer', (req, res) => {
  const printerId = req.headers['x-printer-id'] || "OneNote (Desktop)";
  const copies = parseInt(req.headers['x-copies'] || '1', 10);
  const size = req.headers['x-size'] || '2x6';

  if (!req.body || !req.body.length) {
    return res.status(400).json({ success: false, error: 'No image data received' });
  }

  const hotFolderBase = path.join(__dirname, 'hotfolder');
  const sizeFolder = path.join(hotFolderBase, size);

  fs.mkdirSync(sizeFolder, { recursive: true });

  const baseFilename = `print_${printerId}_${Date.now()}`;
  const imageFilename = `${baseFilename}.jpg`;
  const imageFilepath = path.join(sizeFolder, imageFilename);

  fs.writeFile(imageFilepath, req.body, err => {
    if (err) {
      return res.status(500).json({ success: false, error: 'Failed to save image file' });
    }

    const jobFilename = `${baseFilename}.job`;
    const jobFilepath = path.join(sizeFolder, jobFilename);

    const jobFileContent = `copies=${copies}\nprinter=${printerId}\nsize=${size}`;

    fs.writeFile(jobFilepath, jobFileContent, jobErr => {
      if (jobErr) {
        return res.status(500).json({ success: false, error: 'Failed to save job file' });
      }

      res.json({
        success: true,
        message: 'Image and job files saved successfully',
        printer: printerId,
        copies,
        size,
        imagePath: `/hotfolder/${size}/${imageFilename}`,
        jobFilePath: `/hotfolder/${size}/${jobFilename}`,
        timestamp: new Date().toISOString()
      });
    });
  });
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

// 404 handler for API routes
app.use('/api', (req, res) => {
  res.status(404).json({
    success: false,
    error: 'Not Found',
    message: `The requested endpoint '${req.originalUrl}' does not exist.`
  });
});

app.use((err, req, res, next) => {
  console.error(`Error in request ${req.id}:`, err);
  
  if (res.headersSent) {
    return next(err);
  }

  res.status(500).json({
    success: false,
    error: 'Server error',
    message: process.env.NODE_ENV === 'production' ? 'An unexpected error occurred' : err.message,
    requestId: req.id
  });
});

// 404 handler for all other routes
app.use((req, res) => {
  if (req.accepts('html')) {
    res.status(404).sendFile(path.join(__dirname, 'public', '404.html'));
  } else {
    res.status(404).json({
      success: false,
      error: 'Not Found',
      message: 'The requested resource was not found.'
    });
  }
});

const notFoundPath = path.join(__dirname, 'public', '404.html');
if (!fs.existsSync(notFoundPath)) {
  const notFoundDir = path.join(__dirname, 'public');
  if (!fs.existsSync(notFoundDir)) {
    fs.mkdirSync(notFoundDir, { recursive: true });
  }
  
  fs.writeFileSync(notFoundPath, `
    <!DOCTYPE html>
    <html>
    <head>
      <title>404 - Page Not Found</title>
      <style>
        body { font-family: Arial, sans-serif; text-align: center; padding: 50px; }
        h1 { color: #333; }
        p { color: #666; }
        a { color: #3498db; text-decoration: none; }
        a:hover { text-decoration: underline; }
      </style>
    </head>
    <body>
      <h1>404 - Page Not Found</h1>
      <p>The page you are looking for does not exist.</p>
      <p><a href="/">Return to Home</a></p>
    </body>
    </html>
  `);
}

const server = app.listen(PORT, '0.0.0.0', async () => {
  console.log(`DNP Printer Server running on port ${PORT}`);

  console.log('Checking for available printers...');
  try {
    const printers = await safeGetPrinters();
    if (printers.length > 0) {
      console.log('Available printers:');
      printers.forEach(printer => {
        console.log(`- ${printer.name}`);
      });

      // Check if our target printer is in the list
      const targetPrinter = printers.find(p => p.name === DNP_PRINTER_CONFIG.name);
      if (targetPrinter) {
        console.log(`\n✅ Target printer "${DNP_PRINTER_CONFIG.name}" is available`);
      } else {
        console.log(`\n⚠️ WARNING: Target printer "${DNP_PRINTER_CONFIG.name}" not found. Available printers are:`);
        printers.forEach(printer => {
          console.log(`  - ${printer.name}`);
        });
        console.log('\nYou may need to update the DNP_PRINTER_CONFIG.name in the code.');
      }
    } else {
      console.log('⚠️ No printers detected. Please make sure your printer is connected and powered on.');
    }

    // Start periodic status updates
    setInterval(() => {
      try {
        broadcastPrinterStatus(DNP_PRINTER_CONFIG.name);
      } catch (error) {
        console.error('Error in periodic status update:', error);
      }
    }, 5000); // Update every 5 seconds
  } catch (err) {
    console.error('Error detecting printers:', err);
    console.log('⚠️ The server will continue running, but printer functionality may not work.');
  }
});

server.on('error', (error) => {
  console.error('Server error:', error);
  if (error.code === 'EADDRINUSE') {
    console.log(`Port ${PORT} is in use. Trying again in 5 seconds...`);
    setTimeout(() => {
      server.close();
      server.listen(PORT, '0.0.0.0');
    });
  }
});

server.on('upgrade', (request, socket, head) => {
  try {
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request);
    });
  } catch (error) {
    console.error('WebSocket upgrade error:', error);
    socket.destroy();
  }
});