# Test script to verify printer detection works consistently
Write-Host "Testing printer detection consistency..."

$apiUrl = "http://localhost:3000/api/printer"

# Test multiple requests to see if printer detection is consistent
for ($i = 1; $i -le 5; $i++) {
    Write-Host "`n--- Test $i ---"
    try {
        $response = Invoke-RestMethod -Uri $apiUrl -Method Get
        Write-Host "Success: Found $($response.printers.Count) printers"
        if ($response.printers.Count -gt 0) {
            foreach ($printer in $response.printers) {
                Write-Host "  - $($printer.name) (Status: $($printer.status), Connected: $($printer.isConnected))"
            }
        }
    }
    catch {
        Write-Host "Error: $($_.Exception.Message)"
    }
    
    Start-Sleep -Seconds 2
}

Write-Host "`nPrinter detection test completed!"
