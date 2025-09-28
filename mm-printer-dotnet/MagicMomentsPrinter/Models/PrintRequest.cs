namespace MagicMomentsPrinter.Models
{
    public class PrintRequest
    {
        public byte[] ImageData { get; set; } = Array.Empty<byte>();
        public int Copies { get; set; } = 1;
        public string PaperSize { get; set; } = "2x6";
        public string? PrinterName { get; set; }
    }

    public class PrintResponse
    {
        public bool Success { get; set; }
        public string Message { get; set; } = string.Empty;
        public int RequestedCopies { get; set; }
        public int ActualPrintJobs { get; set; }
        public string RequestedSize { get; set; } = string.Empty;
        public string DnpPaperSize { get; set; } = string.Empty;
        public bool CutEnabled { get; set; }
        public string Printer { get; set; } = string.Empty;
        public string? Warning { get; set; }
    }

    public class PrinterInfo
    {
        public string Name { get; set; } = string.Empty;
        public string Status { get; set; } = string.Empty;
        public string DriverName { get; set; } = string.Empty;
        public bool IsConnected { get; set; }
    }

    public class PaperSize
    {
        public string Name { get; set; } = string.Empty;
        public double Width { get; set; }
        public double Height { get; set; }
        public string DnpSize { get; set; } = string.Empty;
        public bool CutEnabled { get; set; }
        public string Description { get; set; } = string.Empty;
    }

    public class DashboardStats
    {
        public int SuccessfulPrints { get; set; }
        public List<PrinterInfo> Printers { get; set; } = new();
        public string? TunnelUrl { get; set; }
        public bool TunnelActive { get; set; }
    }
}
