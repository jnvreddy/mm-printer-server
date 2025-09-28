# Test printing script
$headers = @{
    'Content-Type' = 'image/jpeg'
    'X-Copies' = '1'
    'X-Size' = '2x6'
}

# Create a simple test image (1x1 pixel JPEG)
$testImageBase64 = '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQH/2wBDAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQH/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAv/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAX/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwA/8A'
$imageBytes = [Convert]::FromBase64String($testImageBase64)

try {
    Write-Host "Sending print request..."
    $response = Invoke-RestMethod -Uri 'http://localhost:3000/api/printer' -Method Post -Body $imageBytes -Headers $headers
    Write-Host "Print Response:"
    $response | ConvertTo-Json -Depth 3
} catch {
    Write-Host "Error:"
    Write-Host $_.Exception.Message
}
