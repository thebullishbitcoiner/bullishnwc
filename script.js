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
/** @type {(() => void) | null} */
let notificationUnsubscribe = null;
/** @type {ReturnType<typeof setInterval> | null} */
let invoicePollingIntervalId = null;

document.addEventListener("DOMContentLoaded", () => {
    fetch('manifest.json')
        .then((res) => res.ok ? res.json() : Promise.reject(res))
        .then((manifest) => {
            const el = document.getElementById('app-version');
            if (el && manifest.version) el.textContent = manifest.version;
        })
        .catch(() => {});

    const menuButton = document.getElementById('menu-button');
    const flyoutMenu = document.getElementById('flyout-menu');
    const addConnectionModal = document.getElementById('add-connection-modal');
    const openAddModalButton = document.getElementById('open-add-modal');
    const closeAddModalButton = document.getElementById('close-add-modal');
    const addConnectionButton = document.getElementById('add-connection');
    const createTestWalletButton = document.getElementById('create-test-wallet');
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

    openAddModalButton.addEventListener('click', () => {
        walletNameInput.value = '';
        walletUrlInput.value = '';
        addConnectionModal.style.display = 'block';
    });

    closeAddModalButton.addEventListener('click', () => {
        addConnectionModal.style.display = 'none';
    });

    addConnectionButton.addEventListener('click', () => {
        const walletUrl = walletUrlInput.value.trim();
        const walletName = walletNameInput.value.trim();

        if (walletUrl && walletName && !connections.some(conn => conn.url === walletUrl)) {
            const newConnection = { name: walletName, url: walletUrl };
            connections.push(newConnection);
            localStorage.setItem('nwc_connections', JSON.stringify(connections));
            updateConnectionList();
            walletUrlInput.value = '';
            walletNameInput.value = '';
            addConnectionModal.style.display = 'none';
        } else {
            alert('Please enter both wallet name and URL, and ensure the URL is unique.');
        }
    });

    createTestWalletButton.addEventListener('click', async () => {
        const btn = createTestWalletButton;
        btn.disabled = true;
        btn.textContent = 'Creating…';
        try {
            const res = await fetch('https://faucet.nwc.dev?balance=10000', { method: 'POST' });
            if (!res.ok) throw new Error(`Faucet returned ${res.status}`);
            const url = (await res.text()).trim();
            if (!url) throw new Error('No connection URL returned');
            let name = 'Test Wallet';
            let n = 1;
            while (connections.some(conn => conn.name === name)) {
                n += 1;
                name = `Test Wallet ${n}`;
            }
            connections.push({ name, url });
            localStorage.setItem('nwc_connections', JSON.stringify(connections));
            updateConnectionList();
            flyoutMenu.classList.remove('visible');
            await loadWallet(url);
        } catch (err) {
            console.error('Error creating test wallet:', err);
            alert(`Could not create test wallet: ${err.message}`);
        } finally {
            btn.disabled = false;
            btn.textContent = 'Create Test Wallet';
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
        if (interval > 1) return interval + " days ago";
        if (interval === 1) return "1 day ago";
    
        interval = Math.floor(seconds / 3600);
        if (interval > 1) return interval + " hours ago";
        if (interval === 1) return "1 hour ago";
    
        interval = Math.floor(seconds / 60);
        if (interval > 1) return interval + " minutes ago";
        if (interval === 1) return "1 minute ago";
    
        return seconds < 30 ? "just now" : seconds + " seconds ago";
    }

    function showPaymentToast(message) {
        const toast = document.getElementById('payment-toast');
        if (!toast) return;
        toast.textContent = message;
        toast.classList.remove('hidden');
        toast.classList.add('visible');
        const hide = () => {
            toast.classList.remove('visible');
            toast.classList.add('hidden');
        };
        const existing = toast.dataset.toastTimeoutId;
        if (existing) clearTimeout(Number(existing));
        const id = setTimeout(hide, 4000);
        toast.dataset.toastTimeoutId = String(id);
    }

    async function loadWallet(url) {
        if (notificationUnsubscribe) {
            notificationUnsubscribe();
            notificationUnsubscribe = null;
        }

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

            const connection = currentConnection;
            const onNotification = (notification) => {
                if (notification.notification_type === "payment_received" || notification.notification_type === "payment_sent") {
                    stopInvoicePolling();
                    loadBalance(connection);
                    loadTransactions(connection);
                    if (notification.notification_type === "payment_received") {
                        const sats = Math.floor(notification.notification.amount / 1000);
                        showPaymentToast(`Payment received: ${sats} sats`);
                        const invoiceTextarea = document.getElementById('invoice-textarea');
                        if (invoiceTextarea && invoiceTextarea.value) invoiceTextarea.value += '\n\n✓ Paid';
                        setTimeout(() => {
                            const modal = document.getElementById('invoice-modal');
                            if (modal) modal.style.display = 'none';
                        }, 1500);
                    }
                }
            };
            try {
                notificationUnsubscribe = await connection.subscribeNotifications(onNotification, ["payment_received", "payment_sent"]);
            } catch (err) {
                console.error("Error subscribing to notifications:", err);
            }
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

    function stopInvoicePolling() {
        if (invoicePollingIntervalId !== null) {
            clearInterval(invoicePollingIntervalId);
            invoicePollingIntervalId = null;
        }
    }

    const receiveModal = document.getElementById('receive-modal');
    const receiveAmountInput = document.getElementById('receive-amount');
    const receiveDescriptionInput = document.getElementById('receive-description');
    const closeReceiveModalButton = document.getElementById('close-receive-modal');
    const receiveCreateInvoiceButton = document.getElementById('receive-create-invoice');

    function openReceiveModal() {
        receiveAmountInput.value = '';
        receiveDescriptionInput.value = '';
        receiveModal.style.display = 'block';
        receiveAmountInput.focus();
    }

    function closeReceiveModal() {
        receiveModal.style.display = 'none';
    }

    async function createInvoiceFromReceiveModal() {
        const amountRaw = receiveAmountInput.value.trim();
        const amount = amountRaw ? parseInt(amountRaw, 10) : NaN;
        const description = receiveDescriptionInput.value.trim() || undefined;

        if (!amountRaw || !Number.isInteger(amount) || amount < 1) {
            alert('Please enter a valid amount (whole sats, at least 1).');
            return;
        }

        try {
            stopInvoicePolling();
            const response = await currentConnection.makeInvoice({
                amount: amount * 1000, // convert to millisats
                ...(description && { description }),
            });
            const invoice = response.invoice;
            const paymentHash = response.payment_hash;
            const amountSats = Math.floor(response.amount / 1000);

            closeReceiveModal();

            const invoiceModalEl = document.getElementById('invoice-modal');
            const invoiceTextarea = document.getElementById('invoice-textarea');
            invoiceTextarea.value = invoice;
            const qrEl = document.getElementById('invoice-qr');
            if (qrEl && 'lightning' in qrEl) qrEl.lightning = invoice;
            invoiceModalEl.style.display = 'block';

            const connection = currentConnection;
            const invoiceModalElRef = document.getElementById('invoice-modal');
            const invoiceTextareaRef = document.getElementById('invoice-textarea');

            function markInvoicePaid() {
                stopInvoicePolling();
                loadBalance(connection).catch(() => {});
                loadTransactions(connection).catch(() => {});
                showPaymentToast(`Payment received: ${amountSats} sats`);
                if (invoiceTextareaRef) invoiceTextareaRef.value = invoice + '\n\n✓ Paid';
                // Close the invoice modal after a short delay so the toast is visible
                setTimeout(() => {
                    const modal = document.getElementById('invoice-modal');
                    if (modal) modal.style.display = 'none';
                }, 1500);
            }

            invoicePollingIntervalId = setInterval(async () => {
                if (!connection || !paymentHash) return;
                try {
                    const lookup = await connection.lookupInvoice({ payment_hash: paymentHash });
                    const isSettled = lookup && (
                        lookup.state === 'settled' ||
                        String(lookup.state).toLowerCase() === 'settled' ||
                        (typeof lookup.settled_at === 'number' && lookup.settled_at > 0)
                    );
                    if (isSettled) {
                        markInvoicePaid();
                        return;
                    }
                } catch (_) {
                    // Fallback: check listTransactions for an incoming payment with this payment_hash
                }
                try {
                    const list = await connection.listTransactions({ limit: 10 });
                    const tx = list.transactions && list.transactions.find(
                        (t) => t.type === 'incoming' && t.payment_hash === paymentHash
                    );
                    if (tx) {
                        markInvoicePaid();
                    }
                } catch (_) {
                    // ignore
                }
            }, 2000);
        } catch (error) {
            console.error("Error creating invoice:", error);
            alert(`Error: ${error.message}`);
        }
    }

    document.getElementById('receive-button').addEventListener('click', openReceiveModal);
    closeReceiveModalButton.addEventListener('click', closeReceiveModal);
    receiveCreateInvoiceButton.addEventListener('click', createInvoiceFromReceiveModal);
    receiveAmountInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') createInvoiceFromReceiveModal();
    });
    receiveDescriptionInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') createInvoiceFromReceiveModal();
    });

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
        stopInvoicePolling();
        document.getElementById('invoice-modal').style.display = 'none';
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

    // Initialize the connection list on page load
    updateConnectionList();
});