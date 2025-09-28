namespace MagicMomentsPrinter.Models
{
    public class AppSettings
    {
        public string BoothId { get; set; } = "booth1";
        public string PublicUrl { get; set; } = "booth1.magicmoment.co.in";
        public string CloudflareTunnelId { get; set; } = string.Empty;
        public string CloudflareCredentialsPath { get; set; } = "./secrets/cloudflare-credentials.json";
        public string CloudflaredPath { get; set; } = "./cloudflared.exe";
        public string ApiKey { get; set; } = string.Empty;
        public int Port { get; set; } = 3000;
        public string DefaultPaperSize { get; set; } = "2x6";
        public int MaxCopies { get; set; } = 100;
        public string DefaultPrinterName { get; set; } = "DS-RX1";
    }
}
