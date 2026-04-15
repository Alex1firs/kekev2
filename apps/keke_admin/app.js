const API_BASE = 'https://api.kekeride.ng/api/v1/admin';
let ADMIN_KEY = localStorage.getItem('KEKE_ADMIN_KEY') || '';

// --- State Management ---
let currentSection = 'overview';
let pendingDrivers = [];
let activeRides = [];
let selectedDriverId = null;

// --- DOM Elements (Loaded Defensively) ---
let navLinks = [];
let sections = [];
let sectionTitle = null;

function captureElements() {
    navLinks = document.querySelectorAll('.nav-links li');
    sections = document.querySelectorAll('.content-section');
    sectionTitle = document.getElementById('section-title');
}

// --- Initialization ---
async function init() {
    if (!ADMIN_KEY) {
        showLoginScreen();
        return;
    }
    
    // Switch to Dashboard UI Instantly
    document.body.classList.remove('auth-loading');
    document.body.classList.add('authenticated');
    
    setupNavigation();
    setupAuthListeners();

    // Background Sync (Non-blocking)
    refreshOverview().catch(e => console.error('Overview sync failed', e));
    setupSocket();
    
    fetchPendingDrivers().catch(e => console.error('Drivers sync failed', e));
    fetchActiveRides().catch(e => console.error('Rides sync failed', e));
    fetchFinanceSummary().catch(e => console.error('Finance sync failed', e));
    fetchDebtLeaderboard().catch(e => console.error('Debt sync failed', e));
    fetchRideHistory().catch(e => console.error('History sync failed', e));
    fetchOnlineDrivers().catch(e => console.error('Online sync failed', e));
    fetchPayouts().catch(e => console.error('Payouts sync failed', e));

    // Auto-refresh stats every 30s
    setInterval(refreshOverview, 30000);
}

// Global Failsafe
window.onerror = (msg) => {
    console.error('[Diagnostic] Global Error:', msg);
};

// --- Navigation ---
function setupNavigation() {
    navLinks.forEach(link => {
        link.addEventListener('click', () => {
            const section = link.getAttribute('data-section');
            switchSection(section);
        });
    });
}

// --- Auth & Session ---
function showLoginScreen() {
    document.body.classList.add('auth-loading');
    document.body.classList.remove('authenticated');
    
    const form = document.getElementById('login-form');
    form.onsubmit = async (e) => {
        e.preventDefault();
        const keyInput = document.getElementById('admin-key-input');
        const btn = document.getElementById('btn-login');
        const key = keyInput.value.trim();
        
        if (!key) return;

        btn.disabled = true;
        btn.querySelector('.btn-spinner').classList.remove('hidden');
        
        try {
            // Verify key by attempting to fetch overview
            const options = {
                headers: { 'x-admin-key': key }
            };
            const res = await fetch(`${API_BASE}/overview`, options);
            if (res.ok) {
                localStorage.setItem('KEKE_ADMIN_KEY', key);
                ADMIN_KEY = key;
                showToast('Workstation authorized', 'success');
                init(); // Re-initialize
            } else {
                showToast('Invalid Admin Key', 'error');
            }
        } catch (err) {
            showToast('Connection failed', 'error');
        } finally {
            btn.disabled = false;
            btn.querySelector('.btn-spinner').classList.add('hidden');
        }
    };
}

function setupAuthListeners() {
    const logoutBtn = document.getElementById('btn-logout');
    if (logoutBtn) {
        logoutBtn.onclick = handleLogout;
    }
}

function handleLogout() {
    localStorage.removeItem('KEKE_ADMIN_KEY');
    location.reload();
}

function switchSection(id) {
    sections.forEach(s => s.classList.add('hidden'));
    navLinks.forEach(l => l.classList.remove('active'));
    
    document.getElementById(id).classList.remove('hidden');
    document.querySelector(`[data-section="${id}"]`).classList.add('active');
    
    currentSection = id;
    sectionTitle.innerText = id.charAt(0).toUpperCase() + id.slice(1).replace('-', ' ');

    // Refresh data when switching
    if (id === 'drivers') { fetchPendingDrivers(); fetchIncompleteDrivers(); }
    if (id === 'active-rides') fetchActiveRides();
    if (id === 'finance') { fetchFinanceSummary(); fetchDebtLeaderboard(); fetchPayouts(); }
    if (id === 'history') fetchRideHistory();
    if (id === 'online-drivers') fetchOnlineDrivers();
}

// --- UI Indicators ---

