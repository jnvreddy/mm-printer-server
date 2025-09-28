using System.Drawing;
using System.Drawing.Printing;
using System.Management;
using MagicMomentsPrinter.Models;
using Microsoft.Extensions.Logging;
using ModelsPaperSize = MagicMomentsPrinter.Models.PaperSize;

namespace MagicMomentsPrinter.Services
{
    public class PrinterService : IPrinterService
    {
        private readonly ILogger<PrinterService> _logger;
        private readonly AppSettings _settings;
        private int _successfulPrintCount = 0;
        private List<PrinterInfo>? _cachedPrinters = null;
        private DateTime _lastPrinterCache = DateTime.MinValue;
        private readonly TimeSpan _cacheTimeout = TimeSpan.FromSeconds(30);

        // DNP Printer Configuration
        private readonly Dictionary<string, ModelsPaperSize> _paperSizes = new()
        {
            ["5x3.5"] = new ModelsPaperSize { Name = "5x3.5", Width = 5, Height = 3.5, DnpSize = "(5x3.5)", CutEnabled = false, Description = "5x3.5 prints on (5x3.5)" },
            ["5x5"] = new ModelsPaperSize { Name = "5x5", Width = 5, Height = 5, DnpSize = "(5x5)", CutEnabled = false, Description = "5x5 prints on (5x5)" },
            ["5x7"] = new ModelsPaperSize { Name = "5x7", Width = 5, Height = 7, DnpSize = "(5x7)", CutEnabled = false, Description = "5x7 prints on (5x7)" },
            ["6x4"] = new ModelsPaperSize { Name = "6x4", Width = 6, Height = 4, DnpSize = "(6x4)", CutEnabled = false, Description = "6x4 prints on (6x4)" },
            ["6x6"] = new ModelsPaperSize { Name = "6x6", Width = 6, Height = 6, DnpSize = "(6x6)", CutEnabled = false, Description = "6x6 prints on (6x6)" },
            ["6x8"] = new ModelsPaperSize { Name = "6x8", Width = 6, Height = 8, DnpSize = "(6x8)", CutEnabled = false, Description = "6x8 prints on (6x8)" },
            ["2x6"] = new ModelsPaperSize { Name = "2x6", Width = 2, Height = 6, DnpSize = "(6x4) x 2", CutEnabled = true, Description = "2x6 prints on (6x4) x 2 with cutting enabled" },
            ["3x4"] = new ModelsPaperSize { Name = "3x4", Width = 3, Height = 4, DnpSize = "(6x4) x 2", CutEnabled = true, Description = "3x4 prints on (6x4) x 2 with cutting enabled" },
            ["3.5x5"] = new ModelsPaperSize { Name = "3.5x5", Width = 3.5, Height = 5, DnpSize = "PR (3.5x5)", CutEnabled = false, Description = "3.5x5 prints on PR (3.5x5)" },
            ["4x6"] = new ModelsPaperSize { Name = "4x6", Width = 4, Height = 6, DnpSize = "PR (4x6)", CutEnabled = false, Description = "4x6 prints on PR (4x6)" },
            ["2x3"] = new ModelsPaperSize { Name = "2x3", Width = 2, Height = 3, DnpSize = "PR (4x6) x 2", CutEnabled = true, Description = "2x3 prints on PR (4x6) x 2 with cutting enabled" }
        };

        public PrinterService(ILogger<PrinterService> logger, AppSettings settings)
        {
            _logger = logger;
            _settings = settings;
        }

