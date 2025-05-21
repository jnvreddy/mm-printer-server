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
  name: 'DNP DS-RX1HS',
  paperSizes: [
    { name: '2x6', width: 2, height: 6 },
    { name: '4x6', width: 4, height: 6 },
    { name: '6x8', width: 6, height: 8 },
    { name: '6x9', width: 6, height: 9 }
  ],
  defaultSize: '2x6'
};

// done fetching printers
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

const printerExists = async (printerName) => {
  try {
    const printers = await safeGetPrinters();
    return printers.some(p => p.name === printerName);
  } catch (error) {
    console.error('Error checking printer existence:', error);
    return false;
  }
};
//Done printer details
const getPrinterById = async (printerId) => {
  try {
    const printers = await safeGetPrinters();
    return printers.find(p => p.name === printerId) || null;
  } catch (error) {
    console.error('Error getting printer by id:', error);
    return null;
  }
};

// 1. GET /api/printer - Return all printers
app.get('/api/printer', async (req, res) => {
  try {
    console.log(`[${req.id}] Fetching all printers`);
    const printers = await safeGetPrinters();
    
    const formattedPrinters = printers.map(printer => ({
      id: printer.name,
      name: printer.name,
      status: printer.status || 'unknown',
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

// 2. GET /api/printer/:printerid - Return specific printer details
app.get('/api/printer/:printerid', async (req, res) => {
  try {
    const printerId = req.params.printerid;
    console.log(`[${req.id}] Fetching details for printer: ${printerId}`);
    
    if (!printerId) {
      return res.status(400).json({
        success: false,
        error: 'Invalid request',
        message: 'Printer ID is required'
      });
    }
    
    const printer = await getPrinterById(printerId);

    if (!printer) {
      console.log(`[${req.id}] Printer not found: ${printerId}`);
      return res.status(404).json({
        success: false,
        error: 'Printer not found',
        message: `The printer "${printerId}" was not found.`
      });
    }

    console.log(`[${req.id}] Returning details for printer: ${printerId}`);
    return res.json({
      success: true,
      printer: {
        id: printer.name,
        name: printer.name,
        status: printer.status || 'ready',
        isConnected: true,
        paperSizes: DNP_PRINTER_CONFIG.paperSizes,
        defaultSize: DNP_PRINTER_CONFIG.defaultSize
      }
    });
  } catch (err) {
    console.error(`[${req.id}] Error fetching printer details:`, err);
    return res.status(500).json({ 
      success: false, 
      error: 'Internal server error', 
      message: err.message,
      requestId: req.id
    });
  }
});

app.use('/api/printer', express.raw({ type: 'image/jpeg', limit: '10mb' }));

app.post('/api/printer', authenticateRequest, (req, res) => {
  const printerId = "OneNote (Desktop)";
  const copies = parseInt(req.headers['x-copies'] || '1', 10);
  const size = req.headers['x-size'] || 'A4';

  if (!req.body || !req.body.length) {
    return res.status(400).json({ success: false, error: 'No image data received' });
  }

  const filename = `print_${printerId}_${Date.now()}.jpg`;
  const filepath = path.join(__dirname, 'downloads', filename);
  fs.mkdirSync(path.dirname(filepath), { recursive: true });

  fs.writeFile(filepath, req.body, err => {
    if (err) {
      return res.status(500).json({ success: false, error: 'Failed to save file' });
    }

    res.json({
      success: true,
      message: 'Image saved successfully',
      printer: printerId,
      copies,
      size,
      downloadUrl: `/downloads/${filename}`,
      timestamp: new Date().toISOString()
    });
  });
});


//  3. POST /api/printer/:printerid - Print an image received through API
// app.post('/api/printer/:printerid', async (req, res) => {
//   const filesToCleanup = [];
//   try {
//     const printerId = req.params.printerid;
//     console.log(`[${req.id}] Processing print request for printer: ${printerId}`);
    
//     if (!printerId) {
//       return res.status(400).json({
//         success: false,
//         error: 'Invalid request',
//         message: 'Printer ID is required'
//       });
//     }
    
//     // Check for image data in the request body
//     if (!req.body.imageData) {
//       return res.status(400).json({ 
//         success: false, 
//         error: 'No image data provided',
//         message: 'You must provide image data in the request body'
//       });
//     }

//     console.log(`[${req.id}] Checking if printer exists: ${printerId}`);
//     const printerAvailable = await printerExists(printerId);
//     if (!printerAvailable) {
//       console.log(`[${req.id}] Printer not found: ${printerId}`);
//       return res.status(404).json({
//         success: false,
//         error: 'Printer not found',
//         message: `The printer "${printerId}" is not connected or not available.`
//       });
//     }

//     // Extract image data and parameters
//     const imageData = req.body.imageData;
//     const copies = req.body.copies ? parseInt(req.body.copies, 10) || 1 : 1;
//     const paperSize = req.body.paperSize || DNP_PRINTER_CONFIG.defaultSize;

//     console.log(`[${req.id}] Print parameters - paperSize: ${paperSize}, copies: ${copies}`);

//     const selectedSize = DNP_PRINTER_CONFIG.paperSizes.find(size => size.name === paperSize);
//     if (!selectedSize) {
//       console.log(`[${req.id}] Invalid paper size: ${paperSize}`);
//       return res.status(400).json({ 
//         success: false, 
//         error: 'Invalid paper size',
//         message: `Paper size "${paperSize}" is not supported.`
//       });
//     }

//     // Create a temporary directory for the image file if it doesn't exist
//     const uploadDir = path.join(__dirname, 'uploads');
//     if (!fs.existsSync(uploadDir)) {
//       fs.mkdirSync(uploadDir, { recursive: true });
//     }

//     // Convert base64 image data to a file
//     const imageBuffer = Buffer.from(imageData.replace(/^data:image\/\w+;base64,/, ''), 'base64');
//     const tempImagePath = path.join(uploadDir, `${Date.now()}-${uuidv4()}.png`);
//     filesToCleanup.push(tempImagePath);
    
//     fs.writeFileSync(tempImagePath, imageBuffer);

//     console.log(`[${req.id}] Resizing image for paper size: ${paperSize}`);
//     const resizedImagePath = path.join(path.dirname(tempImagePath), `resized-${path.basename(tempImagePath)}`);
//     filesToCleanup.push(resizedImagePath);
    
//     try {
//       await sharp(tempImagePath)
//         .resize({
//           width: selectedSize.width * 300, 
//           height: selectedSize.height * 300,
//           fit: 'contain',
//           background: { r: 255, g: 255, b: 255, alpha: 1 }
//         })
//         .toFile(resizedImagePath);
//     } catch (sharpError) {
//       console.error(`[${req.id}] Error resizing image:`, sharpError);
//       safeCleanupFiles(filesToCleanup);
      
//       return res.status(400).json({
//         success: false,
//         error: 'Image processing error',
//         message: 'Failed to resize the image. The file may be corrupted or unsupported.'
//       });
//     }

//     const finalImagePath = resizedImagePath;

//     console.log(`[${req.id}] Sending print job to printer: ${printerId}`);
//     try {
//       await print(finalImagePath, {
//         printer: printerId,
//         copies: copies
//       });
//     } catch (printError) {
//       console.error(`[${req.id}] Error printing:`, printError);
//       safeCleanupFiles(filesToCleanup);

//       return res.status(500).json({
//         success: false,
//         error: 'Print failed',
//         message: printError.message || 'Failed to send document to printer.'
//       });
//     }

//     console.log(`[${req.id}] Cleaning up temporary files`);
//     safeCleanupFiles(filesToCleanup);

//     broadcastPrinterStatus(printerId);

//     console.log(`[${req.id}] Print job submitted successfully`);
//     return res.json({
//       success: true,
//       message: 'Print job submitted successfully',
//       jobId: Date.now().toString(),
//       printer: printerId,
//       paperSize: selectedSize.name,
//       copies: copies,
//       timestamp: new Date().toISOString()
//     });

//   } catch (err) {
//     console.error(`[${req.id}] Error processing print request:`, err);
    
//     if (filesToCleanup.length > 0) {
//       console.log(`[${req.id}] Cleaning up ${filesToCleanup.length} files after error`);
//       safeCleanupFiles(filesToCleanup);
//     }
    
//     return res.status(500).json({ 
//       success: false, 
//       error: 'Internal server error', 
//       message: err.message,
//       requestId: req.id
//     });
//   }
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
    }, 5000);
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