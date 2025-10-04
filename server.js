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


// Function to print file to Windows printer spooler using GDI+ (like LumaBooth Assistant)
const printFile = (filePath, savedImagePath, options = {}) => {
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

    // Use System.Drawing.Printing (exactly like LumaBooth Assistant)
    const lumaBoothStyleScript = `
      try {
        Write-Output "=== Starting LumaBooth-style printing ==="
        
        Add-Type -AssemblyName System.Drawing
        Write-Output "System.Drawing assembly loaded"
        
        $inputPath = '${savedImagePath.replace(/\\/g, '\\\\')}'
        $printerName = '${printer}'
        $copies = ${copies}
        
        Write-Output "Input path: $inputPath"
        Write-Output "Printer: $printerName"
        Write-Output "Copies: $copies"
        
        # Check if file exists
        if (-not (Test-Path $inputPath)) {
          Write-Error "Input file does not exist: $inputPath"
          exit 1
        }
        Write-Output "Input file exists"
        
        # Load the image with error handling
        try {
          # Try loading as Bitmap first (more reliable)
          $image = New-Object System.Drawing.Bitmap($inputPath)
          Write-Output "Loaded image as Bitmap: $($image.Width)x$($image.Height)"
          Write-Output "Image format: $($image.PixelFormat)"
          
          # Test if image is valid
          if ($image.Width -eq 0 -or $image.Height -eq 0) {
            throw "Image has zero dimensions"
          }
          
          # Get multiple sample pixels to verify image has data
          $samplePixel1 = $image.GetPixel(0, 0)
          $samplePixel2 = $image.GetPixel($image.Width/2, $image.Height/2)
          $samplePixel3 = $image.GetPixel($image.Width-1, $image.Height-1)
          
          Write-Output "Sample pixel 1 (0,0): R=$($samplePixel1.R), G=$($samplePixel1.G), B=$($samplePixel1.B)"
          Write-Output "Sample pixel 2 (center): R=$($samplePixel2.R), G=$($samplePixel2.G), B=$($samplePixel2.B)"
          Write-Output "Sample pixel 3 (end): R=$($samplePixel3.R), G=$($samplePixel3.G), B=$($samplePixel3.B)"
          
          # Check if image is all white (corrupted)
          if ($samplePixel1.R -eq 255 -and $samplePixel1.G -eq 255 -and $samplePixel1.B -eq 255 -and
              $samplePixel2.R -eq 255 -and $samplePixel2.G -eq 255 -and $samplePixel2.B -eq 255) {
            Write-Warning "Image appears to be all white - this may indicate a corrupted file"
            Write-Output "File size: $((Get-Item $inputPath).Length) bytes"
            Write-Output "File last modified: $((Get-Item $inputPath).LastWriteTime)"
          }
          
          Write-Output "Image validation completed"
        } catch {
          Write-Error "Failed to load or validate image: $($_.Exception.Message)"
          exit 1
        }
        
        # Create PrintDocument (exactly like LumaBooth Assistant)
        $printDocument = New-Object System.Drawing.Printing.PrintDocument
        Write-Output "Created PrintDocument"
        
        $printDocument.PrinterSettings.PrinterName = $printerName
        $printDocument.PrinterSettings.Copies = $copies
        Write-Output "Set printer settings"
        
        # Set ZERO margins (this is the key!)
        $printDocument.DefaultPageSettings.Margins = New-Object System.Drawing.Printing.Margins(0, 0, 0, 0)
        Write-Output "Set margins to zero"
        
        # Use standard paper sizes that DNP printer recognizes
        Write-Output "Setting up paper size for DNP printer"
        
        # Debug: List available paper sizes
        $paperSizes = $printDocument.PrinterSettings.PaperSizes
        Write-Output "Available paper sizes:"
        foreach ($size in $paperSizes) {
          Write-Output "  - $($size.PaperName) ($($size.Width) x $($size.Height))"
        }
        
        # For 2x6 - use PR (4x6) x 2 paper size (vertical orientation)
        if ('${paperSize}' -eq '2x6') {
          # Look for PR (4x6) x 2 paper size (vertical: height > width)
          $paperSizes = $printDocument.PrinterSettings.PaperSizes
          $standardPaperSize = $null
          foreach ($size in $paperSizes) {
            if ($size.PaperName -like "*PR (4x6) x 2*" -or $size.PaperName -like "*4x6*2*" -or $size.PaperName -like "*4 x 6*2*") {
              $standardPaperSize = $size
              break
            }
          }
          if ($standardPaperSize) {
            $printDocument.DefaultPageSettings.PaperSize = $standardPaperSize
            Write-Output "Set PR (4x6) x 2 paper size (vertical): $($standardPaperSize.PaperName) - Width: $($standardPaperSize.Width), Height: $($standardPaperSize.Height)"
          } else {
            Write-Output "No PR (4x6) x 2 paper size found, trying (6x4) x 2"
            # Fallback to (6x4) x 2 if PR (4x6) x 2 not found
            foreach ($size in $paperSizes) {
              if ($size.PaperName -like "*(6x4) x 2*" -or $size.PaperName -like "*6x4*2*" -or $size.PaperName -like "*6 x 4*2*") {
                $standardPaperSize = $size
                break
              }
            }
            if ($standardPaperSize) {
              $printDocument.DefaultPageSettings.PaperSize = $standardPaperSize
              Write-Output "Set (6x4) x 2 paper size (horizontal): $($standardPaperSize.PaperName) - Width: $($standardPaperSize.Width), Height: $($standardPaperSize.Height)"
            } else {
              Write-Output "No (6x4) x 2 paper size found, using default"
            }
          }
        } elseif ('${paperSize}' -eq '3x4') {
          # For 3x4 - also use (6x4) x 2
          $paperSizes = $printDocument.PrinterSettings.PaperSizes
          $standardPaperSize = $null
          foreach ($size in $paperSizes) {
            if ($size.PaperName -like "*(6x4) x 2*" -or $size.PaperName -like "*6x4*2*" -or $size.PaperName -like "*6 x 4*2*") {
              $standardPaperSize = $size
              break
            }
          }
          if ($standardPaperSize) {
            $printDocument.DefaultPageSettings.PaperSize = $standardPaperSize
            Write-Output "Set (6x4) x 2 paper size for 3x4: $($standardPaperSize.PaperName)"
          } else {
            Write-Output "No (6x4) x 2 paper size found for 3x4, using default"
          }
        } elseif ('${paperSize}' -eq '6x4') {
          # For 6x4 - use standard 6x4 paper size
          $paperSizes = $printDocument.PrinterSettings.PaperSizes
          $standardPaperSize = $null
          foreach ($size in $paperSizes) {
            if ($size.PaperName -like "*6x4*" -or $size.PaperName -like "*6 x 4*") {
              $standardPaperSize = $size
              break
            }
          }
          if ($standardPaperSize) {
            $printDocument.DefaultPageSettings.PaperSize = $standardPaperSize
            Write-Output "Set 6x4 paper size: $($standardPaperSize.PaperName)"
          } else {
            Write-Output "No 6x4 paper size found, using default"
          }
        } elseif ('${paperSize}' -eq '5x7') {
          # Use standard 5x7 paper size
          $paperSizes = $printDocument.PrinterSettings.PaperSizes
          $standardPaperSize = $null
          foreach ($size in $paperSizes) {
            if ($size.PaperName -like "*5x7*" -or $size.PaperName -like "*5 x 7*") {
              $standardPaperSize = $size
              break
            }
          }
          if ($standardPaperSize) {
            $printDocument.DefaultPageSettings.PaperSize = $standardPaperSize
            Write-Output "Set standard paper size: $($standardPaperSize.PaperName)"
          } else {
            Write-Output "No standard 5x7 paper size found, using default"
          }
        } else {
          Write-Output "Using default paper size"
        }
        
        # Add BeginPrint event to ensure PrintPage fires
        $printDocument.add_BeginPrint({
          param($sender, $e)
          Write-Output "=== BeginPrint event triggered ==="
        })
        
        # Add EndPrint event for completion
        $printDocument.add_EndPrint({
          param($sender, $e)
          Write-Output "=== EndPrint event triggered ==="
        })
        
        # Handle PrintPage event (exactly like LumaBooth Assistant)
        $printDocument.add_PrintPage({
          param($sender, $e)
          
          Write-Output "=== PrintPage event triggered ==="
          Write-Output "Sender: $($sender.GetType().Name)"
          Write-Output "Event args: $($e.GetType().Name)"
          Write-Output "Page bounds: $($e.PageBounds)"
          Write-Output "Margin bounds: $($e.MarginBounds)"
          Write-Output "Image size: $($downloadsImage.Width) x $($downloadsImage.Height)"
          
          # Calculate proper scaling to fill page while maintaining aspect ratio
          $pageWidth = $e.PageBounds.Width
          $pageHeight = $e.PageBounds.Height
          $imageWidth = $downloadsImage.Width
          $imageHeight = $downloadsImage.Height
          
          Write-Output "Page: $pageWidth x $pageHeight, Image: $imageWidth x $imageHeight"
          
          # Calculate scale factors
          $scaleX = $pageWidth / $imageWidth
          $scaleY = $pageHeight / $imageHeight
          
          # Use the larger scale to fill the page completely (may crop slightly)
          $scale = [Math]::Max($scaleX, $scaleY)
          
          $scaledWidth = $imageWidth * $scale
          $scaledHeight = $imageHeight * $scale
          
          # Center the scaled image on the page
          $x = ($pageWidth - $scaledWidth) / 2
          $y = ($pageHeight - $scaledHeight) / 2
          
          Write-Output "Scale: $scale, Scaled: $scaledWidth x $scaledHeight, Position: $x, $y"
          
          # Set high quality rendering
          $e.Graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
          $e.Graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
          $e.Graphics.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
          Write-Output "Set high quality rendering modes"
          
          # Try multiple drawing methods for reliability
          try {
            # Method 1: Draw with explicit scaling
            Write-Output "Attempting Method 1: Explicit scaling"
            $e.Graphics.DrawImage($downloadsImage, $x, $y, $scaledWidth, $scaledHeight)
            Write-Output "Method 1 successful: Image drawn with scaling"
          } catch {
            Write-Output "Method 1 failed: $($_.Exception.Message)"
            try {
              # Method 2: Draw to full page bounds
              Write-Output "Attempting Method 2: Full page bounds"
              $e.Graphics.DrawImage($downloadsImage, 0, 0, $pageWidth, $pageHeight)
              Write-Output "Method 2 successful: Image drawn to full page"
            } catch {
              Write-Output "Method 2 failed: $($_.Exception.Message)"
              # Method 3: Draw with source and destination rectangles
              Write-Output "Attempting Method 3: Source/destination rectangles"
              $srcRect = New-Object System.Drawing.Rectangle(0, 0, $imageWidth, $imageHeight)
              $destRect = New-Object System.Drawing.Rectangle(0, 0, $pageWidth, $pageHeight)
              $e.Graphics.DrawImage($downloadsImage, $destRect, $srcRect, [System.Drawing.GraphicsUnit]::Pixel)
              Write-Output "Method 3 successful: Image drawn with rectangles"
            }
          }
          
          $e.HasMorePages = $false
        })
        Write-Output "Added BeginPrint, EndPrint, and PrintPage event handlers"
        
        # Use the Downloads folder image directly (don't create new images)
        Write-Output "Using Downloads folder image directly for LumaBooth-style printing..."
        
        # Dispose of the current image since we'll load from Downloads folder
        $image.Dispose()
        Write-Output "Disposed of current image, will load from Downloads folder"
        
        # Load the image directly from Downloads folder
        $downloadsImage = New-Object System.Drawing.Bitmap($inputPath)
        Write-Output "Loaded Downloads folder image: $($downloadsImage.Width)x$($downloadsImage.Height)"
        
        # Verify the Downloads image has content
        $samplePixel = $downloadsImage.GetPixel($downloadsImage.Width/2, $downloadsImage.Height/2)
        Write-Output "Downloads image sample pixel: R=$($samplePixel.R), G=$($samplePixel.G), B=$($samplePixel.B)"
        
        # Print the document using Downloads image
        Write-Output "Starting print job with Downloads image..."
        
        # Force PrintPage event to fire by using PreviewPrintController first
        Write-Output "Setting up PreviewPrintController to force PrintPage event..."
        $printDocument.PrintController = New-Object System.Drawing.Printing.PreviewPrintController
        
        try {
          # Try with PreviewPrintController first (this should force PrintPage to fire)
          Write-Output "Attempting print with PreviewPrintController..."
          $printDocument.Print()
          Write-Output "PreviewPrintController print completed successfully"
          
          # Now try actual printing with StandardPrintController
          Write-Output "Setting up StandardPrintController for actual printing..."
          $printDocument.PrintController = New-Object System.Drawing.Printing.StandardPrintController
          
          Write-Output "Attempting actual print with StandardPrintController..."
          $printDocument.Print()
          Write-Output "StandardPrintController print completed successfully"
          
        } catch {
          Write-Output "Print failed: $($_.Exception.Message)"
          try {
            # Try with default PrintController
            Write-Output "Attempting with default PrintController..."
            $printDocument.PrintController = $null
            $printDocument.Print()
            Write-Output "Default PrintController print completed successfully"
          } catch {
            Write-Error "All print methods failed: $($_.Exception.Message)"
            Write-Output "Exception type: $($_.Exception.GetType().Name)"
            Write-Output "Stack trace: $($_.Exception.StackTrace)"
            exit 1
          }
        }
        
        # Cleanup Downloads image
        $downloadsImage.Dispose()
        Write-Output "Cleaned up Downloads image"
        
        # Cleanup
        $printDocument.Dispose()
        Write-Output "Cleaned up resources"
        
        Write-Output "LumaBooth-style print job queued successfully with zero margins"
        
      } catch {
        Write-Error "LumaBooth-style printing failed: $($_.Exception.Message)"
        Write-Error "Stack trace: $($_.Exception.StackTrace)"
        Write-Error "Error details: $($_.Exception)"
        exit 1
      }
    `;

    // Write PowerShell script to temporary file
    const scriptPath = path.join(__dirname, `print_script_${Date.now()}.ps1`);
    fs.writeFileSync(scriptPath, lumaBoothStyleScript);

    const printCommand = `powershell.exe -ExecutionPolicy Bypass -File "${scriptPath}"`;
    console.log(`Executing LumaBooth-style print command for ${printer}`);

    exec(printCommand, { timeout: 20000 }, (error, stdout, stderr) => {
      if (error) {
        console.error(`LumaBooth-style print error:`, error);
        console.error(`Error details:`, error.message);
        reject(new Error(`LumaBooth-style print failed: ${error.message}`));
        return;
      }

      if (stderr) {
        console.warn(`LumaBooth-style warning:`, stderr);
      }

      console.log(`LumaBooth-style stdout:`, stdout);
      console.log(`LumaBooth-style stderr:`, stderr);
      console.log(`LumaBooth-style stdout length:`, stdout ? stdout.length : 0);
      console.log(`LumaBooth-style stderr length:`, stderr ? stderr.length : 0);

      if (stdout && (stdout.includes('LumaBooth-style print job queued successfully') || stdout.includes('Print job completed successfully'))) {
        console.log(`Successfully sent LumaBooth-style print job to printer ${printer} with size ${actualPaperSize} (zero margins)`);
        resolve({
          success: true,
          copies: copies,
          paperSize: actualPaperSize,
          cutEnabled: cutEnabled,
          requestedSize: paperSize,
          queued: true,
          message: 'Print job queued successfully via LumaBooth-style printing (zero margins)'
        });
      } else if (!error) {
        // If no error but no success message, assume it worked (PowerShell completed without error)
        console.log(`PowerShell completed without error, assuming print job was sent to printer ${printer}`);
        resolve({
          success: true,
          copies: copies,
          paperSize: actualPaperSize,
          cutEnabled: cutEnabled,
          requestedSize: paperSize,
          queued: true,
          message: 'Print job queued successfully via LumaBooth-style printing (zero margins)'
        });
      } else {
        console.error(`LumaBooth-style script did not report success. Output:`, stdout);
        reject(new Error(`LumaBooth-style print script did not complete successfully. Output: ${stdout}`));
      }

      // Clean up PowerShell script file
      try {
        fs.unlinkSync(scriptPath);
        console.log(`Cleaned up PowerShell script file: ${scriptPath}`);
      } catch (cleanupError) {
        console.error('Failed to cleanup PowerShell script file:', cleanupError);
      }
    });
  });
};

