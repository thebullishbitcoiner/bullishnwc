import { nwc } from "https://esm.sh/@getalby/sdk@3.9.0";
import { LightningAddress } from "https://esm.sh/@getalby/lightning-tools@6.1.0/lnurl";
import { Notyf } from "https://esm.sh/notyf@3";

const notyf = new Notyf({
    duration: 4000,
    position: { x: 'left', y: 'bottom' },
    types: [
        {
            type: 'success',
            background: '#222',
            className: 'notyf__toast--success',
        },
    ],
});

if ('serviceWorker' in navigator && !import.meta.env?.DEV) {
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

let connections = JSON.parse(localStorage.getItem('bullishnwc_connections')) || [];
let currentConnection = null;
/** @type {(() => void) | null} */
let notificationUnsubscribe = null;
/** @type {ReturnType<typeof setInterval> | null} */
let invoicePollingIntervalId = null;
/** @type {string | null} */
let lastToastPaymentHash = null;
/** Payment hash of the invoice currently shown (for dedupe with notifications). */
let currentInvoicePaymentHash = null;
/** Timestamp of last payment toast (avoids duplicate when notification arrives right after polling). */
let lastPaymentToastAt = 0;

document.addEventListener("DOMContentLoaded", () => {
    const el = document.getElementById('app-version');
    if (el && typeof __APP_VERSION__ !== 'undefined') el.textContent = __APP_VERSION__;

    const menuButton = document.getElementById('menu-button');
    const flyoutMenu = document.getElementById('flyout-menu');
    const addConnectionModal = document.getElementById('add-connection-modal');
    const openAddModalButton = document.getElementById('open-add-modal');
    const closeAddModalButton = document.getElementById('close-add-modal');
    const addConnectionButton = document.getElementById('add-connection');
    const deleteConnectionModal = document.getElementById('delete-connection-modal');
    const deleteConnectionMessage = document.getElementById('delete-connection-message');
    const closeDeleteModalButton = document.getElementById('close-delete-modal');
    const deleteConnectionCancelButton = document.getElementById('delete-connection-cancel');
    const deleteConnectionConfirmButton = document.getElementById('delete-connection-confirm');
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
    const closeInfoModalButton = document.getElementById('close-info-modal');

    // Load the current connection from localStorage
    const savedConnectionUrl = localStorage.getItem('bullishnwc_currentConnection');
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

    closeInfoModalButton.addEventListener('click', () => {
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

    /** Index of connection pending delete (set when confirmation modal opens). */
    let pendingDeleteConnectionIndex = null;

    function closeDeleteConnectionModal() {
        deleteConnectionModal.style.display = 'none';
        pendingDeleteConnectionIndex = null;
    }

    closeDeleteModalButton.addEventListener('click', closeDeleteConnectionModal);
    deleteConnectionCancelButton.addEventListener('click', closeDeleteConnectionModal);
    deleteConnectionConfirmButton.addEventListener('click', () => {
        if (pendingDeleteConnectionIndex === null) return;
        deleteConnection(pendingDeleteConnectionIndex);
        closeDeleteConnectionModal();
    });

    addConnectionButton.addEventListener('click', () => {
        const walletUrl = walletUrlInput.value.trim();
        const walletName = walletNameInput.value.trim();

        if (walletUrl && walletName && !connections.some(conn => conn.url === walletUrl)) {
            const newConnection = { name: walletName, url: walletUrl };
            connections.push(newConnection);
            localStorage.setItem('bullishnwc_connections', JSON.stringify(connections));
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
            localStorage.setItem('bullishnwc_connections', JSON.stringify(connections));
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
                    const conn = connections[index];
                    if (!conn) return;
                    deleteConnectionMessage.textContent = `Remove [${conn.name}]? This cannot be undone.`;
                    pendingDeleteConnectionIndex = index;
                    deleteConnectionModal.style.display = 'block';
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

    function resetToNoConnection() {
        currentConnection = null;
        localStorage.removeItem('bullishnwc_currentConnection');
        if (notificationUnsubscribe) {
            notificationUnsubscribe();
            notificationUnsubscribe = null;
        }
        stopInvoicePolling();
        walletInfo.classList.add('hidden');
        walletInfo.style.display = 'none';
        balanceDiv.textContent = '';
        transactionsDiv.innerHTML = '';
        const loadingEl = document.getElementById('loading');
        if (loadingEl) loadingEl.classList.remove('visible');
    }

    function deleteConnection(index) {
        const conn = connections[index];
        if (!conn) return;
        const wasCurrentConnection = localStorage.getItem('bullishnwc_currentConnection') === conn.url;
        connections.splice(index, 1);
        localStorage.setItem('bullishnwc_connections', JSON.stringify(connections));
        if (wasCurrentConnection) resetToNoConnection();
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

    function showPaymentToast(message, paymentHash) {
        if (paymentHash != null && paymentHash === lastToastPaymentHash) return;
        const now = Date.now();
        if (now - lastPaymentToastAt < 2500) return; /* Skip if we just showed a payment toast (notification vs polling race) */
        notyf.success(message);
        lastPaymentToastAt = now;
        if (paymentHash != null) lastToastPaymentHash = paymentHash;
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
            document.getElementById('wallet-name-display').textContent = walletName;

            await loadBalance(currentConnection);
            await loadTransactions(currentConnection);

            // Show the wallet after loading is complete
            walletInfo.classList.remove('hidden');
            walletInfo.style.display = 'flex';

            // Save the current connection URL to localStorage
            localStorage.setItem('bullishnwc_currentConnection', url);

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
                        if (invoiceTextarea && invoiceTextarea.value) invoiceTextarea.value += ' ✓ Paid';
                        const waitingEl = document.getElementById('invoice-waiting');
                        if (waitingEl) waitingEl.classList.add('hidden');
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

    const sendModal = document.getElementById('send-modal');
    const closeSendModalButton = document.getElementById('close-send-modal');
    const sendInvoiceTextarea = document.getElementById('send-invoice');
    const sendAmountInput = document.getElementById('send-amount');
    const sendMessageEl = document.getElementById('send-message');
    const sendPayButton = document.getElementById('send-pay-button');

    function openSendModal() {
        sendInvoiceTextarea.value = '';
        if (sendAmountInput) sendAmountInput.value = '';
        sendMessageEl.textContent = '';
        sendMessageEl.className = 'send-message hidden';
        sendModal.style.display = 'block';
        sendInvoiceTextarea.focus();
    }

    function closeSendModal() {
        sendModal.style.display = 'none';
    }

    async function payFromSendModal() {
        const value = sendInvoiceTextarea.value.trim();
        if (!value) {
            sendMessageEl.textContent = 'Please paste a lightning invoice or lightning address.';
            sendMessageEl.className = 'send-message error';
            sendMessageEl.classList.remove('hidden');
            return;
        }
        sendMessageEl.textContent = '';
        sendMessageEl.classList.remove('hidden');
        sendPayButton.disabled = true;
        try {
            let invoiceToPay;
            if (/^ln/i.test(value)) {
                invoiceToPay = value;
            } else if (value.includes('@')) {
                const amountRaw = sendAmountInput ? sendAmountInput.value.trim() : '';
                const amount = amountRaw ? parseInt(amountRaw, 10) : NaN;
                if (!amountRaw || !Number.isInteger(amount) || amount < 1) {
                    sendMessageEl.textContent = 'Amount (sats) is required for lightning address.';
                    sendMessageEl.className = 'send-message error';
                    sendPayButton.disabled = false;
                    return;
                }
                const ln = new LightningAddress(value);
                await ln.fetch();
                const inv = await ln.requestInvoice({ satoshi: amount });
                invoiceToPay = inv.paymentRequest;
            } else {
                sendMessageEl.textContent = 'Enter a lightning invoice (starts with ln...) or lightning address (e.g. user@domain.com).';
                sendMessageEl.className = 'send-message error';
                sendPayButton.disabled = false;
                return;
            }
            await currentConnection.payInvoice({ invoice: invoiceToPay });
            sendMessageEl.textContent = 'Payment sent.';
            sendMessageEl.className = 'send-message success';
            await loadBalance(currentConnection);
            await loadTransactions(currentConnection);
            setTimeout(closeSendModal, 1200);
        } catch (error) {
            sendMessageEl.textContent = error.message || 'Payment failed.';
            sendMessageEl.className = 'send-message error';
        } finally {
            sendPayButton.disabled = false;
        }
    }

    document.getElementById('send-button').addEventListener('click', openSendModal);
    closeSendModalButton.addEventListener('click', closeSendModal);
    document.getElementById('send-paste-button').addEventListener('click', async () => {
        try {
            const text = await navigator.clipboard.readText();
            if (text) sendInvoiceTextarea.value = text.trim();
        } catch (_) {
            sendMessageEl.textContent = 'Could not read clipboard.';
            sendMessageEl.className = 'send-message error';
            sendMessageEl.classList.remove('hidden');
        }
    });
    sendPayButton.addEventListener('click', payFromSendModal);
    sendInvoiceTextarea.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            payFromSendModal();
        }
    });

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
            lastToastPaymentHash = null;
            stopInvoicePolling();
            const response = await currentConnection.makeInvoice({
                amount: amount * 1000, // convert to millisats
                ...(description && { description }),
            });
            const invoice = response.invoice;
            const paymentHash = response.payment_hash;
            const amountSats = Math.floor(response.amount / 1000);
            currentInvoicePaymentHash = paymentHash;

            closeReceiveModal();

            const invoiceModalEl = document.getElementById('invoice-modal');
            const invoiceTextarea = document.getElementById('invoice-textarea');
            invoiceTextarea.value = invoice;
            const qrEl = document.getElementById('invoice-qr');
            if (qrEl && 'lightning' in qrEl) qrEl.lightning = invoice;
            invoiceModalEl.style.display = 'block';
            const invoiceWaitingEl = document.getElementById('invoice-waiting');
            if (invoiceWaitingEl) invoiceWaitingEl.classList.remove('hidden');

            const connection = currentConnection;
            const invoiceModalElRef = document.getElementById('invoice-modal');
            const invoiceTextareaRef = document.getElementById('invoice-textarea');

            function markInvoicePaid() {
                stopInvoicePolling();
                const waitingEl = document.getElementById('invoice-waiting');
                if (waitingEl) waitingEl.classList.add('hidden');
                loadBalance(connection).catch(() => {});
                loadTransactions(connection).catch(() => {});
                showPaymentToast(`Payment received: ${amountSats} sats`, paymentHash);
                if (invoiceTextareaRef) invoiceTextareaRef.value = invoice + ' ✓ Paid';
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

    document.getElementById('copy-invoice-icon').addEventListener('click', async () => {
        const el = document.getElementById('invoice-textarea');
        if (!el?.value) return;
        try {
            await navigator.clipboard.writeText(el.value);
            notyf.success('Copied!');
        } catch (_) {
            notyf.error('Could not copy');
        }
    });

    // Close modal functionality
    document.getElementById('close-invoice-modal').addEventListener('click', () => {
        stopInvoicePolling();
        currentInvoicePaymentHash = null;
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
                const currentConnectionURL = localStorage.getItem('bullishnwc_currentConnection');
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


    // Initialize the connection list on page load
    updateConnectionList();
});