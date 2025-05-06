// script.js
document.addEventListener('DOMContentLoaded', function() {
    // Configuration
    const API_BASE_URL = window.location.origin; // Gets the current server URL
    const DEFAULT_PRINTER_KEY = 'dnp-default-printer';
    
    // Elements
    const printerSelect = document.getElementById('printer-select');
    const setDefaultPrinterBtn = document.getElementById('set-default-printer');
    const refreshStatusBtn = document.getElementById('refresh-status');
    const printForm = document.getElementById('print-form');
    const printButton = document.getElementById('print-button');
    const statusSpinner = document.getElementById('status-spinner');
    const statusText = document.getElementById('status-text');
    const printerDetails = document.getElementById('printer-details');
    const selectedPrinterName = document.getElementById('selected-printer-name');
    const mediaType = document.getElementById('media-type');
    const printsRemaining = document.getElementById('prints-remaining');
    const printerState = document.getElementById('printer-state');
    const printJobs = document.getElementById('print-jobs');
    
    // Store print jobs
    let jobs = [];

    // Initialize
    fetchPrinters();
    
    // Event listeners
    setDefaultPrinterBtn.addEventListener('click', setDefaultPrinter);
    refreshStatusBtn.addEventListener('click', refreshPrinterStatus);
    printForm.addEventListener('submit', handlePrintSubmit);

    // Fetch available printers
    async function fetchPrinters() {
        try {
            const response = await fetch(`${API_BASE_URL}/api/printers`);
            if (!response.ok) {
                throw new Error('Failed to fetch printers');
            }
            
            const data = await response.json();
            populatePrinterSelect(data.printers);
            
            // Load default printer if exists
            const defaultPrinter = localStorage.getItem(DEFAULT_PRINTER_KEY);
            if (defaultPrinter) {
                printerSelect.value = defaultPrinter;
                fetchPrinterInfo(defaultPrinter);
            } else if (data.printers && data.printers.length > 0) {
                // Use first printer as default if none is set
                const firstPrinter = data.printers[0].name;
                printerSelect.value = firstPrinter;
                fetchPrinterInfo(firstPrinter);
            }
        } catch (error) {
            console.error('Error fetching printers:', error);
            printerSelect.innerHTML = '<option value="">Error loading printers</option>';
            updateStatusDisplay('error', 'Failed to connect to print server');
        }
    }

    // Populate printer select dropdown
    function populatePrinterSelect(printers) {
        if (!printers || printers.length === 0) {
            printerSelect.innerHTML = '<option value="">No printers found</option>';
            return;
        }

        printerSelect.innerHTML = '';
        printers.forEach(printer => {
            const option = document.createElement('option');
            option.value = printer.name;
            option.textContent = printer.name;
            printerSelect.appendChild(option);
        });

        // Add event listener for printer change
        printerSelect.addEventListener('change', function() {
            const selectedPrinter = printerSelect.value;
            if (selectedPrinter) {
                fetchPrinterInfo(selectedPrinter);
            } else {
                updateStatusDisplay('inactive', 'No printer selected');
            }
        });
    }

    // Set default printer
    function setDefaultPrinter() {
        const selectedPrinter = printerSelect.value;
        if (selectedPrinter) {
            localStorage.setItem(DEFAULT_PRINTER_KEY, selectedPrinter);
            alert(`${selectedPrinter} has been set as the default printer.`);
        } else {
            alert('Please select a printer first.');
        }
    }

    // Fetch printer info
    async function fetchPrinterInfo(printerName) {
        try {
            updateStatusDisplay('loading', 'Checking printer status...');
            
            const response = await fetch(`${API_BASE_URL}/api/printers/${encodeURIComponent(printerName)}`);
            if (!response.ok) {
                throw new Error('Failed to fetch printer info');
            }
            
            const data = await response.json();
            updatePrinterDetails(data.printer);
            updateStatusDisplay('active', 'Printer connected and ready');
        } catch (error) {
            console.error('Error fetching printer info:', error);
            updateStatusDisplay('error', 'Failed to get printer status');
        }
    }

    // Update printer details display
    function updatePrinterDetails(printer) {
        if (!printer) {
            printerDetails.classList.add('d-none');
            return;
        }

        selectedPrinterName.textContent = printer.name || 'Unknown';
        
        // Try to extract media information from printer options
        if (printer.options) {
            // DNP printers often have marker information
            mediaType.textContent = printer.options['marker-names'] || 'Unknown';
            printsRemaining.textContent = printer.options['marker-message'] || 'Unknown';
            
            // Update printer state
            const isAccepting = printer.options['printer-is-accepting-jobs'] === 'true';
            printerState.textContent = isAccepting ? 'Ready' : 'Not accepting jobs';
            printerState.className = isAccepting ? 'text-success' : 'text-danger';
        } else {
            mediaType.textContent = 'Unknown';
            printsRemaining.textContent = 'Unknown';
            printerState.textContent = 'Unknown';
            printerState.className = '';
        }

        printerDetails.classList.remove('d-none');
    }

    // Update status display
    function updateStatusDisplay(status, message) {
        switch (status) {
            case 'loading':
                statusSpinner.classList.remove('d-none');
                statusText.textContent = message;
                statusText.className = 'text-primary';
                break;
            case 'active':
                statusSpinner.classList.add('d-none');
                statusText.textContent = message;
                statusText.className = 'text-success';
                break;
            case 'error':
                statusSpinner.classList.add('d-none');
                statusText.textContent = message;
                statusText.className = 'text-danger';
                break;
            case 'inactive':
                statusSpinner.classList.add('d-none');
                statusText.textContent = message;
                statusText.className = 'text-secondary';
                break;
        }
    }

    // Refresh printer status
    function refreshPrinterStatus() {
        const selectedPrinter = printerSelect.value;
        if (selectedPrinter) {
            fetchPrinterInfo(selectedPrinter);
        } else {
            alert('Please select a printer first.');
        }
    }

    // Handle print form submission
    async function handlePrintSubmit(event) {
        event.preventDefault();
        
        const fileInput = document.getElementById('file-upload');
        const printSize = document.getElementById('print-size').value;
        const printFinish = document.getElementById('print-finish').value;
        const copies = document.getElementById('copies').value;
        const printerName = printerSelect.value;

        if (!fileInput.files || fileInput.files.length === 0) {
            alert('Please select a file to print.');
            return;
        }

        if (!printerName) {
            alert('Please select a printer.');
            return;
        }

        const file = fileInput.files[0];
        const formData = new FormData();
        formData.append('file', file);
        formData.append('printerName', printerName);

        // Create options object
        const options = {
            copies: parseInt(copies, 10),
            finish: printFinish,
            size: printSize
        };
        formData.append('options', JSON.stringify(options));

        // Disable the button and show loading state
        printButton.disabled = true;
        printButton.innerHTML = '<span class="spinner-border spinner-border-sm me-2" role="status" aria-hidden="true"></span>Printing...';

        try {
            const response = await fetch(`${API_BASE_URL}/api/print`, {
                method: 'POST',
                body: formData
            });

            if (!response.ok) {
                throw new Error('Print request failed');
            }

            const data = await response.json();
            
            // Add job to the list
            addPrintJob({
                jobID: data.jobID || 'N/A',
                fileName: file.name,
                printer: printerName,
                status: 'Completed',
                timestamp: new Date().toLocaleTimeString()
            });

            alert('Print job submitted successfully!');
            
            // Reset the form
            printForm.reset();

        } catch (error) {
            console.error('Error submitting print job:', error);
            alert('Failed to submit print job. Please try again.');
        } finally {
            // Re-enable the button
            printButton.disabled = false;
            printButton.textContent = 'Print';
        }
    }

    // Add print job to the list
    function addPrintJob(job) {
        // Add to the jobs array
        jobs.unshift(job);
        
        // Keep only the last 10 jobs
        if (jobs.length > 10) {
            jobs = jobs.slice(0, 10);
        }
        
        // Update the table
        updateJobsTable();
    }

    // Update jobs table
    function updateJobsTable() {
        if (jobs.length === 0) {
            printJobs.innerHTML = '<tr><td colspan="5" class="text-center">No print jobs yet</td></tr>';
            return;
        }

        printJobs.innerHTML = '';
        jobs.forEach(job => {
            const row = document.createElement('tr');
            
            const jobIdCell = document.createElement('td');
            jobIdCell.textContent = job.jobID;
            
            const fileCell = document.createElement('td');
            fileCell.textContent = job.fileName;
            
            const printerCell = document.createElement('td');
            printerCell.textContent = job.printer;
            
            const statusCell = document.createElement('td');
            statusCell.textContent = job.status;
            
            const timeCell = document.createElement('td');
            timeCell.textContent = job.timestamp;
            
            row.appendChild(jobIdCell);
            row.appendChild(fileCell);
            row.appendChild(printerCell);
            row.appendChild(statusCell);
            row.appendChild(timeCell);
            
            printJobs.appendChild(row);
        });
    }

    // Refresh printer status every 30 seconds
    setInterval(() => {
        const selectedPrinter = printerSelect.value;
        if (selectedPrinter) {
            fetchPrinterInfo(selectedPrinter);
        }
    }, 30000);
});