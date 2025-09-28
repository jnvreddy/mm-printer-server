using MagicMomentsPrinter.Models;
using Microsoft.Extensions.Logging;

namespace MagicMomentsPrinter.Services
{
    public class CloudflareTunnelService : ICloudflareTunnelService, IDisposable
    {
        private readonly ILogger<CloudflareTunnelService> _logger;
        private readonly AppSettings _settings;
        private System.Diagnostics.Process? _tunnelProcess;
        private bool _disposed = false;

        public bool IsTunnelActive => _tunnelProcess != null && !_tunnelProcess.HasExited;
        public string? TunnelUrl { get; private set; }

        public CloudflareTunnelService(ILogger<CloudflareTunnelService> logger, AppSettings settings)
        {
            _logger = logger;
            _settings = settings;
        }

        public async Task<string?> StartTunnelAsync()
        {
            try
            {
                if (IsTunnelActive)
                {
                    _logger.LogInformation("Tunnel is already active: {Url}", TunnelUrl);
                    return TunnelUrl;
                }

                var configPath = Path.Combine(Directory.GetCurrentDirectory(), "config", "tunnel.yml");
                var binaryPath = Path.Combine(Directory.GetCurrentDirectory(), _settings.CloudflaredPath);

                if (!File.Exists(binaryPath))
                {
                    _logger.LogError("Cloudflared binary not found at: {Path}", binaryPath);
                    return null;
                }

                if (!File.Exists(configPath))
                {
                    _logger.LogError("Tunnel config not found at: {Path}", configPath);
                    return null;
                }

                _logger.LogInformation("Starting Cloudflare tunnel...");

                var startInfo = new System.Diagnostics.ProcessStartInfo
                {
                    FileName = binaryPath,
                    Arguments = $"tunnel --config \"{configPath}\" run",
                    UseShellExecute = false,
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    CreateNoWindow = true,
                    WindowStyle = System.Diagnostics.ProcessWindowStyle.Hidden
                };

                _tunnelProcess = System.Diagnostics.Process.Start(startInfo);
                if (_tunnelProcess == null)
                {
                    _logger.LogError("Failed to start tunnel process");
                    return null;
                }

                // Read output to get tunnel URL
                var outputTask = ReadTunnelOutputAsync();
                var stderrTask = ReadTunnelErrorAsync();
                var timeoutTask = Task.Delay(15000); // 15 second timeout

                var completedTask = await Task.WhenAny(outputTask, stderrTask, timeoutTask);
                
                if (completedTask == timeoutTask)
                {
                    _logger.LogWarning("Tunnel startup timeout - but tunnel may still be working");
                    // Even if we don't get the URL, the tunnel might be working
                    // Set a default URL based on configuration
                    var defaultUrl = $"https://{_settings.PublicUrl}";
                    TunnelUrl = defaultUrl;
                    _logger.LogInformation("Tunnel may be active at: {Url}", defaultUrl);
                    return defaultUrl;
                }

                var tunnelUrl = await outputTask;
                if (tunnelUrl != null)
                {
                    TunnelUrl = tunnelUrl;
                    _logger.LogInformation("Tunnel started successfully: {Url}", tunnelUrl);
                    return tunnelUrl;
                }
                
                // If no URL detected but tunnel started, use configured URL
                var configuredUrl = $"https://{_settings.PublicUrl}";
                TunnelUrl = configuredUrl;
                _logger.LogInformation("Tunnel started - using configured URL: {Url}", configuredUrl);
                return configuredUrl;
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "Failed to start Cloudflare tunnel");
                return null;
            }
        }

        private async Task<string?> ReadTunnelOutputAsync()
        {
            if (_tunnelProcess == null) return null;

            try
            {
                var output = await _tunnelProcess.StandardOutput.ReadLineAsync();
                while (output != null)
                {
                    _logger.LogInformation("[cloudflared] {Output}", output);
                    
                    // Look for HTTPS URL in output - cloudflared outputs URLs in various formats
                    var urlMatch = System.Text.RegularExpressions.Regex.Match(output, @"https://[^\s]+");
                    if (urlMatch.Success)
                    {
                        return urlMatch.Value;
                    }
                    
                    // Also check for tunnel URL in different formats
                    if (output.Contains("https://") && output.Contains(".trycloudflare.com"))
                    {
                        var tryCloudflareMatch = System.Text.RegularExpressions.Regex.Match(output, @"https://[a-zA-Z0-9-]+\.trycloudflare\.com");
                        if (tryCloudflareMatch.Success)
                        {
                            return tryCloudflareMatch.Value;
                        }
                    }
                    
                    // Check for "Registered tunnel connection" which indicates tunnel is ready
                    if (output.Contains("Registered tunnel connection"))
                    {
                        _logger.LogInformation("Tunnel connection registered - tunnel is active");
                        // Return null to let the calling method handle the configured URL
                        return null;
                    }
                    
                    output = await _tunnelProcess.StandardOutput.ReadLineAsync();
                }
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "Error reading tunnel output");
            }

            return null;
        }

        private async Task ReadTunnelErrorAsync()
        {
            if (_tunnelProcess == null) return;

            try
            {
                var error = await _tunnelProcess.StandardError.ReadLineAsync();
                while (error != null)
                {
                    _logger.LogError("[cloudflared ERROR] {Error}", error);
                    error = await _tunnelProcess.StandardError.ReadLineAsync();
                }
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "Error reading tunnel error output");
            }
        }

        public async Task StopTunnelAsync()
        {
            try
            {
                if (_tunnelProcess != null && !_tunnelProcess.HasExited)
                {
                    _logger.LogInformation("Stopping Cloudflare tunnel...");
                    
                    _tunnelProcess.Kill();
                    await _tunnelProcess.WaitForExitAsync();
                    
                    _tunnelProcess.Dispose();
                    _tunnelProcess = null;
                    TunnelUrl = null;
                    
                    _logger.LogInformation("Tunnel stopped");
                }
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "Error stopping tunnel");
            }
        }

        public void Dispose()
        {
            if (!_disposed)
            {
                StopTunnelAsync().Wait();
                _disposed = true;
            }
        }
    }
}
