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

// Initialize Express app
const app = express();
const PORT = process.env.PORT || 3000;

// Configure middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(morgan('dev')); // Logging
app.use(express.static(path.join(__dirname, 'public')));

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
    // Only allow image files and PDFs
    const filetypes = /jpeg|jpg|png|gif|pdf/;
    const extname = filetypes.test(path.extname(file.originalname).toLowerCase());
    const mimetype = filetypes.test(file.mimetype);

    if (extname && mimetype) {
      return cb(null, true);
    } else {
      cb(new Error('Only images and PDF files are allowed!'));
    }
  }
});

// API Routes

// Get list of available printers
app.get('/api/printers', async (req, res) => {
  try {
    const printers = await getPrinters();
    res.json({ printers });
  } catch (err) {
    console.error('Error getting printers:', err);
    res.status(500).json({ error: 'Failed to get printers' });
  }
});

// Get default printer
app.get('/api/printers/default', async (req, res) => {
  try {
    const printers = await getPrinters();
    const defaultPrinter = printers.find(p => p.isDefault)?.name;
    res.json({ defaultPrinter });
  } catch (err) {
    console.error('Error getting default printer:', err);
    res.status(500).json({ error: 'Failed to get default printer' });
  }
});

// Print file
app.post('/api/print', upload.single('file'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }

  try {
    const { printerName, copies = 1 } = req.body;
    const filePath = req.file.path;

    // If no printer specified, get default printer
    let targetPrinter = printerName;
    if (!targetPrinter) {
      const printers = await getPrinters();
      targetPrinter = printers.find(p => p.isDefault)?.name;
    }

    if (!targetPrinter) {
      return res.status(400).json({ error: 'No printer specified and no default printer found' });
    }

    // If file is an image, convert it to PDF first
    if (path.extname(filePath).toLowerCase() !== '.pdf') {
      const pdfPath = filePath + '.pdf';
      await sharp(filePath)
        .toFormat('pdf')
        .toFile(pdfPath);

      // Print the converted PDF
      await print(pdfPath, {
        printer: targetPrinter,
        copies: parseInt(copies)
      });

      // Clean up the temporary PDF file
      fs.unlinkSync(pdfPath);
    } else {
      // Print PDF directly
      await print(filePath, {
        printer: targetPrinter,
        copies: parseInt(copies)
      });
    }

    res.json({
      success: true,
      message: 'Print job submitted successfully',
      fileName: req.file.filename,
      printer: targetPrinter
    });
  } catch (err) {
    console.error('Error processing print request:', err);
    res.status(500).json({ error: 'Failed to process print request' });
  }
});

// Get printer status
app.get('/api/printers/:printerName/status', async (req, res) => {
  try {
    const printerName = req.params.printerName;
    const printers = await getPrinters();
    const printer = printers.find(p => p.name === printerName);

    if (!printer) {
      return res.status(404).json({ error: 'Printer not found' });
    }

    res.json(printer);
  } catch (err) {
    console.error('Error getting printer status:', err);
    res.status(500).json({ error: 'Failed to get printer status' });
  }
});

// Root route serves the admin panel
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Start the server
app.listen(PORT, '0.0.0.0', async () => {
  console.log(`Printer Server running on port ${PORT}`);
  try {
    const printers = await getPrinters();
    console.log('Available printers:');
    console.log(printers);
  } catch (err) {
    console.error('Error getting printers:', err);
  }
});