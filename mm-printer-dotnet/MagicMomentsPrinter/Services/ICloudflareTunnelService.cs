namespace MagicMomentsPrinter.Services
{
    public interface ICloudflareTunnelService
    {
        Task<string?> StartTunnelAsync();
        Task StopTunnelAsync();
        bool IsTunnelActive { get; }
        string? TunnelUrl { get; }
    }
}