function showToast(message, type = 'info') {
    const container = document.getElementById('toast-container');
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.innerText = message;
    container.appendChild(toast);
    
    setTimeout(() => {
        toast.style.opacity = '0';
        setTimeout(() => toast.remove(), 500);
    }, 4000);
}

// --- API Helpers ---
async function adminFetch(endpoint, method = 'GET', body = null) {
    try {
        const options = {
            method,
            headers: {
                'x-admin-key': ADMIN_KEY,
                'Content-Type': 'application/json'
            },
            body: body ? JSON.stringify(body) : null
        };
        const res = await fetch(`${API_BASE}${endpoint}`, options);
        
        if (res.status === 429) {
            showToast('Rate limit exceeded. Please wait.', 'error');
            throw new Error('Rate Limited');
        }

        const data = await res.json();
        
        if (!res.ok) {
            showToast(data.error || 'Request failed', 'error');
            throw new Error(data.error);
        }

        return data;
    } catch (e) {
        if (e.message !== 'Rate Limited') {
            console.error('Fetch Error:', e);
        }
        throw e;
    }
}

// --- Data Fetching ---

async function refreshOverview() {
    try {
        const stats = await adminFetch('/overview');
        console.log('[Sync] Received stats:', stats);
        document.getElementById('stat-active-rides').innerText = stats.activeRides;
        document.getElementById('stat-online-drivers').innerText = stats.onlineDrivers;
        document.getElementById('stat-revenue').innerText = `₦${stats.dailyRevenue.toLocaleString()}`;
    } catch (e) {
        console.error('Failed to fetch overview', e);
    }
}

async function fetchPendingDrivers() {
    const drivers = await adminFetch('/drivers/pending');
    console.log('[DEBUG:ADMIN] Pending drivers raw response:', drivers);
    pendingDrivers = drivers;
    const list = document.getElementById('pending-drivers-list');
    if (!list) return;

    list.innerHTML = drivers.map(d => `
        <tr>
            <td>${d.firstName} ${d.lastName}</td>
            <td>${d.vehicleModel} (${d.vehiclePlate})</td>
            <td>${new Date(d.createdAt).toLocaleString()}</td>
            <td><button class="btn-primary" onclick="reviewDriver('${d.userId}')">Review</button></td>
        </tr>
    `).join('');
    if (drivers.length === 0) list.innerHTML = '<tr><td colspan="4">No pending applications.</td></tr>';
}

async function fetchIncompleteDrivers() {
    const drivers = await adminFetch('/drivers/incomplete');
    const list = document.getElementById('incomplete-drivers-list');
    list.innerHTML = drivers.map(d => `
        <tr>
            <td>${d.firstName} ${d.lastName}</td>
            <td>${d.vehicleModel} (${d.vehiclePlate})</td>
            <td>${new Date(d.createdAt).toLocaleDateString()}</td>
            <td><button class="btn-secondary" onclick="reviewDriver('${d.userId}')">View Progress</button></td>
        </tr>
    `).join('');
    if (drivers.length === 0) list.innerHTML = '<tr><td colspan="4">No incomplete applications.</td></tr>';
}

async function fetchActiveRides() {
    const rides = await adminFetch('/rides/active');
    activeRides = rides;
    const list = document.getElementById('active-rides-list');
    list.innerHTML = rides.map(r => `
        <tr>
            <td>${r.rideId}</td>
            <td><span class="status-indicator online"></span> ${r.status.toUpperCase()}</td>
            <td>${r.passengerId}</td>
            <td>${r.driverId || '---'}</td>
            <td>₦${r.fare}</td>
        </tr>
    `).join('');
    
    updateOperationalAlerts(rides);
}

async function fetchFinanceSummary() {
    const summary = await adminFetch('/finance/summary');
    document.getElementById('finance-total-debt').innerText = `₦${summary.totalCommissionDebt.toLocaleString()}`;
    // Payout ready would be a filtered calculation
}

async function fetchRideHistory() {
    const history = await adminFetch('/rides/history');
    const list = document.getElementById('ride-history-list');
    list.innerHTML = history.map(r => `
        <tr>
            <td>${new Date(r.createdAt).toLocaleDateString()}</td>
            <td>${r.rideId}</td>
            <td>${r.status}</td>
            <td>₦${r.fare}</td>
        </tr>
    `).join('');
}

async function fetchOnlineDrivers() {
    const drivers = await adminFetch('/drivers/online');
    const list = document.getElementById('online-drivers-list');
    list.innerHTML = drivers.map(d => `
        <tr>
            <td>${d.userId}</td>
            <td>${d.location}</td>
        </tr>
    `).join('');
}