        public async Task<List<PrinterInfo>> GetAvailablePrintersAsync()
        {
            // Use cached printers if available and not expired
            if (_cachedPrinters != null && DateTime.Now - _lastPrinterCache < _cacheTimeout)
            {
                _logger.LogDebug("Returning cached printers: {Count}", _cachedPrinters.Count);
                return _cachedPrinters;
            }

            try
            {
                var printers = new List<PrinterInfo>();

                // Get printers using WMI
                using var searcher = new ManagementObjectSearcher("SELECT * FROM Win32_Printer");
                foreach (ManagementObject printer in searcher.Get())
                {
                    var name = printer["Name"]?.ToString() ?? "";
                    var status = printer["PrinterStatus"]?.ToString() ?? "Unknown";
                    var driverName = printer["DriverName"]?.ToString() ?? "";

                    // Filter for DNP printers
                    if (name.Contains("RX1", StringComparison.OrdinalIgnoreCase) ||
                        name.Contains("RX1HS", StringComparison.OrdinalIgnoreCase) ||
                        name.Contains("DNP", StringComparison.OrdinalIgnoreCase))
                    {
                        var isConnected = status == "3" || status == "Normal" || status == "Ready";
                        
                        printers.Add(new PrinterInfo
                        {
                            Name = name,
                            Status = status,
                            DriverName = driverName,
                            IsConnected = isConnected
                        });
                        
                        _logger.LogInformation("Found DNP printer: {Name}, Status: {Status}, Connected: {Connected}", 
                            name, status, isConnected);
                    }
                }

                // If no printers found, try to use the configured default printer
                if (printers.Count == 0 && !string.IsNullOrEmpty(_settings.DefaultPrinterName))
                {
                    _logger.LogWarning("No DNP printers found via WMI, using configured default: {DefaultPrinter}", _settings.DefaultPrinterName);
                    printers.Add(new PrinterInfo
                    {
                        Name = _settings.DefaultPrinterName,
                        Status = "Default",
                        DriverName = "Default",
                        IsConnected = true
                    });
                }

                // Cache the results
                _cachedPrinters = printers;
                _lastPrinterCache = DateTime.Now;

                _logger.LogInformation("Found {Count} DNP printers", printers.Count);
                return printers;
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "Failed to get available printers");
                
                // Return cached printers if available, even if expired
                if (_cachedPrinters != null)
                {
                    _logger.LogWarning("Returning expired cached printers due to error");
                    return _cachedPrinters;
                }
                
                return new List<PrinterInfo>();
            }
        }