const safeGetPrinters = async () => {
  try {
    const printers = await getPrinters();
    console.log("Detected printers:");
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

      console.log(`Queue check raw output:`, stdout);
      console.log(`Queue check stderr:`, stderr);

      // Handle empty output
      if (!stdout || stdout.trim() === '') {
        console.log(`No print jobs found in queue for ${printerName}`);
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
        console.error("Raw output that failed to parse:", stdout);
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

    // Save image to Downloads folder (more accessible)
    let savedImagePath = null;
    try {
      const downloadsDir = path.join(require('os').homedir(), 'Downloads');

      // Generate unique filename with timestamp
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      savedImagePath = path.join(downloadsDir, `print-${timestamp}.jpg`);

      // Save the original image to Downloads folder
      fs.writeFileSync(savedImagePath, req.body);
      console.log(`Saved image to Downloads folder: ${savedImagePath}`);
    } catch (saveError) {
      console.error('Failed to save image to Downloads folder:', saveError);
      clearTimeout(requestTimeout);
      return res.status(500).json({ success: false, error: 'Failed to save image' });
    }

    // Also save to Prints folder for backup
    try {
      const printsDir = path.join(__dirname, 'Prints');

      // Ensure Prints directory exists
      if (!fs.existsSync(printsDir)) {
        fs.mkdirSync(printsDir, { recursive: true });
        console.log(`Created Prints directory: ${printsDir}`);
      }

      // Generate unique filename with timestamp
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const printsImagePath = path.join(printsDir, `print-${timestamp}.jpg`);

      // Save the original image to Prints folder
      fs.writeFileSync(printsImagePath, req.body);
      console.log(`Saved image to Prints folder: ${printsImagePath}`);
    } catch (saveError) {
      console.error('Failed to save image to Prints folder:', saveError);
      // Continue with printing even if saving to Prints fails
    }

    // Create temporary file for compatibility (but use saved image for printing)
    tempFilePath = path.join(__dirname, `temp_${Date.now()}.jpg`);
    fs.writeFileSync(tempFilePath, req.body);

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
    let actualPrintJobs = copies;
    let copiesPerJob = 1;

    // For 2x6 size, halve the number of print jobs since each job produces 2 copies
    if (requestedSize === '2x6') {
      actualPrintJobs = copies / 2;
      copiesPerJob = 1; // Each print job shows as 1 copy in queue, but produces 2 physical prints
      console.log(`2x6 size: requesting ${copies} copies, sending ${actualPrintJobs} print jobs (1 copy per job, 2 physical prints per job)`);
    }

    // Send print jobs - just send the original image with the correct paper size
    for (let i = 0; i < actualPrintJobs; i++) {
      try {
        const printResult = await printFile(tempFilePath, savedImagePath, {
          printer: dnpPrinterName,
          paperSize: requestedSize,
          cut: cutEnabled,
          copies: copiesPerJob
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

    // Clean up saved image file after printing (with 5 second delay)
    if (savedImagePath && fs.existsSync(savedImagePath)) {
      setTimeout(() => {
        try {
          fs.unlinkSync(savedImagePath);
          console.log(`Cleaned up saved image file after 5 seconds: ${savedImagePath}`);
        } catch (cleanupError) {
          console.error('Failed to cleanup saved image file:', cleanupError);
        }
      }, 5000); // 5 second delay
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
    if (successCount < actualPrintJobs) {
      response.warning = `${actualPrintJobs - successCount} print jobs failed`;
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

    // Clean up saved image file on error (with 5 second delay)
    if (savedImagePath && fs.existsSync(savedImagePath)) {
      setTimeout(() => {
        try {
          fs.unlinkSync(savedImagePath);
          console.log(`Cleaned up saved image file on error after 5 seconds: ${savedImagePath}`);
        } catch (cleanupError) {
          console.error('Failed to cleanup saved image file on error:', cleanupError);
        }
      }, 5000); // 5 second delay
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

