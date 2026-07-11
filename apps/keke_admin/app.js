let ADMIN_ENV = sessionStorage.getItem('KEKE_ADMIN_ENV') || 'production';

const API_BASE = (() => {
  const host = window.location.hostname;
  if (host === 'localhost' || host === '127.0.0.1') {
    return ADMIN_ENV === 'staging'
      ? 'http://localhost:3000/api/v1/admin'
      : 'http://localhost:4000/api/v1/admin';
  }
  return ADMIN_ENV === 'staging'
    ? 'https://staging.kekeride.ng/api/v1/admin'
    : 'https://api.kekeride.ng/api/v1/admin';
})();
let ADMIN_KEY = sessionStorage.getItem('KEKE_ADMIN_KEY') || '';

// --- XSS Protection ---
function escapeHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// --- State ---
let currentSection = 'overview';
let pendingDrivers = [];
let activeRides = [];
let selectedDriverId = null;

let navLinks = [];
let sections = [];
let sectionTitle = null;

function captureElements() {
    navLinks = document.querySelectorAll('.nav-links li');
    sections = document.querySelectorAll('.content-section');
    sectionTitle = document.getElementById('section-title');
}

// --- Init ---
async function init() {
    if (!ADMIN_KEY) { showLoginScreen(); return; }

    document.body.classList.remove('auth-loading');
    document.body.classList.add('authenticated');

    // Update the environment badge
    const badge = document.getElementById('env-badge');
    if (badge) {
        badge.innerText = ADMIN_ENV.toUpperCase();
        badge.className = `env-badge ${ADMIN_ENV}`;
    }

    setupNavigation();
    setupAuthListeners();
    setupSettingsForm();

    document.getElementById('btn-view-sos')?.addEventListener('click', () => {
        switchSection('sos-alerts');
    });

    refreshOverview().catch(() => {});
    setupSocket();

    fetchPendingDrivers().catch(() => {});
    fetchActiveRides().catch(() => {});
    fetchFinanceSummary().catch(() => {});
    fetchDebtLeaderboard().catch(() => {});
    fetchRideHistory().catch(() => {});
    fetchOnlineDrivers().catch(() => {});
    fetchPayouts().catch(() => {});
    fetchSosAlerts().catch(() => {});

    setInterval(refreshOverview, 30000);
}

window.onerror = (msg) => { console.error('[Global Error]:', msg); };

// --- Navigation ---
function setupNavigation() {
    navLinks.forEach(link => {
        link.addEventListener('click', () => {
            switchSection(link.getAttribute('data-section'));
        });
    });
}

function switchSection(id) {
    sections.forEach(s => s.classList.add('hidden'));
    navLinks.forEach(l => l.classList.remove('active'));

    const el = document.getElementById(id);
    if (el) el.classList.remove('hidden');
    const nav = document.querySelector(`[data-section="${id}"]`);
    if (nav) nav.classList.add('active');

    currentSection = id;
    if (sectionTitle) sectionTitle.innerText = id.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());

    if (id === 'drivers')       { fetchPendingDrivers(); fetchIncompleteDrivers(); }
    if (id === 'active-rides')  fetchActiveRides();
    if (id === 'finance')       { fetchFinanceSummary(); fetchDebtLeaderboard(); }
    if (id === 'payouts')       fetchPayouts();
    if (id === 'history')       fetchRideHistory();
    if (id === 'online-drivers')fetchOnlineDrivers();
    if (id === 'sos-alerts')    fetchSosAlerts();
    if (id === 'audit-log')     fetchAuditLog();
    if (id === 'settings')      fetchSettings();
}

