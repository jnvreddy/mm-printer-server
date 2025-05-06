// server.js - Main server file for the DNP DS-RX1HS WiFi Print Server

const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const cors = require('cors');
const printer = require('printer');
const morgan = require('morgan');
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

// Get available printers
app.get('/api/printers', (req, res) => {
  try {
    const printers = printer.getPrinters();
    res.json({ printers });
  } catch (err) {
    console.error('Error getting printers:', err);
    res.status(500).json({ error: 'Failed to get printers' });
  }
});

// Get printer info
app.get('/api/printers/:printerName', (req, res) => {
  try {
    const printerName = req.params.printerName;
    const printerInfo = printer.getPrinter(printerName);
    res.json({ printer: printerInfo });
  } catch (err) {
    console.error('Error getting printer info:', err);
    res.status(500).json({ error: 'Failed to get printer info' });
  }
});

// Print file
app.post('/api/print', upload.single('file'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }

  try {
    const { printerName, options = {} } = req.body;
    const filePath = req.file.path;
    
    // Parse print options
    const printOptions = {
      printer: printerName,
      ...JSON.parse(options),
    };

    // Print the file
    printer.printFile({
      filename: filePath,
      printer: printOptions.printer,
      success: (jobID) => {
        console.log(`Print job submitted with ID: ${jobID}`);
        res.json({ 
          success: true, 
          message: 'Print job submitted successfully', 
          jobID,
          fileName: req.file.filename
        });
      },
      error: (err) => {
        console.error('Error printing file:', err);
        res.status(500).json({ error: 'Failed to print file' });
      }
    });
  } catch (err) {
    console.error('Error processing print request:', err);
    res.status(500).json({ error: 'Failed to process print request' });
  }
});

// Get print job status
app.get('/api/jobs/:jobId', (req, res) => {
  // This would ideally connect to the printer's job queue
  // For now, we'll just return a placeholder response
  res.json({ 
    jobId: req.params.jobId,
    status: 'completed',
    timestamp: new Date()
  });
});

// Root route serves the admin panel
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Start the server
app.listen(PORT, () => {
  console.log(`DNP Printer Server running on port ${PORT}`);
});