async function fetchDebtLeaderboard() {
    const debts = await adminFetch('/finance/debts');
    const list = document.getElementById('debt-leaderboard');
    list.innerHTML = debts.map(d => `
        <tr>
            <td>${d.userId}</td>
            <td>₦${parseFloat(d.driverCommissionDebt).toLocaleString()}</td>
            <td>${parseFloat(d.driverCommissionDebt) >= 5000 ? '🔴 BLOCKED' : '🟢 ACTIVE'}</td>
        </tr>
    `).join('');
}

async function fetchPayouts() {
    // Logic for payouts could go here if UI exists, for now just fetch
    const payouts = await adminFetch('/finance/payouts');
}

// --- Operational Logic ---

function updateOperationalAlerts(rides) {
    const alertsList = document.getElementById('ops-alerts-list');
    const now = new Date();
    const alerts = [];

    rides.forEach(ride => {
        const ageInMins = (now - new Date(ride.updatedAt || ride.createdAt)) / 60000;
        
        if (ride.status === 'searching' && ageInMins > 3) {
            alerts.push({ text: `Ride ${ride.rideId} searching for ${Math.round(ageInMins)}m`, type: 'danger' });
        }
        if (ride.status === 'accepted' && ageInMins > 5) {
            alerts.push({ text: `Driver ${ride.driverId} stagnant on Ride ${ride.rideId}`, type: 'warning' });
        }
    });

    if (alerts.length === 0) {
        alertsList.innerHTML = '<div class="empty-state">No critical alerts. System healthy.</div>';
    } else {
        alertsList.innerHTML = alerts.map(a => `
            <div class="alert-item ${a.type === 'danger' ? '' : 'warning'}">
                <i class="fas fa-exclamation-triangle"></i>
                <span>${a.text}</span>
            </div>
        `).join('');
    }
}

// --- Modal Logic ---

let activeDocUrls = [];

window.reviewDriver = async function(userId) {
    console.log('[DEBUG:ADMIN] Reviewing driver:', userId);
    
    // 1. Initialize modal elements FIRST to prevent null pointer errors
    const modal = createReviewModal();
    const modalBody = document.getElementById('modal-body');
    const btnApprove = document.getElementById('btn-approve');
    
    if (!modalBody) {
        console.error('[CRITICAL] modal-body element not found after creation');
        return;
    }

    // 2. Fetch driver details
    let driver;
    try {
        driver = await adminFetch(`/drivers/${userId}`);
    } catch (e) {
        console.error('[ERROR] Failed to fetch driver details:', e);
        return;
    }
    
    if (!driver) {
        console.error('[ERROR] No driver found for ID:', userId);
        return;
    }

    console.log('[DEBUG:ADMIN] Clicked driver payload:', driver);
    
    selectedDriverId = userId;
    
    // Clear previous URLs
    activeDocUrls.forEach(url => URL.revokeObjectURL(url));
    activeDocUrls = [];

    const isPendingReview = driver.status === 'pending_review';

    modalBody.innerHTML = `
        <div style="margin-top: 16px;">
            <div style="display:flex; justify-content:space-between; align-items:flex-start;">
                <div>
                    <p><strong>Name:</strong> ${driver.firstName} ${driver.lastName}</p>
                    <p><strong>Vehicle:</strong> ${driver.vehicleModel} (${driver.vehiclePlate})</p>
                    <p><strong>Status:</strong> <span class="status-indicator ${isPendingReview ? 'online' : 'offline'}"></span> ${driver.status.toUpperCase().replace('_', ' ')}</p>
                </div>
                <div style="text-align:right;">
                    <p><strong>Submitted:</strong><br/>${new Date(driver.createdAt).toLocaleString()}</p>
                </div>
            </div>

            <div class="doc-gallery" id="document-gallery">
                <div class="doc-item">
                    <div class="doc-thumb loading" id="thumb-license"></div>
                    <span>License ${driver.licenseUrl ? '✅' : '❌'}</span>
                </div>
                <div class="doc-item">
                    <div class="doc-thumb loading" id="thumb-id"></div>
                    <span>ID Card ${driver.idCardUrl ? '✅' : '❌'}</span>
                </div>
                <div class="doc-item">
                    <div class="doc-thumb loading" id="thumb-vehicle"></div>
                    <span>Vehicle Paper ${driver.vehiclePaperUrl ? '✅' : '❌'}</span>
                </div>
            </div>

            ${!isPendingReview ? `<div style="margin: 10px 0; padding: 10px; background: #332200; border-radius: 8px; color: #ffaa00;">
                <i class="fas fa-info-circle"></i> This driver is still uploading documents.
            </div>` : ''}

            <div style="margin-top:24px; border-top: 1px solid #333; padding-top: 16px;">
                <label>Review Notes / Rejection Reason:</label><br/>
                <input type="text" id="reject-reason" placeholder="e.g. License expired, ID blurred..." style="width:100%; padding:10px; margin-top:8px; border-radius:8px; border:1px solid #333; background:#222; color:white;">
            </div>
        </div>
    `;

    modal.classList.remove('hidden');

    // Load Documents as Blobs (Authenticated) - Only if URL exists
    if (driver.licenseUrl) loadDocThumbnail(userId, 'license', 'thumb-license');
    else document.getElementById('thumb-license').innerHTML = '<div class="doc-thumb missing"><i class="fas fa-minus"></i></div>';
    
    if (driver.idCardUrl) loadDocThumbnail(userId, 'id_card', 'thumb-id');
    else document.getElementById('thumb-id').innerHTML = '<div class="doc-thumb missing"><i class="fas fa-minus"></i></div>';

    if (driver.vehiclePaperUrl) loadDocThumbnail(userId, 'vehicle_paper', 'thumb-vehicle');
    else document.getElementById('thumb-vehicle').innerHTML = '<div class="doc-thumb missing"><i class="fas fa-minus"></i></div>';

    // Disable approval if not pending_review
    document.getElementById('btn-approve').disabled = !isPendingReview;
    document.getElementById('btn-approve').style.opacity = isPendingReview ? '1' : '0.5';
};

