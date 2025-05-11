// server.js - Main server file for DNP DS-RX1HS PrintNode Server
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

// Initialize Express app
const app = express();
const PORT = process.env.PORT || 3000;

// Initialize WebSocket server
const wss = new WebSocket.Server({ noServer: true });

// Store connected clients
const clients = new Set();

// WebSocket connection handler
wss.on('connection', (ws) => {
  clients.add(ws);

  ws.on('close', () => {
    clients.delete(ws);
  });
});

// Function to broadcast printer status to all connected clients
const broadcastPrinterStatus = async (printerName) => {
  try {
    const printers = await getPrinters();
    const printer = printers.find(p => p.name === printerName);

    if (printer) {
      const status = {
        type: 'printer_status',
        printer: {
          name: printer.name,
          status: printer.status,
          paperSizes: DNP_PRINTER_CONFIG.paperSizes,
          isConnected: true
        },
        timestamp: new Date().toISOString()
      };

      clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
          client.send(JSON.stringify(status));
        }
      });
    }
  } catch (error) {
    console.error('Error broadcasting printer status:', error);
  }
};

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

// Configure middleware
app.use(cors({
  origin: process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(',') : '*',
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(morgan('dev')); // Logging
app.use(express.static(path.join(__dirname, 'public')));

// Authentication middleware
const authenticateRequest = (req, res, next) => {
  const apiKey = req.headers.authorization;
  if (!apiKey || apiKey !== process.env.API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
};

// Apply authentication to all routes
app.use('/api/printer', authenticateRequest);

// Configure multer for file uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadDir = path.join(__dirname, 'uploads');
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const uniqueFilename = `${Date.now()}-${uuidv4()}${path.extname(file.originalname)}`;
    cb(null, uniqueFilename);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB limit
  fileFilter: (req, file, cb) => {
    // Only allow image files
    const filetypes = /jpeg|jpg|png/;
    const extname = filetypes.test(path.extname(file.originalname).toLowerCase());
    const mimetype = filetypes.test(file.mimetype);

    if (extname && mimetype) {
      return cb(null, true);
    } else {
      cb(new Error('Only JPEG and PNG images are allowed!'));
    }
  }
});

// Single endpoint for all printer operations
app.all('/api/printer', upload.single('file'), async (req, res) => {
  try {
    // GET request - Return printer status and information
    if (req.method === 'GET') {
      const printers = await getPrinters();
      const printer = printers.find(p => p.name === DNP_PRINTER_CONFIG.name);

      if (!printer) {
        return res.json({
          status: 'disconnected',
          printer: {
            name: DNP_PRINTER_CONFIG.name,
            paperSizes: DNP_PRINTER_CONFIG.paperSizes,
            isConnected: false
          }
        });
      }

      return res.json({
        status: 'connected',
        printer: {
          name: printer.name,
          status: printer.status,
          paperSizes: DNP_PRINTER_CONFIG.paperSizes,
          isConnected: true
        }
      });
    }

    // POST request - Handle print job
    if (req.method === 'POST') {
      if (!req.file) {
        return res.status(400).json({ error: 'No file uploaded' });
      }

      const { copies = 1, paperSize = DNP_PRINTER_CONFIG.defaultSize } = req.body;
      const filePath = req.file.path;

      // Validate paper size
      const selectedSize = DNP_PRINTER_CONFIG.paperSizes.find(size => size.name === paperSize);
      if (!selectedSize) {
        return res.status(400).json({ error: 'Invalid paper size' });
      }

      // Resize image to match paper size
      const resizedImagePath = path.join(path.dirname(filePath), `resized-${path.basename(filePath)}`);
      await sharp(filePath)
        .resize({
          width: selectedSize.width * 300, // Convert inches to pixels (300 DPI)
          height: selectedSize.height * 300,
          fit: 'contain',
          background: { r: 255, g: 255, b: 255, alpha: 1 }
        })
        .toFile(resizedImagePath);

      // Convert to PDF
      const pdfPath = resizedImagePath + '.pdf';
      await sharp(resizedImagePath)
        .toFormat('pdf')
        .toFile(pdfPath);

      // Print the PDF
      await print(pdfPath, {
        printer: DNP_PRINTER_CONFIG.name,
        copies: parseInt(copies)
      });

      // Clean up temporary files
      fs.unlinkSync(resizedImagePath);
      fs.unlinkSync(pdfPath);
      fs.unlinkSync(filePath);

      return res.json({
        success: true,
        message: 'Print job submitted successfully',
        fileName: req.file.filename,
        printer: DNP_PRINTER_CONFIG.name,
        paperSize: selectedSize.name
      });
    }

    // Method not allowed
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('Error processing request:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// Root route serves the admin panel
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Start the server
const server = app.listen(PORT, '0.0.0.0', async () => {
  console.log(`DNP Printer Server running on port ${PORT}`);
  try {
    const printers = await getPrinters();
    console.log('Available printers:');
    console.log(printers);

    // Start periodic status updates
    setInterval(() => {
      broadcastPrinterStatus(DNP_PRINTER_CONFIG.name);
    }, 5000); // Update every 5 seconds
  } catch (err) {
    console.error('Error getting printers:', err);
  }
});

// Upgrade HTTP server to WebSocket
server.on('upgrade', (request, socket, head) => {
  wss.handleUpgrade(request, socket, head, (ws) => {
    wss.emit('connection', ws, request);
  });
});