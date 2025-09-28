# Test script to verify silent printing works
$imagePath = "../../Prints/12.jpg"
$printerName = "DS-RX1"

Write-Host "Testing silent printing with PowerShell..."
Write-Host "Image: $imagePath"
Write-Host "Printer: $printerName"

# Test the new silent printing method
$printScript = @"
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Drawing.Printing

try {
    `$image = [System.Drawing.Image]::FromFile('$imagePath')
    `$printDocument = New-Object System.Drawing.Printing.PrintDocument
    `$printDocument.PrinterSettings.PrinterName = '$printerName'
    
    # Ensure printer is valid
    if (-not `$printDocument.PrinterSettings.IsValid) {
        throw 'Printer $printerName is not valid or not available'
    }
    
    Write-Output 'Printer is valid: ' + `$printDocument.PrinterSettings.IsValid
    Write-Output 'Available paper sizes:'
    `$printDocument.PrinterSettings.PaperSizes | ForEach-Object { Write-Output "  - " + `$_.PaperName }
    
    # Set paper size to 6x4 for DNP printer
    `$paperSize = `$printDocument.PrinterSettings.PaperSizes | Where-Object { `$_.PaperName -eq '6x4' -or `$_.PaperName -eq '4x6' }
    if (`$paperSize) {
        `$printDocument.DefaultPageSettings.PaperSize = `$paperSize
        Write-Output 'Paper size set to: ' + `$paperSize.PaperName
    } else {
        Write-Output 'Using default paper size: ' + `$printDocument.DefaultPageSettings.PaperSize.PaperName
    }
    
    # Set margins to 0 for full page printing
    `$printDocument.DefaultPageSettings.Margins = New-Object System.Drawing.Printing.Margins(0, 0, 0, 0)
    
    # Add print page event handler
    `$printDocument.add_PrintPage({ 
        param(`$sender, `$e)
        try {
            # Calculate scaling to fit image to page
            `$pageWidth = `$e.PageBounds.Width
            `$pageHeight = `$e.PageBounds.Height
            `$imageWidth = `$image.Width
            `$imageHeight = `$image.Height
            
            # Calculate scale to fit image to page while maintaining aspect ratio
            `$scaleX = `$pageWidth / `$imageWidth
            `$scaleY = `$pageHeight / `$imageHeight
            `$scale = [Math]::Min(`$scaleX, `$scaleY)
            
            `$newWidth = `$imageWidth * `$scale
            `$newHeight = `$imageHeight * `$scale
            
            # Center the image on the page
            `$x = (`$pageWidth - `$newWidth) / 2
            `$y = (`$pageHeight - `$newHeight) / 2
            
            `$e.Graphics.DrawImage(`$image, `$x, `$y, `$newWidth, `$newHeight)
            `$e.HasMorePages = `$false
            Write-Output 'Image drawn successfully'
        } catch {
            Write-Error 'Error in PrintPage event: ' + `$_.Exception.Message
            `$e.HasMorePages = `$false
        }
    })
    
    Write-Output 'About to print...'
    # Print the document
    `$printDocument.Print()
    `$image.Dispose()
    Write-Output 'Print job sent successfully to $printerName'
    
} catch {
    Write-Error 'Print failed: ' + `$_.Exception.Message
    exit 1
}
"@

Write-Host "Executing print script..."
Invoke-Expression $printScript

Write-Host "Test completed!"
