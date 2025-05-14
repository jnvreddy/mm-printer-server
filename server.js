// server.js - Fixed routes and error handling
const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const cors = require('cors');
const morgan = require('morgan');
const { getPrinters, print } = require('pdf-to-printer');
const sharp = require('sharp');
const { v4: uuidv4 } = require('uuid');
const WebSocket = require('ws');
require('dotenv').config();

// Global error handler for uncaught exceptions to prevent server crashes
process.on('uncaughtException', (error) => {
  console.error('UNCAUGHT EXCEPTION - keeping process alive:', error);
  // Optionally log to external logging service here
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('UNHANDLED REJECTION - keeping process alive. Reason:', reason);
  // Optionally log to external logging service here
});

// Initialize Express app
const app = express();
const PORT = process.env.PORT || 3000;

// Initialize WebSocket server
const wss = new WebSocket.Server({ noServer: true });

// Store connected clients
const clients = new Set();

// Safely send WebSocket message with error handling
const safeSendMessage = (client, message) => {
  try {
    if (client.readyState === WebSocket.OPEN) {
      client.send(typeof message === 'string' ? message : JSON.stringify(message));
    }
  } catch (error) {
    console.error('Error sending WebSocket message:', error);
    // Don't throw the error - just log it to prevent crashes
  }
};

// WebSocket connection handler
wss.on('connection', (ws) => {
  try {
    clients.add(ws);
    console.log(`WebSocket client connected (total: ${clients.size})`);

    // Send initial printer status
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

// DNP DS-RX1HS specific configurations
const DNP_PRINTER_CONFIG = {
  name: 'DNP DS-RX1HS',
  paperSizes: [
    { name: '2x6', width: 2, height: 6 },
    { name: '4x6', width: 4, height: 6 },
    { name: '6x8', width: 6, height: 8 },
    { name: '6x9', width: 6, height: 9 }
  ],
  defaultSize: '4x6'
};

// Safe wrapper for getPrinters to prevent crashes
const safeGetPrinters = async () => {
  try {
    return await getPrinters();
  } catch (error) {
    console.error('Error getting printers:', error);
    return []; // Return empty array instead of crashing
  }
};

// Function to broadcast printer status to all connected clients
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
      // Printer not found, send manual config as fallback
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

    // Send error status to clients
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

// Configure middleware
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json({ 
  limit: '10mb'  // Limit JSON body size
}));
app.use(express.urlencoded({ 
  extended: true,
  limit: '10mb' // Limit URL-encoded body size
}));

// Add request ID to each request for better debugging
app.use((req, res, next) => {
  req.id = uuidv4();
  next();
});

// Custom logger
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
    // For development, make API key optional with a warning
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

// Apply authentication to all printer routes
app.use('/api/printer', authenticateRequest);

// Safe file cleanup function
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

// Configure multer for file uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    try {
      const uploadDir = path.join(__dirname, 'uploads');
      if (!fs.existsSync(uploadDir)) {
        fs.mkdirSync(uploadDir, { recursive: true });
      }
      cb(null, uploadDir);
    } catch (error) {
      console.error('Error creating upload directory:', error);
      cb(new Error('Could not create upload directory'));
    }
  },
  filename: (req, file, cb) => {
    try {
      // Sanitize filename
      const originalName = path.basename(file.originalname).replace(/[^a-zA-Z0-9_.]/g, '_');
      const uniqueFilename = `${Date.now()}-${uuidv4()}${path.extname(originalName)}`;
      cb(null, uniqueFilename);
    } catch (error) {
      console.error('Error generating filename:', error);
      cb(new Error('Could not generate unique filename'));
    }
  }
});

// Configure upload
const upload = multer({
  storage,
  limits: { 
    fileSize: 10 * 1024 * 1024, // 10MB limit
    files: 1 // Only 1 file allowed
  },
  fileFilter: (req, file, cb) => {
    try {
      // Only allow image files
      const filetypes = /jpeg|jpg|png/;
      const extname = filetypes.test(path.extname(file.originalname).toLowerCase());
      const mimetype = filetypes.test(file.mimetype);

      if (extname && mimetype) {
        return cb(null, true);
      } else {
        cb(new Error('Only JPEG and PNG images are allowed'));
      }
    } catch (error) {
      console.error('Error in file filter:', error);
      cb(new Error('Error processing file upload'));
    }
  }
}).single('file');

