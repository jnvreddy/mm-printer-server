# Test printing script with real image
$headers = @{
    'Content-Type' = 'image/jpeg'
    'X-Copies' = '1'
    'X-Size' = '2x6'
}

# Use existing image from Prints folder
$imagePath = '../../Prints/12.jpg'
$imageBytes = [System.IO.File]::ReadAllBytes($imagePath)

try {
    Write-Host "Sending print request for image: $imagePath"
    Write-Host "Image size: $($imageBytes.Length) bytes"
    $response = Invoke-RestMethod -Uri 'http://localhost:3000/api/printer' -Method Post -Body $imageBytes -Headers $headers
    Write-Host "Print Response:"
    $response | ConvertTo-Json -Depth 3
} catch {
    Write-Host "Error:"
    Write-Host $_.Exception.Message
    if ($_.Exception.Response) {
        $reader = New-Object System.IO.StreamReader($_.Exception.Response.GetResponseStream())
        $responseBody = $reader.ReadToEnd()
        Write-Host "Response Body: $responseBody"
    }
}