async function loadDocThumbnail(userId, docType, containerId) {
    const container = document.getElementById(containerId);
    try {
        const options = {
            headers: { 'x-admin-key': ADMIN_KEY }
        };
        const res = await fetch(`${API_BASE}/drivers/${userId}/documents/${docType}`, options);
        if (!res.ok) throw new Error('Not found');

        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        activeDocUrls.push(url);

        container.innerHTML = `<img src="${url}" class="doc-thumb" onclick="window.open('${url}')">`;
        container.classList.remove('loading');
    } catch (e) {
        container.innerHTML = '<div class="doc-thumb missing"><i class="fas fa-times"></i></div>';
        container.classList.remove('loading');
    }
}

function createReviewModal() {
    let modal = document.getElementById('review-modal');
    if (!modal) {
        modal = document.createElement('div');
        modal.id = 'review-modal';
        modal.className = 'modal hidden';
        modal.innerHTML = `
            <div class="modal-content">
                <h2>Driver Application Review</h2>
                <div id="modal-body"></div>
                <div class="modal-actions">
                    <button id="btn-approve" class="btn-primary">Approve</button>
                    <button id="btn-reject" class="btn-danger">Reject</button>
                    <button id="btn-close" class="btn-secondary">Close</button>
                </div>
            </div>
        `;
        document.body.appendChild(modal);
        
        // Bind events to the newly created buttons
        document.getElementById('btn-approve').onclick = async () => {
            if (!selectedDriverId) return;
            await adminFetch(`/drivers/${selectedDriverId}/approve`, 'POST');
            closeModal();
            fetchPendingDrivers();
        };

        document.getElementById('btn-reject').onclick = async () => {
            if (!selectedDriverId) return;
            const reason = document.getElementById('reject-reason').value;
            await adminFetch(`/drivers/${selectedDriverId}/reject`, 'POST', { reason });
            closeModal();
            fetchPendingDrivers();
        };

        document.getElementById('btn-close').onclick = closeModal;
    }
    return modal;
}

function closeModal() {
    const modal = document.getElementById('review-modal');
    if (modal) modal.classList.add('hidden');
    selectedDriverId = null;
    // Cleanup Blob URLs
    activeDocUrls.forEach(url => URL.revokeObjectURL(url));
    activeDocUrls = [];
}

// --- WebSocket Setup ---

function setupSocket() {
    const socket = io('https://api.kekeride.ng');
    
    socket.on('connect', () => {
        socket.emit('join', { userId: 'dashboard', role: 'admin' });
        document.getElementById('api-status').classList.add('online');
    });

    socket.on('disconnect', () => {
        document.getElementById('api-status').classList.remove('online');
    });

    // Handle real-time updates
    socket.on('ride:status_update', () => {
        if (currentSection === 'active-rides' || currentSection === 'overview') {
            fetchActiveRides();
            refreshOverview();
        }
    });

    socket.on('ride:request', () => fetchActiveRides());
    socket.on('ride:assigned', () => fetchActiveRides());
}

document.addEventListener('DOMContentLoaded', () => {
    captureElements();
    init();
});