// --- Auth ---
function showLoginScreen() {
    document.body.classList.add('auth-loading');
    document.body.classList.remove('authenticated');

    const envSelect = document.getElementById('admin-env-select');
    if (envSelect) envSelect.value = ADMIN_ENV;

    const form = document.getElementById('login-form');
    form.onsubmit = async (e) => {
        e.preventDefault();
        const keyInput = document.getElementById('admin-key-input');
        const btn = document.getElementById('btn-login');
        const key = keyInput.value.trim();
        const env = envSelect ? envSelect.value : 'production';
        if (!key) return;

        btn.disabled = true;
        btn.querySelector('.btn-spinner').classList.remove('hidden');

        const apiBaseForLogin = (() => {
            const host = window.location.hostname;
            if (host === 'localhost' || host === '127.0.0.1') {
                return env === 'staging'
                    ? 'http://localhost:3000/api/v1/admin'
                    : 'http://localhost:4000/api/v1/admin';
            }
            return env === 'staging'
                ? 'https://staging.kekeride.ng/api/v1/admin'
                : 'https://api.kekeride.ng/api/v1/admin';
        })();

        try {
            const res = await fetch(`${apiBaseForLogin}/overview`, { headers: { 'x-admin-key': key } });
            if (res.ok) {
                sessionStorage.setItem('KEKE_ADMIN_KEY', key);
                sessionStorage.setItem('KEKE_ADMIN_ENV', env);
                showToast('Workstation authorized', 'success');
                location.reload(); // Reload to initialize Socket and API base with selected env
            } else {
                showToast('Invalid Admin Key', 'error');
            }
        } catch {
            showToast('Connection failed', 'error');
        } finally {
            btn.disabled = false;
            btn.querySelector('.btn-spinner').classList.add('hidden');
        }
    };
}

function setupAuthListeners() {
    const logoutBtn = document.getElementById('btn-logout');
    if (logoutBtn) logoutBtn.onclick = handleLogout;
}

function handleLogout() {
    sessionStorage.removeItem('KEKE_ADMIN_KEY');
    location.reload();
}

// --- UI Helpers ---
function showToast(message, type = 'info') {
    const container = document.getElementById('toast-container');
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.innerText = message;
    container.appendChild(toast);
    setTimeout(() => { toast.style.opacity = '0'; setTimeout(() => toast.remove(), 500); }, 4000);
}

// --- API ---
async function adminFetch(endpoint, method = 'GET', body = null) {
    try {
        const options = {
            method,
            headers: { 'x-admin-key': ADMIN_KEY, 'Content-Type': 'application/json' },
            body: body ? JSON.stringify(body) : null
        };
        const res = await fetch(`${API_BASE}${endpoint}`, options);

        if (res.status === 429) {
            showToast('Rate limit exceeded. Please wait.', 'error');
            throw new Error('Rate Limited');
        }

        let data;
        try {
            data = await res.json();
        } catch {
            if (!res.ok) {
                showToast(`Request failed (HTTP ${res.status})`, 'error');
                throw new Error(`HTTP ${res.status}`);
            }
            throw new Error('Invalid JSON response');
        }

        if (!res.ok) {
            showToast(data.error || 'Request failed', 'error');
            throw new Error(data.error);
        }
        return data;
    } catch (e) {
        if (e.message !== 'Rate Limited') console.error('Fetch Error:', e);
        throw e;
    }
}

// --- Data Fetching ---

async function refreshOverview() {
    try {
        const stats = await adminFetch('/overview');
        document.getElementById('stat-active-rides').innerText = stats.activeRides;
        document.getElementById('stat-online-drivers').innerText = stats.onlineDrivers;
        document.getElementById('stat-revenue').innerText = `₦${Number(stats.dailyRevenue).toLocaleString()}`;
    } catch {}
}

async function fetchPendingDrivers() {
    const drivers = await adminFetch('/drivers/pending');
    pendingDrivers = drivers;
    const list = document.getElementById('pending-drivers-list');
    if (!list) return;
    list.innerHTML = drivers.map(d => `
        <tr>
            <td>${escapeHtml(d.firstName)} ${escapeHtml(d.lastName)}</td>
            <td>${escapeHtml(d.vehicleModel)} (${escapeHtml(d.vehiclePlate)})</td>
            <td>${new Date(d.createdAt).toLocaleString()}</td>
            <td><button class="btn-primary" onclick="reviewDriver('${escapeHtml(d.userId)}')">Review</button></td>
        </tr>
    `).join('');
    if (!drivers.length) list.innerHTML = '<tr><td colspan="4">No pending applications.</td></tr>';
}

