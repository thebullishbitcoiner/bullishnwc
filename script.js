import { nwc } from "https://esm.sh/@getalby/sdk@3.9.0";

if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('service-worker.js')
            .then((registration) => {
                console.log('Service Worker registered with scope:', registration.scope);
            })
            .catch((error) => {
                console.error('Service Worker registration failed:', error);
            });
    });
}

let connections = JSON.parse(localStorage.getItem('nwc_connections')) || [];
let currentConnection = null;

document.addEventListener("DOMContentLoaded", () => {
    const menuButton = document.getElementById('menu-button');
    const flyoutMenu = document.getElementById('flyout-menu');
    const addConnectionButton = document.getElementById('add-connection');
    const walletUrlInput = document.getElementById('wallet-url');
    const walletNameInput = document.getElementById('wallet-name');
    const connectionList = document.getElementById('connection-list');
    const walletInfo = document.getElementById('wallet-info');
    const balanceDiv = document.getElementById('balance');
    const transactionsDiv = document.getElementById('transactions');
    const defaultMessageDiv = document.getElementById('default-message');

    // For the info modal
    const infoButton = document.getElementById('info-button');
    const infoModal = document.getElementById('info-modal');
    const closeButton = document.querySelector('.close-button');

    // Load the current connection from localStorage
    const savedConnectionUrl = localStorage.getItem('current_connection_url');
    if (savedConnectionUrl) {
        const savedConnection = connections.find(conn => conn.url === savedConnectionUrl);
        if (savedConnection) {
            loadWallet(savedConnection.url); // Load the saved connection
        }
    }

    infoButton.addEventListener('click', async () => {
        try {
            infoModal.style.display = 'block';

            const response = await currentConnection.getInfo();

            // Get the methods list element
            const methodsList = document.getElementById('methods-list');
            methodsList.innerHTML = ''; // Clear any existing items

            // Loop through the response.methods array and create list items
            if (Array.isArray(response.methods) && response.methods.length > 0) {
                response.methods.forEach(method => {
                    const listItem = document.createElement('li');
                    listItem.textContent = method; // Set the text content to the method name
                    methodsList.appendChild(listItem); // Append the list item to the unordered list
                });
            } else {
                const listItem = document.createElement('li');
                listItem.textContent = 'No methods available.';
                methodsList.appendChild(listItem);
            }

            const walletServiceInfo = await currentConnection.getWalletServiceInfo();
            const budgetInfo = await currentConnection.getBudget();
        } catch (error) {
            console.error("Error fetching connection info:", error);
            document.getElementById('connection-info').textContent = "Error fetching connection info.";

            // Clear methods list in case of error
            const methodsList = document.getElementById('methods-list');
            methodsList.innerHTML = ''; // Clear any existing items
            const listItem = document.createElement('li');
            listItem.textContent = 'Error fetching methods.';
            methodsList.appendChild(listItem);

            infoModal.style.display = 'block';
        }
    });

    // Close the modal when the close button is clicked
    closeButton.addEventListener('click', () => {
        infoModal.style.display = 'none';
    });

    menuButton.addEventListener('click', () => {
        flyoutMenu.classList.toggle('visible'); // Toggle the visible class
    });

    addConnectionButton.addEventListener('click', () => {
        const walletUrl = walletUrlInput.value;
        const walletName = walletNameInput.value;

        if (walletUrl && walletName && !connections.some(conn => conn.url === walletUrl)) {
            const newConnection = { name: walletName, url: walletUrl };
            connections.push(newConnection);
            localStorage.setItem('nwc_connections', JSON.stringify(connections)); // Store in local storage
            updateConnectionList();
            walletUrlInput.value = '';
            walletNameInput.value = '';
        } else {
            alert('Please enter both wallet name and URL, and ensure the URL is unique.');
        }
    });

    function updateConnectionList() {
        connectionList.innerHTML = '';
        if (connections.length === 0) {
            defaultMessageDiv.style.display = 'block'; // Show default message
        } else {
            defaultMessageDiv.style.display = 'none'; // Hide default message
            connections.forEach(({ name, url }, index) => {
                const li = document.createElement('li');
                li.style.display = 'flex'; // Use flexbox for alignment
                li.style.justifyContent = 'space-between'; // Space between name and button
                li.style.alignItems = 'center'; // Center items vertically

                // Create a span for the wallet name
                const nameSpan = document.createElement('span');
                nameSpan.textContent = name;

                // Create a delete button
                const deleteButton = document.createElement('button');
                deleteButton.innerHTML = '<i class="fas fa-times"></i>'; // Font Awesome "x" icon
                deleteButton.className = 'delete-button'; // Add a class for styling
                deleteButton.addEventListener('click', (event) => {
                    event.stopPropagation(); // Prevent the click from triggering the li event
                    deleteConnection(index);
                });

                li.appendChild(nameSpan); // Append the wallet name to the list item
                li.appendChild(deleteButton); // Append the delete button to the list item
                li.addEventListener('click', () => {
                    loadWallet(url);
                    flyoutMenu.classList.remove('visible'); // Close the flyout menu
                });
                connectionList.appendChild(li);
            });
        }
    }

    function deleteConnection(index) {
        // Remove the connection from the array
        connections.splice(index, 1);
        // Update local storage
        localStorage.setItem('nwc_connections', JSON.stringify(connections));
        // Update the connection list display
        updateConnectionList();
    }

    function timeAgo(timestamp) {
        // Calculate the difference in seconds
        const seconds = Math.floor(Date.now() / 1000) - timestamp;

        let interval = Math.floor(seconds / 31536000);
        if (interval > 1) return interval + " years ago";
        interval = Math.floor(seconds / 2592000);
        if (interval > 1) return interval + " months ago";
        interval = Math.floor(seconds / 86400);

        // Check for the specific case of 1 day ago
        if (interval === 1 && seconds >= 86400 && seconds < 172800) {
            return "1 day ago";
        }

        if (interval > 1) return interval + " days ago";
        interval = Math.floor(seconds / 3600);
        if (interval > 1) return interval + " hours ago";
        interval = Math.floor(seconds / 60);
        if (interval > 1) return interval + " minutes ago";
        return seconds < 30 ? "just now" : seconds + " seconds ago";
    }

    async function loadWallet(url) {
        currentConnection = new nwc.NWCClient({
            nostrWalletConnectUrl: url,
        });

        // Show loading animation
        const loadingDiv = document.getElementById('loading');
        loadingDiv.classList.add('visible');
        walletInfo.style.display = 'none';

        try {
            // Set the wallet name display
            const walletName = connections.find(conn => conn.url === url).name; // Get the wallet name from connections
            document.getElementById('wallet-name-display').textContent = `[${walletName}]`;

            await loadBalance(currentConnection);
            await loadTransactions(currentConnection);

            // Show the wallet after loading is complete
            walletInfo.classList.remove('hidden');
            walletInfo.style.display = 'flex';

            // Save the current connection URL to localStorage
            localStorage.setItem('current_connection_url', url);
        } catch (error) {
            console.error("Error loading wallet:", error);
            transactionsDiv.innerHTML = "Error loading transactions.";
        } finally {
            // Hide loading animation
            loadingDiv.classList.remove('visible');
        }
    } // End loadWallet()

    async function loadBalance(currentConnection) {
        try {
            // Fetch the balance
            const balanceResponse = await currentConnection.getBalance();
            const balance = Math.floor(balanceResponse.balance / 1000); // Convert from millisats to whole sats
            balanceDiv.textContent = `${balance} sats`; // Display balance as a whole number
        } catch (error) {
            console.error("Error loading balance:", error);
            balanceDiv.textContent = "Error loading balance.";
        }
    } // End loadBalance()

    async function loadTransactions(currentConnection) {
        const ONE_WEEK_IN_SECONDS = 60 * 60 * 24 * 7;

        try {
            // Fetch the transactions
            const transactionsResponse = await currentConnection.listTransactions({
                from: Math.floor(new Date().getTime() / 1000 - ONE_WEEK_IN_SECONDS),
                until: Math.ceil(new Date().getTime() / 1000),
                limit: 30,
            });

            // Clear previous transactions
            transactionsDiv.innerHTML = '';

            // Assuming transactions are in a property called 'transactions'
            const transactions = transactionsResponse.transactions;

            // Check if transactions is an array
            if (!Array.isArray(transactions)) {
                console.error("Expected transactions to be an array, but got:", transactions);
                transactionsDiv.innerHTML = "No transactions found.";
                return; // Exit the function if transactions is not an array
            }

            transactions.forEach(tx => {
                // Create a div for each transaction
                const transactionDiv = document.createElement('div');

                // Determine the arrow based on the transaction type
                const arrow = tx.type === 'outgoing' ? '<i class="fas fa-arrow-up"></i>' : '<i class="fas fa-arrow-down"></i>';

                // Format the transaction details
                const timeString = timeAgo(tx.created_at); // Get the human-readable time string

                transactionDiv.innerHTML = `
                    <strong></strong> ${arrow} ${tx.amount / 1000} sats 
                    <span style="float: right;">${timeString}</span>
                    <br>
                    <hr style="background-color: #333; height: 2px; border: none;">
                `;
                // Append the transaction div to the transactionsDiv
                transactionsDiv.appendChild(transactionDiv);
            });
        } catch (error) {
            console.error("Error loading transactions:", error);
            transactionsDiv.innerHTML = "Error loading transactions.";
        }
    } // End loadTransactions()

    async function sendFunds() {
        const invoice = prompt("Enter lightning invoice:");

        if (invoice) {
            try {
                const response = await currentConnection.payInvoice({ invoice });
                alert(`Transaction successful: ${response.preimage}`);
                loadBalance();
                loadTransactions();
            } catch (error) {
                alert(`Error sending funds: ${error.message}`);
            }
        }
    }

    async function receiveFunds() {
        const amount = prompt("Enter amount of sats:");

        if (amount) {
            try {
                const response = await currentConnection.makeInvoice({
                    amount: amount * 1000, // convert to millisats
                });
                const invoice = response.invoice;

                // Show the modal with the invoice
                const invoiceTextarea = document.getElementById('invoice-textarea');
                invoiceTextarea.value = invoice; // Set the invoice in the textarea
                document.getElementById('invoice-modal').style.display = 'block'; // Show the modal
            } catch (error) {
                console.error("Error in receiveFunds:", error);
                alert(`Error: ${error.message}`);
            }
        }
    }

    // Copy button functionality
    document.getElementById('copy-invoice-button').addEventListener('click', async () => {
        const invoiceTextarea = document.getElementById('invoice-textarea');
        await navigator.clipboard.writeText(invoiceTextarea.value); // Copy the invoice text

        const copyButton = document.getElementById('copy-invoice-button');
        const originalButtonText = copyButton.textContent; // Store the original button text
        copyButton.textContent = 'Copied!'; // Change button text to "Copied!"

        setTimeout(() => {
            copyButton.textContent = originalButtonText; // Revert back to original text after 1 second
        }, 1000);
    });

    // Close modal functionality
    document.getElementById('close-invoice-modal').addEventListener('click', () => {
        document.getElementById('invoice-modal').style.display = 'none'; // Hide the modal
    });

    document.addEventListener('visibilitychange', async function () {
        if (document.visibilityState === 'visible') {
            const options = {
                hour: 'numeric',
                minute: 'numeric',
                second: 'numeric',
                hour12: true // Use 12-hour format with AM/PM
            };
            const timestamp = new Date().toLocaleString(undefined, options); // Get the current time in local timezone
            console.log(`[${timestamp}] window became visible`);

            if (!currentConnection) {
                const currentConnectionURL = localStorage.getItem('current_connection_url');
                if (currentConnectionURL) {
                    try {
                        currentConnection = new nwc.NWCClient({
                            nostrWalletConnectUrl: currentConnectionURL,
                        });
                        await loadBalance(currentConnection);
                        await loadTransactions(currentConnection);
                    } catch (error) {
                        console.error("Error initializing NWCClient or loading data:", error);
                    }
                } else {
                    console.error("No current connection URL found in localStorage.");
                }
            } else {
                try {
                    await loadBalance(currentConnection);
                    await loadTransactions(currentConnection);
                } catch (error) {
                    console.error("Error loading balance or transactions:", error);
                }
            }
        }
    });

    document.getElementById('send-button').addEventListener('click', sendFunds);
    document.getElementById('receive-button').addEventListener('click', receiveFunds);

    // Initialize the connection list on page load
    updateConnectionList();
});