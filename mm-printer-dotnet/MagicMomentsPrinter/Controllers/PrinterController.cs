using MagicMomentsPrinter.Models;
using MagicMomentsPrinter.Services;
using Microsoft.AspNetCore.Mvc;

namespace MagicMomentsPrinter.Controllers
{
    [ApiController]
    [Route("api/[controller]")]
    public class PrinterController : ControllerBase
    {
        private readonly IPrinterService _printerService;
        private readonly ICloudflareTunnelService _tunnelService;
        private readonly ILogger<PrinterController> _logger;

        public PrinterController(
            IPrinterService printerService,
            ICloudflareTunnelService tunnelService,
            ILogger<PrinterController> logger)
        {
            _printerService = printerService;
            _tunnelService = tunnelService;
            _logger = logger;
        }

        [HttpPost]
        public async Task<ActionResult<PrintResponse>> PrintImage()
        {
            try
            {
                // Read image data from request body
                byte[] imageData;
                using (var memoryStream = new MemoryStream())
                {
                    await Request.Body.CopyToAsync(memoryStream);
                    imageData = memoryStream.ToArray();
                }

                if (imageData.Length == 0)
                {
                    return BadRequest(new PrintResponse
                    {
                        Success = false,
                        Message = "No image data received"
                    });
                }

                // Get headers
                var copies = int.TryParse(Request.Headers["X-Copies"].FirstOrDefault(), out var copyCount) ? copyCount : 1;
                var paperSize = Request.Headers["X-Size"].FirstOrDefault() ?? "2x6";

                var request = new PrintRequest
                {
                    ImageData = imageData,
                    Copies = copies,
                    PaperSize = paperSize
                };

                _logger.LogInformation("Print request received: {Copies} copies, size: {Size}", copies, paperSize);

                var result = await _printerService.PrintImageAsync(request);
                return Ok(result);
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "Error processing print request");
                return StatusCode(500, new PrintResponse
                {
                    Success = false,
                    Message = $"Internal server error: {ex.Message}"
                });
            }
        }

        [HttpGet]
        public async Task<ActionResult<List<PrinterInfo>>> GetPrinters()
        {
            try
            {
                var printers = await _printerService.GetAvailablePrintersAsync();
                return Ok(printers);
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "Error getting printers");
                return StatusCode(500, new { success = false, error = "Failed to get printers", details = ex.Message });
            }
        }

        [HttpGet("sizes")]
        public async Task<ActionResult<List<PaperSize>>> GetPaperSizes()
        {
            try
            {
                var sizes = await _printerService.GetAvailablePaperSizesAsync();
                return Ok(sizes);
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "Error getting paper sizes");
                return StatusCode(500, new { success = false, error = "Failed to get paper sizes", details = ex.Message });
            }
        }

        [HttpGet("queue/{printerName}")]
        public async Task<ActionResult<object>> GetPrintQueue(string printerName)
        {
            try
            {
                var queueCount = await _printerService.GetPrintQueueCountAsync(printerName);
                return Ok(new
                {
                    success = true,
                    printer = printerName,
                    queueCount = queueCount
                });
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "Error getting print queue for {PrinterName}", printerName);
                return StatusCode(500, new { success = false, error = "Failed to get print queue", details = ex.Message });
            }
        }
    }
}
