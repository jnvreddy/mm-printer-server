using MagicMomentsPrinter.Models;
using MagicMomentsPrinter.Services;
using Microsoft.Extensions.Hosting.WindowsServices;
using System.Management;

var builder = WebApplication.CreateBuilder(args);

// Configure the port explicitly
builder.WebHost.UseUrls("http://localhost:3000");

// Configure as Windows Service
builder.Host.UseWindowsService();

// Add services to the container
builder.Services.AddControllers();
builder.Services.AddEndpointsApiExplorer();
builder.Services.AddSwaggerGen();

// Configure CORS
builder.Services.AddCors(options =>
{
    options.AddPolicy("AllowAll", policy =>
    {
        policy.AllowAnyOrigin()
              .AllowAnyMethod()
              .AllowAnyHeader();
    });
});

// Configure settings
builder.Services.Configure<AppSettings>(builder.Configuration.GetSection("AppSettings"));
builder.Services.AddSingleton<AppSettings>(provider =>
{
    var config = provider.GetRequiredService<IConfiguration>();
    var settings = new AppSettings();
    config.GetSection("AppSettings").Bind(settings);
    return settings;
});

// Register services
builder.Services.AddSingleton<IPrinterService, PrinterService>();
builder.Services.AddSingleton<ICloudflareTunnelService, CloudflareTunnelService>();

// Configure static files
builder.Services.AddSpaStaticFiles(configuration =>
{
    configuration.RootPath = "wwwroot";
});

var app = builder.Build();

// Configure the HTTP request pipeline
if (app.Environment.IsDevelopment())
{
    app.UseSwagger();
    app.UseSwaggerUI();
}

app.UseCors("AllowAll");
app.UseStaticFiles();
app.UseSpaStaticFiles();

app.UseRouting();
app.UseAuthorization();

app.MapControllers();

// Serve SPA
app.UseSpa(spa =>
{
    spa.Options.SourcePath = "wwwroot";
    spa.Options.DefaultPageStaticFileOptions = new Microsoft.AspNetCore.Builder.StaticFileOptions
    {
        OnPrepareResponse = ctx =>
        {
            ctx.Context.Response.Headers.Append("Cache-Control", "no-cache, no-store, must-revalidate");
            ctx.Context.Response.Headers.Append("Pragma", "no-cache");
            ctx.Context.Response.Headers.Append("Expires", "0");
        }
    };
});

// Start Cloudflare tunnel on startup
var tunnelService = app.Services.GetRequiredService<ICloudflareTunnelService>();
_ = Task.Run(async () =>
{
    try
    {
        await Task.Delay(2000); // Wait for app to start
        var tunnelUrl = await tunnelService.StartTunnelAsync();
        if (tunnelUrl != null)
        {
            var logger = app.Services.GetRequiredService<ILogger<Program>>();
            logger.LogInformation("🌐 Cloudflare tunnel started: {Url}", tunnelUrl);
        }
    }
    catch (Exception ex)
    {
        var logger = app.Services.GetRequiredService<ILogger<Program>>();
        logger.LogError(ex, "Failed to start Cloudflare tunnel");
    }
});

// Graceful shutdown
var lifetime = app.Services.GetRequiredService<IHostApplicationLifetime>();
lifetime.ApplicationStopping.Register(async () =>
{
    var logger = app.Services.GetRequiredService<ILogger<Program>>();
    logger.LogInformation("Application is stopping, shutting down tunnel...");
    await tunnelService.StopTunnelAsync();
});

app.Run();