        public async Task<PrintResponse> PrintImageAsync(PrintRequest request)
        {
            try
            {
                // Validate request
                if (request.ImageData == null || request.ImageData.Length == 0)
                {
                    return new PrintResponse
                    {
                        Success = false,
                        Message = "No image data received"
                    };
                }

                if (request.Copies < 1 || request.Copies > _settings.MaxCopies)
                {
                    return new PrintResponse
                    {
                        Success = false,
                        Message = $"Invalid number of copies. Must be between 1 and {_settings.MaxCopies}."
                    };
                }

                // Validate paper size
                if (!_paperSizes.TryGetValue(request.PaperSize, out var paperSize))
                {
                    return new PrintResponse
                    {
                        Success = false,
                        Message = $"Unsupported paper size: {request.PaperSize}"
                    };
                }

                // Get available printers
                var printers = await GetAvailablePrintersAsync();
                var dnpPrinter = printers.FirstOrDefault(p => p.IsConnected);

                if (dnpPrinter == null)
                {
                    return new PrintResponse
                    {
                        Success = false,
                        Message = "No DNP printer found or connected"
                    };
                }

                _logger.LogInformation("Using DNP printer: {PrinterName}", dnpPrinter.Name);

                // Create temporary file
                var tempFilePath = Path.Combine(Path.GetTempPath(), $"temp_print_{DateTime.Now:yyyyMMdd_HHmmss}.jpg");
                await File.WriteAllBytesAsync(tempFilePath, request.ImageData);

                try
                {
                    // Calculate actual print jobs needed
                    var actualPrintJobs = request.Copies;
                    if (paperSize.CutEnabled)
                    {
                        var stripsPerJob = paperSize.DnpSize.Contains("x 2") ? 2 : 1;
                        actualPrintJobs = (int)Math.Ceiling((double)request.Copies / stripsPerJob);
                        _logger.LogInformation("{Size} with cut: requesting {Copies} copies, sending {Jobs} print jobs ({Strips} strips per job)",
                            request.PaperSize, request.Copies, actualPrintJobs, stripsPerJob);
                    }

                    var successCount = 0;

                    // Send print jobs using silent printing
                    for (int i = 0; i < actualPrintJobs; i++)
                    {
                        try
                        {
                            await PrintImageSilentlyAsync(tempFilePath, dnpPrinter.Name, paperSize);
                            successCount++;
                            _logger.LogInformation("Print job {JobNumber} sent successfully", i + 1);
                        }
                        catch (Exception printError)
                        {
                            _logger.LogError(printError, "Print job {JobNumber} failed", i + 1);
                        }
                    }

                    // Update success count
                    _successfulPrintCount += successCount;

                    var response = new PrintResponse
                    {
                        Success = true,
                        Message = $"{successCount} print jobs sent to printer {dnpPrinter.Name}",
                        RequestedCopies = request.Copies,
                        ActualPrintJobs = successCount,
                        RequestedSize = request.PaperSize,
                        DnpPaperSize = paperSize.DnpSize,
                        CutEnabled = paperSize.CutEnabled,
                        Printer = dnpPrinter.Name
                    };

                    if (successCount < actualPrintJobs)
                    {
                        response.Warning = $"{actualPrintJobs - successCount} print jobs failed";
                    }

                    return response;
                }
                finally
                {
                    // Clean up temporary file
                    if (File.Exists(tempFilePath))
                    {
                        try
                        {
                            File.Delete(tempFilePath);
                        }
                        catch (Exception ex)
                        {
                            _logger.LogWarning(ex, "Failed to delete temporary file: {FilePath}", tempFilePath);
                        }
                    }
                }
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "Printing failed");
                return new PrintResponse
                {
                    Success = false,
                    Message = $"Printing failed: {ex.Message}"
                };
            }
        }

        private async Task PrintImageSilentlyAsync(string imagePath, string printerName, ModelsPaperSize paperSize)
        {
            try
            {
                // Method 1: Use Windows Print API with .NET System.Drawing.Printing (most reliable)
                await PrintUsingDotNetPrintingAsync(imagePath, printerName, paperSize);
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "DotNet printing method failed, trying direct file copy method");
                
                // Method 2: Copy file to printer queue directly (fallback)
                try
                {
                    await PrintUsingFileCopyAsync(imagePath, printerName);
                }
                catch (Exception copyEx)
                {
                    _logger.LogError(copyEx, "File copy print method also failed");
                    throw;
                }
            }
        }

        private async Task PrintUsingDotNetPrintingAsync(string imagePath, string printerName, ModelsPaperSize paperSize)
        {
            try
            {
                // Use .NET System.Drawing.Printing for silent printing
                var printScript = $@"
                    Add-Type -AssemblyName System.Drawing
                    Add-Type -AssemblyName System.Drawing.Printing
                    
                    try {{
                        $image = [System.Drawing.Image]::FromFile('{imagePath.Replace("\\", "\\\\")}')
                        $printDocument = New-Object System.Drawing.Printing.PrintDocument
                        $printDocument.PrinterSettings.PrinterName = '{printerName}'
                        
                        # Ensure printer is valid
                        if (-not $printDocument.PrinterSettings.IsValid) {{
                            throw 'Printer {printerName} is not valid or not available'
                        }}
                        
                        # Set paper size to 6x4 for DNP printer
                        $paperSize = $printDocument.PrinterSettings.PaperSizes | Where-Object {{ $_.PaperName -eq '6x4' -or $_.PaperName -eq '4x6' }}
                        if ($paperSize) {{
                            $printDocument.DefaultPageSettings.PaperSize = $paperSize
                        }}
                        
                        # Set margins to 0 for full page printing
                        $printDocument.DefaultPageSettings.Margins = New-Object System.Drawing.Printing.Margins(0, 0, 0, 0)
                        
                        # Add print page event handler
                        $printDocument.add_PrintPage({{ 
                            param($sender, $e)
                            try {{
                                # Calculate scaling to fit image to page
                                $pageWidth = $e.PageBounds.Width
                                $pageHeight = $e.PageBounds.Height
                                $imageWidth = $image.Width
                                $imageHeight = $image.Height
                                
                                # Calculate scale to fit image to page while maintaining aspect ratio
                                $scaleX = $pageWidth / $imageWidth
                                $scaleY = $pageHeight / $imageHeight
                                $scale = [Math]::Min($scaleX, $scaleY)
                                
                                $newWidth = $imageWidth * $scale
                                $newHeight = $imageHeight * $scale
                                
                                # Center the image on the page
                                $x = ($pageWidth - $newWidth) / 2
                                $y = ($pageHeight - $newHeight) / 2
                                
                                $e.Graphics.DrawImage($image, $x, $y, $newWidth, $newHeight)
                                $e.HasMorePages = $false
                            }} catch {{
                                Write-Error 'Error in PrintPage event: ' + $_.Exception.Message
                                $e.HasMorePages = $false
                            }}
                        }})
                        
                        # Print the document
                        $printDocument.Print()
                        $image.Dispose()
                        Write-Output 'Print job sent successfully to {printerName}'
                        
                    }} catch {{
                        Write-Error 'Print failed: ' + $_.Exception.Message
                        exit 1
                    }}
                ";

                var startInfo = new System.Diagnostics.ProcessStartInfo
                {
                    FileName = "powershell.exe",
                    Arguments = $"-Command \"{printScript}\"",
                    UseShellExecute = false,
                    CreateNoWindow = true,
                    WindowStyle = System.Diagnostics.ProcessWindowStyle.Hidden,
                    RedirectStandardOutput = true,
                    RedirectStandardError = true
                };

                using var process = System.Diagnostics.Process.Start(startInfo);
                if (process != null)
                {
                    await process.WaitForExitAsync();
                    if (process.ExitCode != 0)
                    {
                        var error = await process.StandardError.ReadToEndAsync();
                        throw new Exception($"Print failed: {error}");
                    }
                    
                    var output = await process.StandardOutput.ReadToEndAsync();
                    _logger.LogInformation("Print output: {Output}", output);
                }
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "DotNet printing method failed");
                throw;
            }
        }

        private async Task PrintUsingFileCopyAsync(string imagePath, string printerName)
        {
            try
            {
                // Alternative method: Copy file directly to printer queue
                var printScript = $@"
                    # Get printer port
                    $printer = Get-WmiObject -Class Win32_Printer | Where-Object {{ $_.Name -eq '{printerName}' }}
                    if (-not $printer) {{
                        throw 'Printer {printerName} not found'
                    }}
                    
                    $printerPort = $printer.PortName
                    Write-Output 'Printer port: ' + $printerPort
                    
                    # Copy file to printer port (this bypasses print dialog)
                    Copy-Item '{imagePath.Replace("\\", "\\\\")}' $printerPort -Force
                    Write-Output 'File copied to printer port successfully'
                ";

                var startInfo = new System.Diagnostics.ProcessStartInfo
                {
                    FileName = "powershell.exe",
                    Arguments = $"-Command \"{printScript}\"",
                    UseShellExecute = false,
                    CreateNoWindow = true,
                    WindowStyle = System.Diagnostics.ProcessWindowStyle.Hidden,
                    RedirectStandardOutput = true,
                    RedirectStandardError = true
                };

                using var process = System.Diagnostics.Process.Start(startInfo);
                if (process != null)
                {
                    await process.WaitForExitAsync();
                    if (process.ExitCode != 0)
                    {
                        var error = await process.StandardError.ReadToEndAsync();
                        throw new Exception($"File copy print failed: {error}");
                    }
                }
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "File copy print method failed");
                throw;
            }
        }

        public async Task<List<Models.PaperSize>> GetAvailablePaperSizesAsync()
        {
            return await Task.FromResult(_paperSizes.Values.ToList());
        }

        public async Task<int> GetPrintQueueCountAsync(string printerName)
        {
            try
            {
                using var searcher = new ManagementObjectSearcher($"SELECT * FROM Win32_PrintJob WHERE Name LIKE '%{printerName}%'");
                var jobs = searcher.Get();
                return jobs.Count;
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "Failed to get print queue count for {PrinterName}", printerName);
                return 0;
            }
        }

        public int GetSuccessfulPrintCount()
        {
            return _successfulPrintCount;
        }

        public void ClearPrinterCache()
        {
            _cachedPrinters = null;
            _lastPrinterCache = DateTime.MinValue;
            _logger.LogInformation("Printer cache cleared");
        }
    }
}

