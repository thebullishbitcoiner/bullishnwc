import { nwc } from "https://esm.sh/@getalby/sdk@3.9.0";
import { LightningAddress } from "https://esm.sh/@getalby/lightning-tools@6.1.0/lnurl";
import { Notyf } from "https://esm.sh/notyf@3";
import { BrantaServerBaseUrl } from "https://esm.sh/@branta-ops/branta@3.1.4";
import { BrantaService } from "https://esm.sh/@branta-ops/branta@3.1.4/v2";
import QrScanner from "https://esm.sh/qr-scanner@1.4.2";
import { decode as decodeBolt11 } from "https://esm.sh/light-bolt11-decoder@3.2.0";

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
/** Last loaded transactions (for detail modal). */
let lastTransactions = [];

const brantaService = new BrantaService({
    baseUrl: BrantaServerBaseUrl.Production,
    privacy: 'strict',
});

/** Active QR scanner instance for the send flow (created lazily, torn down on close). */
let sendQrScanner = null;

document.addEventListener("DOMContentLoaded", () => {
    const el = document.getElementById('app-version');
    if (el) {
        fetch('manifest.json').then((res) => res.ok ? res.json() : {}).then((manifest) => {
            if (manifest && manifest.version) el.textContent = manifest.version;
        }).catch(() => {});
    }

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
    const editConnectionModal = document.getElementById('edit-connection-modal');
    const editWalletNameInput = document.getElementById('edit-wallet-name');
    const editWalletUrlInput = document.getElementById('edit-wallet-url');
    const saveEditConnectionButton = document.getElementById('save-edit-connection');
    const closeEditModalButton = document.getElementById('close-edit-modal');
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

    // Transaction detail modal
    const transactionDetailModal = document.getElementById('transaction-detail-modal');
    const transactionDetailList = document.getElementById('transaction-detail-list');
    const closeTransactionDetailButton = document.getElementById('close-transaction-detail-modal');

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

    closeTransactionDetailButton.addEventListener('click', () => {
        transactionDetailModal.style.display = 'none';
    });

    function showTransactionDetail(tx) {
        const list = transactionDetailList;
        list.innerHTML = '';
        const add = (label, value) => {
            if (value === undefined || value === null || value === '') return;
            const dt = document.createElement('dt');
            dt.textContent = label;
            const dd = document.createElement('dd');
            dd.textContent = typeof value === 'object' ? JSON.stringify(value) : String(value);
            list.appendChild(dt);
            list.appendChild(dd);
        };
        add('Type', tx.type);
        add('State', tx.state);
        add('Amount', `${tx.amount / 1000} sats`);
        if (tx.fees_paid != null && tx.fees_paid > 0) add('Fees paid', `${tx.fees_paid / 1000} sats`);
        add('Description', tx.description);
        if (tx.description_hash) add('Description hash', tx.description_hash);
        add('Payment hash', tx.payment_hash);
        if (tx.preimage) add('Preimage', tx.preimage);
        add('Created', new Date(tx.created_at * 1000).toLocaleString());
        if (tx.settled_at) add('Settled', new Date(tx.settled_at * 1000).toLocaleString());
        if (tx.expires_at) add('Expires', new Date(tx.expires_at * 1000).toLocaleString());
        if (tx.invoice) {
            const dt = document.createElement('dt');
            dt.textContent = 'Invoice';
            list.appendChild(dt);
            const dd = document.createElement('dd');
            dd.className = 'transaction-detail-invoice-dd';
            const wrapper = document.createElement('div');
            wrapper.className = 'transaction-detail-invoice-wrapper';
            const input = document.createElement('input');
            input.type = 'text';
            input.readOnly = true;
            input.value = tx.invoice;
            input.setAttribute('aria-label', 'Invoice');
            const copyBtn = document.createElement('button');
            copyBtn.type = 'button';
            copyBtn.className = 'copy-icon-button';
            copyBtn.title = 'Copy invoice';
            copyBtn.setAttribute('aria-label', 'Copy invoice');
            copyBtn.innerHTML = '<i class="fas fa-copy"></i>';
            copyBtn.addEventListener('click', async () => {
                try {
                    await navigator.clipboard.writeText(tx.invoice);
                    notyf.success('Copied!');
                } catch {
                    notyf.error('Could not copy');
                }
            });
            wrapper.appendChild(input);
            wrapper.appendChild(copyBtn);
            dd.appendChild(wrapper);
            list.appendChild(dd);
        }
        if (tx.metadata && Object.keys(tx.metadata).length > 0) {
            const dt = document.createElement('dt');
            dt.textContent = 'Metadata';
            list.appendChild(dt);
            const dd = document.createElement('dd');
            dd.className = 'transaction-detail-metadata-dd';
            const textarea = document.createElement('textarea');
            textarea.readOnly = true;
            textarea.rows = 8;
            textarea.value = JSON.stringify(tx.metadata, null, 2);
            textarea.setAttribute('aria-label', 'Metadata');
            dd.appendChild(textarea);
            list.appendChild(dd);
        }
        transactionDetailModal.style.display = 'block';
    }

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

    /** Index of connection being edited. */
    let pendingEditConnectionIndex = null;

    function closeDeleteConnectionModal() {
        deleteConnectionModal.style.display = 'none';
        pendingDeleteConnectionIndex = null;
    }

    function closeEditConnectionModal() {
        editConnectionModal.style.display = 'none';
        pendingEditConnectionIndex = null;
    }

    function closeAllConnectionMenus() {
        document.querySelectorAll('.connection-item-menu.visible').forEach((m) => m.classList.remove('visible'));
    }

    closeDeleteModalButton.addEventListener('click', closeDeleteConnectionModal);
    deleteConnectionCancelButton.addEventListener('click', closeDeleteConnectionModal);
    deleteConnectionConfirmButton.addEventListener('click', () => {
        if (pendingDeleteConnectionIndex === null) return;
        deleteConnection(pendingDeleteConnectionIndex);
        closeDeleteConnectionModal();
    });

    closeEditModalButton.addEventListener('click', closeEditConnectionModal);
    saveEditConnectionButton.addEventListener('click', () => {
        if (pendingEditConnectionIndex === null) return;
        const name = editWalletNameInput.value.trim();
        const url = editWalletUrlInput.value.trim();
        if (!name || !url) {
            alert('Name and connection string are required.');
            return;
        }
        const conn = connections[pendingEditConnectionIndex];
        if (!conn) return;
        const isCurrentConnection = localStorage.getItem('bullishnwc_currentConnection') === conn.url;
        const urlChanged = url !== conn.url;
        const sameUrlExists = connections.some((c, i) => i !== pendingEditConnectionIndex && c.url === url);
        if (urlChanged && sameUrlExists) {
            alert('Another connection already uses this connection string.');
            return;
        }
        conn.name = name;
        conn.url = url;
        localStorage.setItem('bullishnwc_connections', JSON.stringify(connections));
        updateConnectionList();
        closeEditConnectionModal();
        if (isCurrentConnection) {
            if (urlChanged) {
                loadWallet(url);
            } else {
                document.getElementById('wallet-name-display').textContent = name;
            }
            localStorage.setItem('bullishnwc_currentConnection', url);
        }
    });

    addConnectionButton.addEventListener('click', () => {
        const walletUrl = walletUrlInput.value.trim();
        const walletName = walletNameInput.value.trim();

        if (walletUrl && walletName && !connections.some(conn => conn.url === walletUrl)) {
            const newConnection = { name: walletName, url: walletUrl, isTest: false };
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
            connections.push({ name, url, isTest: true });
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
            defaultMessageDiv.classList.remove('hidden');
            defaultMessageDiv.classList.add('visible');
        } else {
            defaultMessageDiv.classList.add('hidden');
            defaultMessageDiv.classList.remove('visible');
            connections.forEach((conn, index) => {
                const { name, url, isTest } = conn;
                const li = document.createElement('li');
                li.className = 'connection-list-item';

                const nameWrapper = document.createElement('span');
                nameWrapper.className = 'connection-list-item__name';
                nameWrapper.textContent = name;
                if (isTest === true) {
                    const badge = document.createElement('span');
                    badge.className = 'connection-badge connection-badge--test';
                    badge.textContent = 'Test';
                    badge.setAttribute('aria-label', 'Test wallet');
                    nameWrapper.appendChild(document.createTextNode(' '));
                    nameWrapper.appendChild(badge);
                }
                nameWrapper.addEventListener('click', () => {
                    loadWallet(url);
                    flyoutMenu.classList.remove('visible');
                });

                const actionsWrapper = document.createElement('div');
                actionsWrapper.className = 'connection-list-item__actions';

                const menuTrigger = document.createElement('button');
                menuTrigger.type = 'button';
                menuTrigger.className = 'connection-item-menu-trigger';
                menuTrigger.innerHTML = '<i class="fas fa-ellipsis-v" aria-hidden="true"></i>';
                menuTrigger.setAttribute('aria-label', `Options for ${name}`);
                menuTrigger.addEventListener('click', (e) => {
                    e.stopPropagation();
                    if (menu.classList.contains('visible')) {
                        menu.classList.remove('visible');
                        return;
                    }
                    closeAllConnectionMenus();
                    menu.classList.add('visible');
                    requestAnimationFrame(() => {
                        const rect = menuTrigger.getBoundingClientRect();
                        const left = Math.max(4, rect.right - menu.offsetWidth);
                        menu.style.top = `${rect.bottom + 4}px`;
                        menu.style.left = `${left}px`;
                    });
                    setTimeout(() => {
                        const closeMenus = () => {
                            document.removeEventListener('click', closeMenus);
                            menu.classList.remove('visible');
                        };
                        document.addEventListener('click', closeMenus);
                    }, 0);
                });

                const menu = document.createElement('div');
                menu.className = 'connection-item-menu';

                const editBtn = document.createElement('button');
                editBtn.type = 'button';
                editBtn.textContent = 'Edit';
                editBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    menu.classList.remove('visible');
                    const c = connections[index];
                    if (!c) return;
                    pendingEditConnectionIndex = index;
                    editWalletNameInput.value = c.name;
                    editWalletUrlInput.value = c.url;
                    editConnectionModal.style.display = 'block';
                });

                const deleteBtn = document.createElement('button');
                deleteBtn.type = 'button';
                deleteBtn.textContent = 'Delete';
                deleteBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    menu.classList.remove('visible');
                    const c = connections[index];
                    if (!c) return;
                    deleteConnectionMessage.textContent = `Remove [${c.name}]? This cannot be undone.`;
                    pendingDeleteConnectionIndex = index;
                    deleteConnectionModal.style.display = 'block';
                });

                menu.appendChild(editBtn);
                menu.appendChild(deleteBtn);
                actionsWrapper.appendChild(menuTrigger);
                actionsWrapper.appendChild(menu);

                li.appendChild(nameWrapper);
                li.appendChild(actionsWrapper);
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
        balanceDiv.innerHTML = '';
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

    function escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
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
            const balanceResponse = await currentConnection.getBalance();
            const balance = Math.floor(balanceResponse.balance / 1000);
            balanceDiv.innerHTML = `
                <div class="balance-card">
                    <span class="balance-card__amount">${balance}</span>
                    <span class="balance-card__unit">sats</span>
                </div>
            `;
        } catch (error) {
            console.error("Error loading balance:", error);
            balanceDiv.innerHTML = '<p class="balance-card balance-card--error">Error loading balance.</p>';
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

            const transactions = transactionsResponse.transactions;

            if (!Array.isArray(transactions)) {
                console.error("Expected transactions to be an array, but got:", transactions);
                transactionsDiv.innerHTML = "No transactions found.";
                return;
            }

            lastTransactions = transactions;

            transactions.forEach((tx, index) => {
                const transactionDiv = document.createElement('div');
                const isOutgoing = tx.type === 'outgoing';
                const directionClass = isOutgoing ? 'transaction-row--outgoing' : 'transaction-row--incoming';
                const arrow = isOutgoing ? '<i class="fas fa-arrow-up" aria-hidden="true"></i>' : '<i class="fas fa-arrow-down" aria-hidden="true"></i>';
                const timeString = timeAgo(tx.created_at);
                const amountSats = tx.amount / 1000;
                const description = tx.description ? tx.description.trim() : '';
                transactionDiv.className = `transaction-row ${directionClass}`;
                transactionDiv.innerHTML = `
                    <div class="transaction-row__main">
                        <span class="transaction-row__direction">${arrow} ${amountSats} sats</span>
                        <span class="transaction-row__time">${timeString}</span>
                    </div>
                    ${description ? `<div class="transaction-row__description" title="${escapeHtml(description)}">${escapeHtml(description)}</div>` : ''}
                `;
                transactionDiv.addEventListener('click', () => showTransactionDetail(tx));
                transactionsDiv.appendChild(transactionDiv);
            });
        } catch (error) {
            console.error("Error loading transactions:", error);
            transactionsDiv.innerHTML = "Error loading transactions.";
        }
    } // End loadTransactions()

    const sendModal = document.getElementById('send-modal');
    const sendPanels = document.getElementById('send-panels');
    const closeSendModalButton = document.getElementById('close-send-modal');
    const sendInvoiceTextarea = document.getElementById('send-invoice');
    const sendAmountInput = document.getElementById('send-amount');
    const sendMessageEl = document.getElementById('send-message');
    const sendPayButton = document.getElementById('send-pay-button');
    const sendScanButton = document.getElementById('send-scan-button');
    const sendBackButton = document.getElementById('send-back-button');
    const merchantBadge = document.getElementById('send-merchant-badge');
    const merchantBadgeLogo = document.getElementById('send-merchant-badge-logo');
    const merchantBadgeName = document.getElementById('send-merchant-badge-name');
    const merchantBadgeDesc = document.getElementById('send-merchant-badge-desc');
    const confirmAmountValue = document.getElementById('confirm-amount-value');
    const confirmDescription = document.getElementById('confirm-description');
    const confirmMessage = document.getElementById('confirm-message');

    /** Invoice ready to pay; set when confirm panel is shown. */
    let pendingInvoice = null;
    let slideIsDragging = false;
    let slideStartX = 0;
    let slideCurrentX = 0;

    function hideMerchantBadge() {
        merchantBadge.classList.add('hidden');
        merchantBadge.removeAttribute('href');
        merchantBadgeLogo.removeAttribute('src');
        merchantBadgeName.textContent = '';
        merchantBadgeDesc.textContent = '';
    }

    async function lookupMerchantBadge(value, { isQrCode }) {
        if (!value) { hideMerchantBadge(); return; }
        try {
            const result = isQrCode
                ? await brantaService.getPaymentsByQrCode(value)
                : await brantaService.getPayments(value);
            if (!result || !Array.isArray(result.payments) || result.payments.length === 0) {
                hideMerchantBadge(); return;
            }
            const payment = result.payments[0];
            merchantBadgeLogo.src = payment.platformLogoUrl;
            merchantBadgeName.textContent = payment.platform || '';
            merchantBadgeDesc.textContent = payment.description ? payment.description.trim() : '';
            merchantBadgeDesc.classList.toggle('hidden', !payment.description);
            merchantBadge.href = result.verifyUrl;
            merchantBadge.classList.remove('hidden');
        } catch (_) {
            hideMerchantBadge();
        }
    }

    function resetSlider() {
        const thumb = document.getElementById('slide-thumb');
        const label = document.getElementById('slide-label');
        slideCurrentX = 0;
        slideIsDragging = false;
        if (thumb) { thumb.style.transition = 'none'; thumb.style.left = '0'; thumb.style.pointerEvents = ''; }
        if (label) { label.style.opacity = '1'; }
    }

    function showConfirmPanel(invoicePr, sats, description) {
        pendingInvoice = invoicePr;
        confirmAmountValue.textContent = sats > 0 ? String(sats).replace(/\B(?=(\d{3})+(?!\d))/g, ' ') : '—';
        if (description) {
            confirmDescription.textContent = description;
            confirmDescription.classList.remove('hidden');
        } else {
            confirmDescription.textContent = '';
            confirmDescription.classList.add('hidden');
        }
        confirmMessage.textContent = '';
        confirmMessage.className = 'send-message hidden';
        hideMerchantBadge();
        resetSlider();
        sendPanels.classList.add('confirm-active');
    }

    function showInputPanel() {
        sendPanels.classList.remove('confirm-active');
        pendingInvoice = null;
        hideMerchantBadge();
        resetSlider();
    }

    function openSendModal() {
        sendInvoiceTextarea.value = '';
        if (sendAmountInput) sendAmountInput.value = '';
        sendMessageEl.textContent = '';
        sendMessageEl.className = 'send-message hidden';
        showInputPanel();
        sendModal.style.display = 'block';
        sendInvoiceTextarea.focus();
    }

    function closeSendModal() {
        sendModal.style.display = 'none';
        showInputPanel();
    }

    /** Decode a BOLT11 invoice and return { sats, description }. */
    function decodeInvoice(pr) {
        const decoded = decodeBolt11(pr);
        const amtSection = decoded.sections.find(s => s.name === 'amount');
        const descSection = decoded.sections.find(s => s.name === 'description');
        const sats = amtSection ? Math.floor(Number(amtSection.value) / 1000) : 0;
        const description = descSection ? String(descSection.value) : '';
        return { sats, description };
    }

    /** Navigate to the confirm panel for a known invoice string. */
    async function navigateToConfirm(invoice, { isQrCode }) {
        sendMessageEl.className = 'send-message hidden';
        try {
            const { sats, description } = decodeInvoice(invoice);
            showConfirmPanel(invoice, sats, description);
            lookupMerchantBadge(invoice, { isQrCode });
        } catch (_) {
            sendMessageEl.textContent = 'Could not decode invoice.';
            sendMessageEl.className = 'send-message error';
            sendMessageEl.classList.remove('hidden');
        }
    }

    /** Called when the Review button is clicked (or Enter pressed) for LN address or unrecognised input. */
    async function reviewPayment() {
        const value = sendInvoiceTextarea.value.trim();
        if (!value) {
            sendMessageEl.textContent = 'Paste a lightning invoice or lightning address.';
            sendMessageEl.className = 'send-message error';
            sendMessageEl.classList.remove('hidden');
            return;
        }
        if (/^ln/i.test(value)) {
            await navigateToConfirm(value, { isQrCode: false });
            return;
        }
        if (value.includes('@')) {
            const amountRaw = sendAmountInput ? sendAmountInput.value.trim() : '';
            const amount = parseInt(amountRaw, 10);
            if (!amountRaw || !Number.isInteger(amount) || amount < 1) {
                sendMessageEl.textContent = 'Amount (sats) is required for lightning address.';
                sendMessageEl.className = 'send-message error';
                sendMessageEl.classList.remove('hidden');
                return;
            }
            sendPayButton.disabled = true;
            sendPayButton.textContent = 'Loading…';
            try {
                const ln = new LightningAddress(value);
                await ln.fetch();
                const inv = await ln.requestInvoice({ satoshi: amount });
                const pr = inv.paymentRequest;
                let description = '';
                try { description = decodeInvoice(pr).description; } catch (_) {}
                showConfirmPanel(pr, amount, description);
                lookupMerchantBadge(value, { isQrCode: false });
            } catch (err) {
                sendMessageEl.textContent = err.message || 'Could not fetch invoice.';
                sendMessageEl.className = 'send-message error';
                sendMessageEl.classList.remove('hidden');
            } finally {
                sendPayButton.disabled = false;
                sendPayButton.textContent = 'Review';
            }
            return;
        }
        sendMessageEl.textContent = 'Enter a lightning invoice (ln…) or lightning address (user@domain.com).';
        sendMessageEl.className = 'send-message error';
        sendMessageEl.classList.remove('hidden');
    }

    /** Execute the pending payment — triggered when slide-to-send completes. */
    async function executePayment() {
        if (!pendingInvoice) return;
        const thumb = document.getElementById('slide-thumb');
        if (thumb) thumb.style.pointerEvents = 'none';
        try {
            await currentConnection.payInvoice({ invoice: pendingInvoice });
            notyf.success('Payment sent!');
            await loadBalance(currentConnection);
            await loadTransactions(currentConnection);
            closeSendModal();
        } catch (error) {
            confirmMessage.textContent = error.message || 'Payment failed.';
            confirmMessage.className = 'send-message error';
            confirmMessage.classList.remove('hidden');
            resetSlider();
        }
    }

    /** Wire up slide-to-send drag gesture (called once). */
    function initSlideToSend() {
        const track = document.getElementById('slide-track');
        const thumb = document.getElementById('slide-thumb');
        const label = document.getElementById('slide-label');

        function maxX() { return track.offsetWidth - thumb.offsetWidth; }

        function onStart(e) {
            if (!pendingInvoice) return;
            slideIsDragging = true;
            slideStartX = e.touches ? e.touches[0].clientX : e.clientX;
            thumb.style.transition = 'none';
        }

        function onMove(e) {
            if (!slideIsDragging) return;
            const clientX = e.touches ? e.touches[0].clientX : e.clientX;
            slideCurrentX = Math.max(0, Math.min(clientX - slideStartX, maxX()));
            thumb.style.left = slideCurrentX + 'px';
            if (label) label.style.opacity = String(Math.max(0, 1 - slideCurrentX / (maxX() * 0.6)));
        }

        function onEnd() {
            if (!slideIsDragging) return;
            slideIsDragging = false;
            if (slideCurrentX >= maxX() * 0.85) {
                thumb.style.transition = 'left 0.15s ease';
                thumb.style.left = maxX() + 'px';
                setTimeout(executePayment, 150);
            } else {
                thumb.style.transition = 'left 0.25s ease';
                thumb.style.left = '0';
                slideCurrentX = 0;
                if (label) {
                    label.style.transition = 'opacity 0.25s ease';
                    label.style.opacity = '1';
                    setTimeout(() => { label.style.transition = ''; }, 250);
                }
            }
        }

        thumb.addEventListener('mousedown', onStart);
        thumb.addEventListener('touchstart', onStart, { passive: true });
        document.addEventListener('mousemove', onMove);
        document.addEventListener('touchmove', onMove, { passive: true });
        document.addEventListener('mouseup', onEnd);
        document.addEventListener('touchend', onEnd);
    }

    initSlideToSend();

    document.getElementById('send-button').addEventListener('click', openSendModal);
    closeSendModalButton.addEventListener('click', closeSendModal);
    sendBackButton.addEventListener('click', () => { showInputPanel(); sendInvoiceTextarea.focus(); });
    sendPayButton.addEventListener('click', reviewPayment);
    sendInvoiceTextarea.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); reviewPayment(); }
    });
    sendInvoiceTextarea.addEventListener('paste', () => {
        // paste fires before text is inserted — wait one tick then check
        setTimeout(async () => {
            const value = sendInvoiceTextarea.value.trim().replace(/^lightning:/i, '');
            sendInvoiceTextarea.value = value;
            if (/^ln/i.test(value)) await navigateToConfirm(value, { isQrCode: false });
        }, 0);
    });

    document.getElementById('send-paste-button').addEventListener('click', async () => {
        try {
            const text = await navigator.clipboard.readText();
            if (!text) return;
            const trimmed = text.trim().replace(/^lightning:/i, '');
            sendInvoiceTextarea.value = trimmed;
            if (/^ln/i.test(trimmed)) {
                await navigateToConfirm(trimmed, { isQrCode: false });
            }
        } catch (_) {
            sendMessageEl.textContent = 'Could not read clipboard.';
            sendMessageEl.className = 'send-message error';
            sendMessageEl.classList.remove('hidden');
        }
    });

    // QR scan flow — getPaymentsByQrCode handles ZK multi-value QR payloads.
    const qrScanModal = document.getElementById('qr-scan-modal');
    const qrScanVideo = document.getElementById('qr-scan-video');
    const qrScanMessage = document.getElementById('qr-scan-message');
    const closeQrScanModalButton = document.getElementById('close-qr-scan-modal');

    function stopSendQrScanner() {
        if (sendQrScanner) { sendQrScanner.stop(); sendQrScanner.destroy(); sendQrScanner = null; }
    }

    function closeQrScanModal() {
        stopSendQrScanner();
        qrScanModal.style.display = 'none';
    }

    async function openQrScanModal() {
        qrScanMessage.textContent = '';
        qrScanMessage.className = 'send-message hidden';
        qrScanModal.style.display = 'block';
        try {
            sendQrScanner = new QrScanner(
                qrScanVideo,
                async (result) => {
                    const raw = (typeof result === 'string' ? result : result.data).trim();
                    const data = raw.replace(/^lightning:/i, '');
                    closeQrScanModal();
                    sendInvoiceTextarea.value = data;
                    if (/^ln/i.test(data)) {
                        await navigateToConfirm(data, { isQrCode: true });
                    }
                },
                { highlightScanRegion: true, highlightCodeOutline: true }
            );
            await sendQrScanner.start();
        } catch (error) {
            qrScanMessage.textContent = error.message || 'Could not access camera.';
            qrScanMessage.className = 'send-message error';
            qrScanMessage.classList.remove('hidden');
        }
    }

    sendScanButton.addEventListener('click', openQrScanModal);
    closeQrScanModalButton.addEventListener('click', closeQrScanModal);

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