// script.js
document.addEventListener('DOMContentLoaded', function() {
    // Configuration
    const API_BASE_URL = window.location.origin; // Gets the current server URL
    const API_KEY_STORAGE_KEY = 'printnode-api-key';
    const DEFAULT_PRINTER_KEY = 'printnode-default-printer';
    
    // Elements
    const apiKeyInput = document.getElementById('api-key');
    const toggleApiKeyBtn = document.getElementById('toggle-api-key');
    const saveApiKeyBtn = document.getElementById('save-api-key');
    const testConnectionBtn = document.getElementById('test-connection');
    const computerSelect = document.getElementById('computer-select');
    const printerSelect = document.getElementById('printer-select');
    const setDefaultPrinterBtn = document.getElementById('set-default-printer');
    const refreshStatusBtn = document.getElementById('refresh-status');
    const printForm = document.getElementById('print-form');
    const printButton = document.getElementById('print-button');
    const statusSpinner = document.getElementById('status-spinner');
    const statusText = document.getElementById('status-text');
    const setupAlert = document.getElementById('setup-alert');
    const dismissSetupBtn = document.getElementById('dismiss-setup');
    const printerDetails = document.getElementById('printer-details');
    const selectedPrinterName = document.getElementById('selected-printer-name');
    const printerState = document.getElementById('printer-state');
    const printerDescription = document.getElementById('printer-description');
    const printerCapabilities = document.getElementById('printer-capabilities');
    const printJobs = document.getElementById('print-jobs');
    
    // Store print jobs
    let jobs = [];
    let savedApiKey = localStorage.getItem(API_KEY_STORAGE_KEY);
    
    // Initialize
    if (savedApiKey) {
        apiKeyInput.value = savedApiKey;
        testConnection();
    } else {
        updateStatusDisplay('inactive', 'No API key set');
    }
    
    // Event listeners
    toggleApiKeyBtn.addEventListener('click', toggleApiKeyVisibility);
    saveApiKeyBtn.addEventListener('click', saveApiKey);
    testConnectionBtn.addEventListener('click', testConnection);
    setDefaultPrinterBtn.addEventListener('click', setDefaultPrinter);
    refreshStatusBtn.addEventListener('click', refreshStatus);
    printForm.addEventListener('submit', handlePrintSubmit);
    dismissSetupBtn.addEventListener('click', () => {
        setupAlert.classList.add('d-none');
    });
    
    printerSelect.addEventListener('change', function() {
        const selectedPrinterId = printerSelect.value;
        if (selectedPrinterId) {
            fetchPrinterInfo(selectedPrinterId);
        } else {
            printerDetails.classList.add('d-none');
        }
    });


    // Test connection to PrintNode
    async function testConnection() {
        updateStatusDisplay('loading', 'Testing connection...');
        
        try {
            const computers = await fetchComputers();
            if (computers && computers.length > 0) {
                updateStatusDisplay('active', 'Connected to PrintNode');
                populateComputerSelect(computers);
                fetchPrinters();
            } else {
                updateStatusDisplay('warning', 'Connected, but no computers found');
            }
        } catch (error) {
            console.error('Connection test error:', error);
            updateStatusDisplay('error', 'Failed to connect to PrintNode');
        }
    }

    // Fetch printers from API
    async function fetchPrinters() {
        try {
            updateStatusDisplay('loading', 'Fetching printers...');
            
            const response = await fetch(`${API_BASE_URL}/api/printers`);
            if (!response.ok) {
                throw new Error('Failed to fetch printers');
            }
            
            const data = await response.json();
            populatePrinterSelect(data.printers);
            updateStatusDisplay('active', 'Printers loaded successfully');
        } catch (error) {
            console.error('Error fetching printers:', error);
            updateStatusDisplay('error', 'Failed to load printers');
        }
    }

    // Populate printer select dropdown
    function populatePrinterSelect(printers) {
        printerSelect.innerHTML = '';
        
        if (!printers || printers.length === 0) {
            const option = document.createElement('option');
            option.value = '';
            option.textContent = 'No printers found';
            printerSelect.appendChild(option);
            return;
        }

        const defaultPrinter = localStorage.getItem(DEFAULT_PRINTER_KEY);

        printers.forEach(printer => {
            const option = document.createElement('option');
            option.value = printer.id;
            option.textContent = printer.name;
            
            // Set as selected if it's the default printer
            if (defaultPrinter && printer.id.toString() === defaultPrinter) {
                option.selected = true;
            }
            
            printerSelect.appendChild(option);
        });
        
        // Trigger change event to load printer details
        if (printerSelect.value) {
            fetchPrinterInfo(printerSelect.value);
        }
    }

    // Fetch printer info
    async function fetchPrinterInfo(printerId) {
        try {
            const response = await fetch(`${API_BASE_URL}/api/printers/${printerId}`);
            if (!response.ok) {
                throw new Error('Failed to fetch printer info');
            }
            
            const data = await response.json();
            updatePrinterDetails(data.printer);
        } catch (error) {
            console.error('Error fetching printer info:', error);
            printerDetails.classList.add('d-none');
        }
    }

    // Update printer details display
    function updatePrinterDetails(printer) {
        if (!printer) {
            printerDetails.classList.add('d-none');
            return;
        }

        selectedPrinterName.textContent = printer.name || 'Unknown';
        printerState.textContent = printer.state || 'Unknown';
        printerDescription.textContent = printer.description || 'None';
        
        // Format capabilities
        const capabilities = [];
        if (printer.capabilities) {
            if (printer.capabilities.color) capabilities.push('Color');
            if (printer.capabilities.duplex) capabilities.push('Duplex');
            if (printer.capabilities.copies) capabilities.push('Multiple Copies');
            
            // Add paper sizes if available
            if (printer.capabilities.papers && printer.capabilities.papers.length > 0) {
                const paperSizes = printer.capabilities.papers.map(p => p.name).join(', ');
                capabilities.push(`Paper sizes: ${paperSizes}`);
            }
        }
        
        printerCapabilities.textContent = capabilities.length > 0 ? capabilities.join(', ') : 'Unknown';
        printerDetails.classList.remove('d-none');
    }


    // Refresh status
    function refreshStatus() {
        testConnection();
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
            case 'warning':
                statusSpinner.classList.add('d-none');
                statusText.textContent = message;
                statusText.className = 'text-warning';
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

    // Handle print form submission
    async function handlePrintSubmit(event) {
        event.preventDefault();
        
        const fileInput = document.getElementById('file-upload');
        const jobTitle = document.getElementById('job-title').value;
        const copies = document.getElementById('copies').value;
        const printerId = printerSelect.value;

        if (!fileInput.files || fileInput.files.length === 0) {
            alert('Please select a file to print.');
            return;
        }

        if (!printerId) {
            alert('Please select a printer.');
            return;
        }

        const formData = new FormData();
        formData.append('file', fileInput.files[0]);
        formData.append('printerId', printerId);
        formData.append('title', jobTitle);
        formData.append('copies', copies);

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
                jobId: data.jobId,
                title: jobTitle,
                printer: selectedPrinterName.textContent,
                status: 'Submitted',
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
            jobIdCell.textContent = job.jobId;
            
            const titleCell = document.createElement('td');
            titleCell.textContent = job.title;
            
            const printerCell = document.createElement('td');
            printerCell.textContent = job.printer;
            
            const statusCell = document.createElement('td');
            statusCell.textContent = job.status;
            
            const timeCell = document.createElement('td');
            timeCell.textContent = job.timestamp;
            
            row.appendChild(jobIdCell);
            row.appendChild(titleCell);
            row.appendChild(printerCell);
            row.appendChild(statusCell);
            row.appendChild(timeCell);
            
            printJobs.appendChild(row);
        });
    }

    function initializeApp() {
        const savedApiKey = localStorage.getItem(API_KEY_STORAGE_KEY);
        if (savedApiKey) {
            apiKeyInput.value = savedApiKey;
            testConnection();
        } else {
            updateStatusDisplay('inactive', 'Please enter your PrintNode API key');
        }
    }

    initializeApp();
});