async function fetchIncompleteDrivers() {
    const drivers = await adminFetch('/drivers/incomplete');
    const list = document.getElementById('incomplete-drivers-list');
    list.innerHTML = drivers.map(d => `
        <tr>
            <td>${escapeHtml(d.firstName)} ${escapeHtml(d.lastName)}</td>
            <td>${escapeHtml(d.vehicleModel)} (${escapeHtml(d.vehiclePlate)})</td>
            <td>${new Date(d.createdAt).toLocaleDateString()}</td>
            <td><button class="btn-secondary" onclick="reviewDriver('${escapeHtml(d.userId)}')">View Progress</button></td>
        </tr>
    `).join('');
    if (!drivers.length) list.innerHTML = '<tr><td colspan="4">No incomplete applications.</td></tr>';
}

async function fetchActiveRides() {
    const rides = await adminFetch('/rides/active');
    activeRides = rides;
    const list = document.getElementById('active-rides-list');
    list.innerHTML = rides.map(r => `
        <tr>
            <td>${escapeHtml(r.rideId)}</td>
            <td><span class="status-indicator online"></span> ${escapeHtml(r.status).toUpperCase()}</td>
            <td>${escapeHtml(r.paymentMode || 'cash').toUpperCase()}</td>
            <td>${escapeHtml(r.passengerId)}</td>
            <td>${escapeHtml(r.driverId) || '---'}</td>
            <td>₦${Number(r.fare).toLocaleString()}</td>
        </tr>
    `).join('');
    updateOperationalAlerts(rides);
    if (!rides.length) list.innerHTML = '<tr><td colspan="6">No active rides.</td></tr>';
}

async function fetchFinanceSummary() {
    const summary = await adminFetch('/finance/summary');
    document.getElementById('finance-total-debt').innerText = `₦${Number(summary.totalCommissionDebt).toLocaleString()}`;
    const payoutReadyEl = document.getElementById('finance-payout-ready');
    if (payoutReadyEl) payoutReadyEl.innerText = `₦${Number(summary.totalAvailableBalance).toLocaleString()}`;
    const platformEl = document.getElementById('finance-platform-revenue');
    if (platformEl) platformEl.innerText = `₦${Number(summary.platformRevenue).toLocaleString()}`;
}

async function fetchRideHistory() {
    const history = await adminFetch('/rides/history');
    const list = document.getElementById('ride-history-list');
    list.innerHTML = history.map(r => `
        <tr>
            <td>${new Date(r.createdAt).toLocaleDateString()}</td>
            <td>${escapeHtml(r.rideId)}</td>
            <td>${escapeHtml(r.status)}</td>
            <td>${escapeHtml(r.paymentMode || 'cash').toUpperCase()}</td>
            <td>₦${Number(r.fare).toLocaleString()}</td>
        </tr>
    `).join('');
    if (!history.length) list.innerHTML = '<tr><td colspan="5">No ride history.</td></tr>';
}

async function fetchOnlineDrivers() {
    const drivers = await adminFetch('/drivers/online');
    const list = document.getElementById('online-drivers-list');
    list.innerHTML = drivers.map(d => `
        <tr>
            <td>${escapeHtml(d.userId)}</td>
            <td>${escapeHtml(String(d.lat || '—'))}</td>
            <td>${escapeHtml(String(d.lng || '—'))}</td>
        </tr>
    `).join('');
    if (!drivers.length) list.innerHTML = '<tr><td colspan="3">No drivers online.</td></tr>';
}

async function fetchDebtLeaderboard() {
    const debts = await adminFetch('/finance/debts');
    const list = document.getElementById('debt-leaderboard');
    list.innerHTML = debts.map(d => `
        <tr>
            <td>${escapeHtml(d.userId)}</td>
            <td>₦${Number(d.driverCommissionDebt).toLocaleString()}</td>
            <td>${parseFloat(d.driverCommissionDebt) >= 5000 ? '🔴 HARD BLOCK'
                 : parseFloat(d.driverCommissionDebt) >= 2000 ? '🟠 CASH BLOCKED'
                 : '🟢 ACTIVE'}</td>
        </tr>
    `).join('');
    if (!debts.length) list.innerHTML = '<tr><td colspan="3">No debt records.</td></tr>';
}

