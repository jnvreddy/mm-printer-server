using MagicMomentsPrinter.Models;
using MagicMomentsPrinter.Services;
using Microsoft.AspNetCore.Mvc;

namespace MagicMomentsPrinter.Controllers
{
    [ApiController]
    [Route("api/[controller]")]
    public class DashboardController : ControllerBase
    {
        private readonly IPrinterService _printerService;
        private readonly ICloudflareTunnelService _tunnelService;
        private readonly ILogger<DashboardController> _logger;

        public DashboardController(
            IPrinterService printerService,
            ICloudflareTunnelService tunnelService,
            ILogger<DashboardController> logger)
        {
            _printerService = printerService;
            _tunnelService = tunnelService;
            _logger = logger;
        }

        [HttpGet("stats")]
        public async Task<ActionResult<DashboardStats>> GetStats()
        {
            try
            {
                var printers = await _printerService.GetAvailablePrintersAsync();
                var successfulPrints = GetSuccessfulPrintCount();

                var stats = new DashboardStats
                {
                    SuccessfulPrints = successfulPrints,
                    Printers = printers,
                    TunnelUrl = _tunnelService.TunnelUrl,
                    TunnelActive = _tunnelService.IsTunnelActive
                };

                return Ok(stats);
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "Error getting dashboard stats");
                return StatusCode(500, new { success = false, error = "Failed to get stats", details = ex.Message });
            }
        }

        [HttpGet("tunnel")]
        public ActionResult<object> GetTunnelStatus()
        {
            try
            {
                return Ok(new
                {
                    success = true,
                    url = _tunnelService.TunnelUrl,
                    active = _tunnelService.IsTunnelActive
                });
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "Error getting tunnel status");
                return StatusCode(500, new { success = false, error = "Failed to get tunnel status", details = ex.Message });
            }
        }

        private int GetSuccessfulPrintCount()
        {
            return _printerService.GetSuccessfulPrintCount();
        }
    }
}