// Wrapper function to handle multer errors
const handleUpload = (req, res, next) => {
  upload(req, res, (err) => {
    if (err instanceof multer.MulterError) {
      // Multer error
      console.error(`Upload error in request ${req.id}:`, err);
      return res.status(400).json({
        success: false,
        error: 'Upload error',
        message: err.message || 'Error uploading file'
      });
    } else if (err) {
      // Other error
      console.error(`Upload error in request ${req.id}:`, err);
      return res.status(400).json({
        success: false,
        error: 'File error',
        message: err.message || 'Error processing file'
      });
    }
    // Success - proceed to next middleware
    next();
  });
};

// Function to check if a printer exists
const printerExists = async (printerName) => {
  try {
    const printers = await safeGetPrinters();
    return printers.some(p => p.name === printerName);
  } catch (error) {
    console.error('Error checking printer existence:', error);
    return false;
  }
};

// Function to get printer by id - In this implementation, id is just the printer name
const getPrinterById = async (printerId) => {
  try {
    const printers = await safeGetPrinters();
    return printers.find(p => p.name === printerId) || null;
  } catch (error) {
    console.error('Error getting printer by id:', error);
    return null;
  }
};

// Define API Routes
// 1. GET /api/printer - Return all printers
app.get('/api/printer', async (req, res) => {
  try {
    console.log(`[${req.id}] Fetching all printers`);
    const printers = await safeGetPrinters();
    
    // Format for consistent response
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

    // Return enhanced printer details with paper sizes
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

// 3. POST /api/printer/:printerid - Print a file to a specific printer
app.post('/api/printer/:printerid', handleUpload, async (req, res) => {
  // Track paths to clean up in case of errors
  const filesToCleanup = [];
  
  try {
    const printerId = req.params.printerid;
    console.log(`[${req.id}] Processing print request for printer: ${printerId}`);
    
    if (!printerId) {
      return res.status(400).json({
        success: false,
        error: 'Invalid request',
        message: 'Printer ID is required'
      });
    }
    
    if (!req.file) {
      return res.status(400).json({ 
        success: false, 
        error: 'No file uploaded',
        message: 'You must upload a file to print'
      });
    }

    // Add the uploaded file to cleanup list
    filesToCleanup.push(req.file.path);
    
    // Check if the printer exists
    console.log(`[${req.id}] Checking if printer exists: ${printerId}`);
    const printerAvailable = await printerExists(printerId);
    if (!printerAvailable) {
      console.log(`[${req.id}] Printer not found: ${printerId}`);
      // Clean up file
      safeCleanupFiles(filesToCleanup);

      return res.status(404).json({
        success: false,
        error: 'Printer not found',
        message: `The printer "${printerId}" is not connected or not available.`
      });
    }

    // Default to 1 copy and default paper size if not specified
    const copies = req.body.copies ? parseInt(req.body.copies, 10) || 1 : 1;
    const paperSize = req.body.paperSize || DNP_PRINTER_CONFIG.defaultSize;
    const filePath = req.file.path;

    console.log(`[${req.id}] Print parameters - paperSize: ${paperSize}, copies: ${copies}`);

    // Validate paper size
    const selectedSize = DNP_PRINTER_CONFIG.paperSizes.find(size => size.name === paperSize);
    if (!selectedSize) {
      console.log(`[${req.id}] Invalid paper size: ${paperSize}`);
      // Clean up file
      safeCleanupFiles(filesToCleanup);

      return res.status(400).json({ 
        success: false, 
        error: 'Invalid paper size',
        message: `Paper size "${paperSize}" is not supported.`
      });
    }

    // Resize image to match paper size
    console.log(`[${req.id}] Resizing image for paper size: ${paperSize}`);
    const resizedImagePath = path.join(path.dirname(filePath), `resized-${path.basename(filePath)}`);
    filesToCleanup.push(resizedImagePath);
    
    try {
      await sharp(filePath)
        .resize({
          width: selectedSize.width * 300, // Convert inches to pixels (300 DPI)
          height: selectedSize.height * 300,
          fit: 'contain',
          background: { r: 255, g: 255, b: 255, alpha: 1 }
        })
        .toFile(resizedImagePath);
    } catch (sharpError) {
      console.error(`[${req.id}] Error resizing image:`, sharpError);
      safeCleanupFiles(filesToCleanup);
      
      return res.status(400).json({
        success: false,
        error: 'Image processing error',
        message: 'Failed to resize the image. The file may be corrupted or unsupported.'
      });
    }

    // Convert to PDF
    console.log(`[${req.id}] Converting image to PDF`);
    const pdfPath = resizedImagePath + '.pdf';
    filesToCleanup.push(pdfPath);
    
    try {
      await sharp(resizedImagePath)
        .toFormat('pdf')
        .toFile(pdfPath);
    } catch (pdfError) {
      console.error(`[${req.id}] Error converting to PDF:`, pdfError);
      safeCleanupFiles(filesToCleanup);
      
      return res.status(500).json({
        success: false,
        error: 'PDF conversion error',
        message: 'Failed to convert the image to PDF format.'
      });
    }

    // Print the PDF
    console.log(`[${req.id}] Sending print job to printer: ${printerId}`);
    try {
      await print(pdfPath, {
        printer: printerId,
        copies: copies
      });
    } catch (printError) {
      console.error(`[${req.id}] Error printing:`, printError);
      safeCleanupFiles(filesToCleanup);

      return res.status(500).json({
        success: false,
        error: 'Print failed',
        message: printError.message || 'Failed to send document to printer.'
      });
    }

    // Clean up temporary files
    console.log(`[${req.id}] Cleaning up temporary files`);
    safeCleanupFiles(filesToCleanup);

    // Broadcast updated printer status after print job
    broadcastPrinterStatus(printerId);

    console.log(`[${req.id}] Print job submitted successfully`);
    return res.json({
      success: true,
      message: 'Print job submitted successfully',
      jobId: Date.now().toString(),
      fileName: req.file.filename,
      printer: printerId,
      paperSize: selectedSize.name,
      copies: copies,
      timestamp: new Date().toISOString()
    });

  } catch (err) {
    console.error(`[${req.id}] Error processing print request:`, err);
    
    // Clean up all temp files in case of error
    if (filesToCleanup.length > 0) {
      console.log(`[${req.id}] Cleaning up ${filesToCleanup.length} files after error`);
      safeCleanupFiles(filesToCleanup);
    }
    
    return res.status(500).json({ 
      success: false, 
      error: 'Internal server error', 
      message: err.message,
      requestId: req.id
    });
  }
});

// Root route serves the admin panel
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Health check endpoint
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

// Global error handler for Express
app.use((err, req, res, next) => {
  console.error(`Error in request ${req.id}:`, err);
  
  // If headers already sent, delegate to Express default error handler
  if (res.headersSent) {
    return next(err);
  }

  // Send error response
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

// Create a 404.html file if it doesn't exist
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

// Start the server
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

// Server error handling
server.on('error', (error) => {
  console.error('Server error:', error);
  // Attempt to restart server if port is in use
  if (error.code === 'EADDRINUSE') {
    console.log(`Port ${PORT} is in use. Trying again in 5 seconds...`);
    setTimeout(() => {
      server.close();
      server.listen(PORT, '0.0.0.0');
    }, 5000);
  }
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received. Shutting down gracefully...');
  server.close(() => {
    console.log('Server closed.');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log('SIGINT received. Shutting down gracefully...');
  server.close(() => {
    console.log('Server closed.');
    process.exit(0);
  });
});

// Upgrade HTTP server to WebSocket
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