async function fetchPayouts() {
    const payouts = await adminFetch('/finance/payouts');
    const list = document.getElementById('payouts-list');
    if (!list) return;

    list.innerHTML = payouts.map(p => {
        const statusColor = { pending: '#ffaa00', processing: '#5599ff', success: '#44cc44', failed: '#ff4444' }[p.status] || '#aaa';
        const canProcess  = p.status === 'pending';
        const canComplete = p.status === 'processing';
        const canFail     = p.status === 'pending' || p.status === 'processing';

        return `
        <tr>
            <td>${new Date(p.createdAt).toLocaleString()}</td>
            <td>${escapeHtml(p.driverId)}</td>
            <td>₦${Number(p.amount).toLocaleString()}</td>
            <td>${escapeHtml(p.bankCode || '—')}</td>
            <td>${escapeHtml(p.accountNumber || '—')}</td>
            <td style="color:${statusColor}; font-weight:bold;">${escapeHtml(p.status).toUpperCase()}</td>
            <td>
                ${canProcess  ? `<button class="btn-secondary" style="margin:2px;" onclick="payoutAction('${escapeHtml(p.id)}','process')">Mark Processing</button>` : ''}
                ${canComplete ? `<button class="btn-primary"   style="margin:2px;" onclick="payoutAction('${escapeHtml(p.id)}','complete')">Mark Complete</button>` : ''}
                ${canFail     ? `<button class="btn-danger"    style="margin:2px;" onclick="payoutAction('${escapeHtml(p.id)}','fail')">Mark Failed</button>` : ''}
                ${!canProcess && !canComplete && !canFail ? '<span style="color:#666">—</span>' : ''}
            </td>
        </tr>`;
    }).join('');
    if (!payouts.length) list.innerHTML = '<tr><td colspan="7">No payout requests yet.</td></tr>';
}

window.payoutAction = async function(id, action) {
    const labels = { process: 'Mark as Processing', complete: 'Mark as Complete', fail: 'Mark as Failed' };
    if (!confirm(`${labels[action]}?`)) return;
    try {
        await adminFetch(`/finance/payouts/${id}/${action}`, 'POST');
        showToast(`Payout ${action}d successfully`, 'success');
        fetchPayouts();
    } catch {}
};

const addressCache = {};
async function getHumanReadableAddress(lat, lng) {
    const key = `${lat},${lng}`;
    if (addressCache[key]) return addressCache[key];
    try {
        const res = await fetch(`https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lng}`);
        const data = await res.json();
        addressCache[key] = data.display_name || 'Address not found';
        return addressCache[key];
    } catch {
        return `${lat}, ${lng}`;
    }
}

let activeTrackingMap = null;
let activeTrackingMarker = null;

async function fetchSosAlerts() {
    const alerts = await adminFetch('/sos/active');
    const list = document.getElementById('sos-alerts-list');
    if (!list) return;

    list.innerHTML = alerts.map(a => `
        <tr style="background-color: #330000;">
            <td style="color: #ff4d4d; font-weight: bold;">${new Date(a.createdAt).toLocaleString()}</td>
            <td>${escapeHtml(a.rideId)}</td>
            <td>
                <strong>${escapeHtml(a.initiatorRole).toUpperCase()}</strong><br>
                <div style="font-size: 11px; margin-top: 5px;">
                    <strong>Driver:</strong> ${escapeHtml(a.driverName)} (${escapeHtml(a.driverPhone)})<br>
                    <strong>Pass:</strong> ${escapeHtml(a.passengerName)} (${escapeHtml(a.passengerPhone)})
                </div>
            </td>
            <td><strong>${escapeHtml(a.reason || 'Emergency')}</strong></td>
            <td>
                <span id="address-${a.id}">Loading address...</span>
                <div style="font-size: 10px; color: #aaa;">(${escapeHtml(a.lat)}, ${escapeHtml(a.lng)})</div>
            </td>
            <td>
                <button class="btn-primary" onclick="trackLiveSOS('${escapeHtml(a.rideId)}', ${a.lat}, ${a.lng})" style="margin-bottom: 5px; width: 100%;">Track Live</button><br>
                <button class="btn-resolve" onclick="resolveSosAlert('${escapeHtml(a.id)}')">Resolve</button>
            </td>
        </tr>
    `).join('');
    
    if (!alerts.length) list.innerHTML = '<tr class="empty-state"><td colspan="6">No active SOS alerts.</td></tr>';

    alerts.forEach(a => {
        getHumanReadableAddress(a.lat, a.lng).then(address => {
            const el = document.getElementById(`address-${a.id}`);
            if (el) el.innerText = address;
        });
    });

    const banner = document.getElementById('global-sos-banner');
    const siren = document.getElementById('sos-siren');
    if (alerts.length > 0) {
        if (banner) banner.classList.remove('hidden');
        if (siren) siren.play().catch(() => {});
    } else {
        if (banner) banner.classList.add('hidden');
        if (siren) {
            siren.pause();
            siren.currentTime = 0;
        }
    }
}

