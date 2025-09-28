using MagicMomentsPrinter.Models;

namespace MagicMomentsPrinter.Services
{
    public interface IPrinterService
    {
        Task<List<PrinterInfo>> GetAvailablePrintersAsync();
        Task<PrintResponse> PrintImageAsync(PrintRequest request);
        Task<List<Models.PaperSize>> GetAvailablePaperSizesAsync();
        Task<int> GetPrintQueueCountAsync(string printerName);
        int GetSuccessfulPrintCount();
    }
}