window.trackLiveSOS = function(rideId, lat, lng) {
    const modal = document.getElementById('live-tracking-modal');
    modal.classList.remove('hidden');

    if (activeTrackingMap) {
        activeTrackingMap.remove();
    }

    activeTrackingMap = L.map('tracking-map').setView([lat, lng], 16);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '&copy; OpenStreetMap contributors'
    }).addTo(activeTrackingMap);

    const driverIcon = L.divIcon({
        className: 'driver-marker',
        html: '<div style="background-color: #ff4d4d; width: 20px; height: 20px; border-radius: 50%; border: 3px solid white; box-shadow: 0 0 10px #ff4d4d; animation: pulse 1s infinite;"></div>',
        iconSize: [26, 26],
        iconAnchor: [13, 13]
    });

    activeTrackingMarker = L.marker([lat, lng], { icon: driverIcon }).addTo(activeTrackingMap);
    
    // Join ride room to get real-time location updates
    socket.emit('join', { role: 'ride', userId: rideId });
};

window.resolveSosAlert = async function(id) {
    if (!confirm('Mark this emergency as resolved?')) return;
    try {
        await adminFetch(`/sos/${id}/resolve`, 'POST');
        showToast('SOS resolved successfully', 'success');
        fetchSosAlerts();
    } catch {}
};

async function fetchAuditLog() {
    const logs = await adminFetch('/audit-log');
    const list = document.getElementById('audit-log-list');
    if (!list) return;
    list.innerHTML = logs.map(l => `
        <tr>
            <td>${new Date(l.createdAt).toLocaleString()}</td>
            <td>${escapeHtml(l.adminId)}</td>
            <td>${escapeHtml(l.action)}</td>
            <td>${escapeHtml(l.entityType)}</td>
            <td style="font-family:monospace; font-size:11px;">${escapeHtml(l.entityId)}</td>
        </tr>
    `).join('');
    if (!logs.length) list.innerHTML = '<tr><td colspan="5">No admin actions recorded yet.</td></tr>';
}

// --- Operational Alerts ---
function updateOperationalAlerts(rides) {
    const alertsList = document.getElementById('ops-alerts-list');
    const now = new Date();
    const alerts = [];

    rides.forEach(ride => {
        const ageInMins = (now - new Date(ride.updatedAt || ride.createdAt)) / 60000;
        if (ride.status === 'searching' && ageInMins > 3)
            alerts.push({ text: `Ride ${escapeHtml(ride.rideId)} searching for ${Math.round(ageInMins)}m`, type: 'danger' });
        if (ride.status === 'accepted' && ageInMins > 10)
            alerts.push({ text: `Driver ${escapeHtml(ride.driverId)} stagnant on Ride ${escapeHtml(ride.rideId)} (${Math.round(ageInMins)}m)`, type: 'warning' });
        if (ride.paymentFailed)
            alerts.push({ text: `Payment FAILED for Ride ${escapeHtml(ride.rideId)} — manual resolution needed`, type: 'danger' });
    });

    alertsList.innerHTML = alerts.length
        ? alerts.map(a => `<div class="alert-item ${a.type === 'danger' ? '' : 'warning'}"><i class="fas fa-exclamation-triangle"></i><span>${a.text}</span></div>`).join('')
        : '<div class="empty-state">No critical alerts. System healthy.</div>';
}

// --- Driver Review Modal ---
let activeDocUrls = [];

window.reviewDriver = async function(userId) {
    const modal = createReviewModal();
    const modalBody = document.getElementById('modal-body');
    if (!modalBody) return;

    let driver;
    try { driver = await adminFetch(`/drivers/${userId}`); }
    catch { return; }
    if (!driver) return;

    selectedDriverId = userId;
    activeDocUrls.forEach(url => URL.revokeObjectURL(url));
    activeDocUrls = [];

    const isPendingReview = driver.status === 'pending_review';
    const isSuspended     = driver.status === 'suspended';
    const isApproved      = driver.status === 'approved';

    modalBody.innerHTML = `
        <div style="margin-top:16px;">
            <div style="display:flex;justify-content:space-between;align-items:flex-start;">
                <div>
                    <p><strong>Name:</strong> ${escapeHtml(driver.firstName)} ${escapeHtml(driver.lastName)}</p>
                    <p><strong>Email:</strong> ${driver.email ? escapeHtml(driver.email) : '<em style="color:#888;">N/A</em>'}</p>
                    <p><strong>Phone:</strong> ${driver.phone ? escapeHtml(driver.phone) : '<em style="color:#888;">N/A</em>'}</p>
                    <p><strong>Vehicle:</strong> ${escapeHtml(driver.vehicleModel)} (${escapeHtml(driver.vehiclePlate)})</p>
                    <p><strong>NIN:</strong> ${driver.nin ? escapeHtml(driver.nin) : '<em style="color:#888;">Not Provided</em>'} ${driver.ninVerified ? '<span style="color:#00e676;font-size:0.85em;margin-left:6px;"><i class="fas fa-check-circle"></i> Verified</span>' : '<span style="color:#ff4d4d;font-size:0.85em;margin-left:6px;"><i class="fas fa-times-circle"></i> Unverified</span>'}</p>
                    <p><strong>Status:</strong> <span class="status-indicator ${isPendingReview || isApproved ? 'online' : 'offline'}"></span>
                        ${escapeHtml(driver.status).toUpperCase().replace(/_/g, ' ')}</p>
                    ${driver.rejectionReason ? `<p style="color:#ff9900;"><strong>Reason:</strong> ${escapeHtml(driver.rejectionReason)}</p>` : ''}
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
                <div class="doc-item">
                    <div class="doc-thumb loading" id="thumb-photo"></div>
                    <span>Driver Selfie ${driver.photoUrl ? '✅' : '❌'}</span>
                </div>
            </div>

            ${!isPendingReview && !isApproved && !isSuspended ? `
                <div style="margin:10px 0;padding:10px;background:#332200;border-radius:8px;color:#ffaa00;">
                    <i class="fas fa-info-circle"></i> This driver is still uploading documents.
                </div>` : ''}

            <div style="margin-top:24px;border-top:1px solid #333;padding-top:16px;">
                <label>Rejection Reason / Suspension Note:</label><br/>
                <input type="text" id="reject-reason" placeholder="e.g. License expired, policy violation..."
                    style="width:100%;padding:10px;margin-top:8px;border-radius:8px;border:1px solid #333;background:#222;color:white;">
            </div>
        </div>
    `;

    modal.classList.remove('hidden');

    if (driver.licenseUrl)      loadDocThumbnail(userId, 'license',       'thumb-license');
    else document.getElementById('thumb-license').innerHTML = '<div class="doc-thumb missing"><i class="fas fa-minus"></i></div>';
    if (driver.idCardUrl)       loadDocThumbnail(userId, 'id_card',       'thumb-id');
    else document.getElementById('thumb-id').innerHTML = '<div class="doc-thumb missing"><i class="fas fa-minus"></i></div>';
    if (driver.vehiclePaperUrl) loadDocThumbnail(userId, 'vehicle_paper', 'thumb-vehicle');
    else document.getElementById('thumb-vehicle').innerHTML = '<div class="doc-thumb missing"><i class="fas fa-minus"></i></div>';
    if (driver.photoUrl)        loadDocThumbnail(userId, 'photo',         'thumb-photo');
    else document.getElementById('thumb-photo').innerHTML = '<div class="doc-thumb missing"><i class="fas fa-minus"></i></div>';

    // Enable/disable action buttons based on current status
    document.getElementById('btn-approve').disabled   = !isPendingReview;
    document.getElementById('btn-approve').style.opacity = isPendingReview ? '1' : '0.4';
    document.getElementById('btn-reject').disabled    = !isPendingReview;
    document.getElementById('btn-reject').style.opacity  = isPendingReview ? '1' : '0.4';
    document.getElementById('btn-suspend').disabled   = isSuspended || driver.status === 'pending_documents';
    document.getElementById('btn-suspend').style.opacity = (isSuspended || driver.status === 'pending_documents') ? '0.4' : '1';
    document.getElementById('btn-activate').style.display = isSuspended ? 'inline-block' : 'none';
};

// Full-screen click-to-enlarge for KYC document/selfie thumbnails.
// Uses an in-page overlay (not window.open) so popup blockers can't hide it.
window.openKycLightbox = function(url) {
    let lb = document.getElementById('kyc-lightbox');
    if (!lb) {
        lb = document.createElement('div');
        lb.id = 'kyc-lightbox';
        lb.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.92);display:flex;align-items:center;justify-content:center;z-index:99999;cursor:zoom-out;';
        lb.onclick = () => { lb.style.display = 'none'; };
        document.body.appendChild(lb);
    }
    lb.innerHTML = `<img src="${url}" style="max-width:92vw;max-height:92vh;border-radius:8px;box-shadow:0 0 40px rgba(0,0,0,0.85);">`;
    lb.style.display = 'flex';
};

async function loadDocThumbnail(userId, docType, containerId) {
    const container = document.getElementById(containerId);
    try {
        const res = await fetch(`${API_BASE}/drivers/${userId}/documents/${docType}`, {
            headers: { 'x-admin-key': ADMIN_KEY }
        });
        if (!res.ok) throw new Error('Not found');
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        activeDocUrls.push(url);
        container.innerHTML = `<img src="${url}" class="doc-thumb" style="cursor:zoom-in;" title="Click to enlarge" onclick="openKycLightbox('${url}')">`;
        container.classList.remove('loading');
    } catch {
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
                    <button id="btn-approve"  class="btn-primary">Approve</button>
                    <button id="btn-reject"   class="btn-danger">Reject</button>
                    <button id="btn-suspend"  class="btn-danger" style="background:#ff8800;">Suspend</button>
                    <button id="btn-activate" class="btn-primary" style="background:#009900;display:none;">Activate</button>
                    <button id="btn-close"    class="btn-secondary">Close</button>
                </div>
            </div>
        `;
        document.body.appendChild(modal);

        document.getElementById('btn-approve').onclick = async () => {
            if (!selectedDriverId) return;
            await adminFetch(`/drivers/${selectedDriverId}/approve`, 'POST');
            showToast('Driver approved', 'success');
            closeModal();
            fetchPendingDrivers();
        };

        document.getElementById('btn-reject').onclick = async () => {
            if (!selectedDriverId) return;
            const reason = document.getElementById('reject-reason').value.trim();
            if (!reason) { showToast('Rejection reason required', 'error'); return; }
            await adminFetch(`/drivers/${selectedDriverId}/reject`, 'POST', { reason });
            showToast('Driver rejected', 'success');
            closeModal();
            fetchPendingDrivers();
        };

        document.getElementById('btn-suspend').onclick = async () => {
            if (!selectedDriverId) return;
            const reason = document.getElementById('reject-reason').value.trim() || 'Policy violation';
            if (!confirm(`Suspend driver ${selectedDriverId}? Reason: "${reason}"`)) return;
            await adminFetch(`/drivers/${selectedDriverId}/suspend`, 'POST', { reason });
            showToast('Driver suspended', 'success');
            closeModal();
            fetchPendingDrivers();
        };

        document.getElementById('btn-activate').onclick = async () => {
            if (!selectedDriverId) return;
            if (!confirm(`Re-activate driver ${selectedDriverId}?`)) return;
            await adminFetch(`/drivers/${selectedDriverId}/activate`, 'POST');
            showToast('Driver activated', 'success');
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
    activeDocUrls.forEach(url => URL.revokeObjectURL(url));
    activeDocUrls = [];
}

// --- WebSocket ---
function updateApiStatus(online) {
    const el = document.getElementById('api-status');
    if (!el) return;
    online ? el.classList.add('online') : el.classList.remove('online');
}

function setupSocket() {
    const WS_BASE = (() => {
      const host = window.location.hostname;
      if (host === 'localhost' || host === '127.0.0.1') {
        return ADMIN_ENV === 'staging'
          ? 'http://localhost:3000'
          : 'http://localhost:4000';
      }
      return ADMIN_ENV === 'staging'
        ? 'https://staging.kekeride.ng'
        : 'https://api.kekeride.ng';
    })();
    const socket = io(WS_BASE);

    socket.on('connect', () => {
        socket.emit('join', { userId: 'dashboard', role: 'admin' });
        updateApiStatus(true);
    });
    socket.on('disconnect', () => updateApiStatus(false));
    socket.on('reconnect',  () => { updateApiStatus(true); init(); });

    socket.on('ride:status_update', () => {
        if (currentSection === 'active-rides' || currentSection === 'overview') {
            fetchActiveRides();
            refreshOverview();
        }
    });
    socket.on('ride:payment_failed', () => {
        showToast('⚠️ Payment failed on a ride — check Active Rides', 'error');
        if (currentSection === 'active-rides') fetchActiveRides();
    });
    socket.on('ride:request',  () => { if (currentSection === 'active-rides') fetchActiveRides(); });
    socket.on('ride:assigned', () => { if (currentSection === 'active-rides') fetchActiveRides(); });

    socket.on('driver:location_update', (data) => {
        if (activeTrackingMarker && activeTrackingMap) {
            const newLatLng = [data.lat, data.lng];
            activeTrackingMarker.setLatLng(newLatLng);
            activeTrackingMap.setView(newLatLng);
        }
    });

    socket.on('admin:sos_alert', (data) => {
        showToast(`🚨 CRITICAL: SOS ALERT from Ride ${data.rideId}`, 'error');
        const banner = document.getElementById('global-sos-banner');
        if (banner) banner.classList.remove('hidden');
        const siren = document.getElementById('sos-siren');
        if (siren) siren.play().catch(() => {});
        if (currentSection === 'sos-alerts') fetchSosAlerts();
    });
}

async function fetchSettings() {
    try {
        const config = await adminFetch('/settings');
        document.getElementById('setting-base-fare').value = config.baseFare;
        document.getElementById('setting-per-km').value = config.perKmRate;
        document.getElementById('setting-platform-fee').value = config.platformFeePercent;
    } catch (err) {
        console.error(err);
    }
}

function setupSettingsForm() {
    const form = document.getElementById('settings-form');
    if (form) {
        form.onsubmit = async (e) => {
            e.preventDefault();
            const baseFare = Number(document.getElementById('setting-base-fare').value);
            const perKmRate = Number(document.getElementById('setting-per-km').value);
            const platformFeePercent = Number(document.getElementById('setting-platform-fee').value);

            const btn = form.querySelector('button[type="submit"]');
            const originalHtml = btn ? btn.innerHTML : null;
            if (btn) {
                btn.disabled = true;
                btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> <span>Saving...</span>';
            }

            try {
                await adminFetch('/settings', 'POST', { baseFare, perKmRate, platformFeePercent });
                showToast('Pricing settings saved successfully', 'success');
            } catch (err) {
                console.error(err);
                showToast(err.message && err.message !== 'Rate Limited' ? `Save failed: ${err.message}` : 'Failed to save settings', 'error');
            } finally {
                if (btn) {
                    btn.disabled = false;
                    btn.innerHTML = originalHtml;
                }
            }
        };
    }
}

document.addEventListener('DOMContentLoaded', () => {
    captureElements();

    const closeTrackingBtn = document.getElementById('close-tracking-modal');
    if (closeTrackingBtn) {
        closeTrackingBtn.onclick = () => {
            document.getElementById('live-tracking-modal').classList.add('hidden');
            if (activeTrackingMap) {
                activeTrackingMap.remove();
                activeTrackingMap = null;
                activeTrackingMarker = null;
            }
        };
    }
    init();
});
