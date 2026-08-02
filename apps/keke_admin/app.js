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

// --- Staff identity ---
// A staff session takes precedence over the legacy shared key everywhere. The
// key path survives only so an operator is never locked out mid-migration; see
// docs/admin_auth_migration.md.
let STAFF_TOKEN   = sessionStorage.getItem('KEKE_STAFF_TOKEN') || '';
let STAFF_REFRESH = sessionStorage.getItem('KEKE_STAFF_REFRESH') || '';
let STAFF_ME = null;              // { id, firstName, lastName, roles, ... }
let STAFF_PERMISSIONS = new Set();

/** The base URL for non-admin API calls (staff auth lives outside /admin). */
const API_ROOT = API_BASE.replace(/\/admin$/, '');

function isStaffSession() { return !!STAFF_TOKEN; }

/** Whether the signed-in actor holds a permission. Legacy keys hold very few. */
function can(permission) { return STAFF_PERMISSIONS.has(permission); }

/**
 * Hide every control the current actor cannot use.
 *
 * Presentational only — the server denies the same actions independently. A
 * hidden button is a courtesy, never a security boundary.
 */
function applyPermissionGating() {
    document.querySelectorAll('[data-requires-permission]').forEach(el => {
        const needed = el.getAttribute('data-requires-permission');
        el.classList.toggle('hidden', !can(needed));
    });
}

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
    if (!ADMIN_KEY && !STAFF_TOKEN) { showLoginScreen(); return; }

    // Resolve who we are before rendering anything, so the navigation and the
    // action buttons reflect real authority rather than being drawn and then
    // retracted.
    if (STAFF_TOKEN) {
        const ok = await loadStaffIdentity();
        if (!ok) { showLoginScreen(); return; }
    } else {
        // Legacy key: the four monitoring permissions and nothing else.
        STAFF_PERMISSIONS = new Set(['monitor:read', 'metrics:read', 'admin:write', 'monitor:reveal_contact']);
    }

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
    setupStaffListeners();
    setupParkListeners();
    applyPermissionGating();
    renderActorBadge();

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
    stopLiveRefresh(); // leaving any section halts the Live Riders poll
    if (typeof stopLiveRequestsStream === 'function') stopLiveRequestsStream();
    if (sectionTitle) sectionTitle.innerText = id.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());

    if (id === 'drivers')       { fetchPendingDrivers(); fetchIncompleteDrivers(); }
    if (id === 'approved-drivers') fetchApprovedDrivers();
    if (id === 'active-rides')  fetchActiveRides();
    if (id === 'held-rides')    fetchHeldRides();
    if (id === 'finance')       { fetchFinanceSummary(); fetchDebtLeaderboard(); }
    if (id === 'payouts')       fetchPayouts();
    if (id === 'history')       fetchRideHistory();
    if (id === 'live-riders')   { fetchLiveRiders(); toggleLiveAutoRefresh(); }
    if (id === 'live-requests')  enterLiveRequests();
    if (id === 'driver-dispatch-metrics') fetchDispatchMetrics();
    if (id === 'sos-alerts')    fetchSosAlerts();
    if (id === 'audit-log')     fetchAuditLog();
    if (id === 'parks')         fetchParks();
    if (id === 'park-dispatch') fetchParkDispatch();
    if (id === 'badges')        fetchBadges();
    if (id === 'staff')         fetchStaffList();
    if (id === 'role-matrix')   fetchRoleMatrix();
    if (id === 'staff-audit')   fetchStaffAudit();
    if (id === 'settings')      fetchSettings();
}

// --- Auth ---
function showLoginScreen() {
    document.body.classList.add('auth-loading');
    document.body.classList.remove('authenticated');

    const envSelect = document.getElementById('admin-env-select');
    if (envSelect) envSelect.value = ADMIN_ENV;

    // --- Mode tabs: staff account (primary) vs legacy key (fallback) ---
    const staffTab   = document.getElementById('tab-staff-login');
    const legacyTab  = document.getElementById('tab-legacy-login');
    const staffForm  = document.getElementById('staff-login-form');
    const legacyForm = document.getElementById('login-form');
    const subtitle   = document.getElementById('login-subtitle');

    function selectMode(mode) {
        const staff = mode === 'staff';
        staffTab?.classList.toggle('active', staff);
        legacyTab?.classList.toggle('active', !staff);
        staffForm?.classList.toggle('hidden', !staff);
        legacyForm?.classList.toggle('hidden', staff);
        if (subtitle) {
            subtitle.innerText = staff
                ? 'Sign in with your KekeRide staff account.'
                : 'Legacy shared key — limited access, not attributed to you.';
        }
    }
    staffTab?.addEventListener('click', () => selectMode('staff'));
    legacyTab?.addEventListener('click', () => selectMode('legacy'));
    selectMode('staff');

    function apiRootForEnv(env) {
        const host = window.location.hostname;
        if (host === 'localhost' || host === '127.0.0.1') {
            return env === 'staging' ? 'http://localhost:3000/api/v1' : 'http://localhost:4000/api/v1';
        }
        return env === 'staging' ? 'https://staging.kekeride.ng/api/v1' : 'https://api.kekeride.ng/api/v1';
    }

    // --- Staff sign-in ---
    if (staffForm) {
        staffForm.onsubmit = async (e) => {
            e.preventDefault();
            const email = document.getElementById('staff-email-input').value.trim();
            const password = document.getElementById('staff-password-input').value;
            const env = envSelect ? envSelect.value : 'production';
            const btn = document.getElementById('btn-staff-login');
            if (!email || !password) return;

            btn.disabled = true;
            btn.querySelector('.btn-spinner').classList.remove('hidden');
            try {
                const res = await fetch(`${apiRootForEnv(env)}/staff/auth/login`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ email, password }),
                });
                const data = await res.json().catch(() => ({}));
                if (res.ok && data.accessToken) {
                    sessionStorage.setItem('KEKE_STAFF_TOKEN', data.accessToken);
                    sessionStorage.setItem('KEKE_STAFF_REFRESH', data.refreshToken || '');
                    sessionStorage.setItem('KEKE_ADMIN_ENV', env);
                    // A staff session supersedes any stored shared key on this
                    // workstation — two credentials in one browser is how an
                    // action ends up attributed to the wrong one.
                    sessionStorage.removeItem('KEKE_ADMIN_KEY');
                    showToast('Signed in', 'success');
                    location.reload();
                } else {
                    // The server returns one message for every credential
                    // failure; do not embellish it here.
                    showToast(data.message || 'Incorrect email or password.', 'error');
                }
            } catch {
                showToast('Connection failed', 'error');
            } finally {
                btn.disabled = false;
                btn.querySelector('.btn-spinner').classList.add('hidden');
            }
        };
    }

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
    // End the session server-side first so the refresh token dies with it —
    // clearing sessionStorage alone would leave a usable credential behind.
    if (isStaffSession()) {
        fetch(`${API_ROOT}/staff/auth/logout`, {
            method: 'POST',
            headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        }).catch(() => {}).finally(() => {
            sessionStorage.removeItem('KEKE_STAFF_TOKEN');
            sessionStorage.removeItem('KEKE_STAFF_REFRESH');
            sessionStorage.removeItem('KEKE_ADMIN_KEY');
            location.reload();
        });
        return;
    }
    sessionStorage.removeItem('KEKE_ADMIN_KEY');
    location.reload();
}

/** Exchange the refresh token for a new access token. Returns true on success. */
async function tryRefreshStaffSession() {
    if (!STAFF_REFRESH) return false;
    try {
        const res = await fetch(`${API_ROOT}/staff/auth/refresh`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ refreshToken: STAFF_REFRESH }),
        });
        if (!res.ok) return false;
        const data = await res.json();
        STAFF_TOKEN = data.accessToken;
        STAFF_REFRESH = data.refreshToken;
        sessionStorage.setItem('KEKE_STAFF_TOKEN', STAFF_TOKEN);
        sessionStorage.setItem('KEKE_STAFF_REFRESH', STAFF_REFRESH);
        return true;
    } catch {
        return false;
    }
}

function handleStaffSessionExpired() {
    sessionStorage.removeItem('KEKE_STAFF_TOKEN');
    sessionStorage.removeItem('KEKE_STAFF_REFRESH');
    showToast('Your session has expired. Please sign in again.', 'error');
    setTimeout(() => location.reload(), 1200);
}

/** Load the signed-in staff member and their effective permissions. */
async function loadStaffIdentity() {
    try {
        let res = await fetch(`${API_ROOT}/staff/auth/me`, { headers: authHeaders() });
        if (res.status === 401 && await tryRefreshStaffSession()) {
            res = await fetch(`${API_ROOT}/staff/auth/me`, { headers: authHeaders() });
        }
        if (!res.ok) return false;
        const data = await res.json();
        STAFF_ME = data.staff;
        STAFF_PERMISSIONS = new Set(data.permissions || []);
        return true;
    } catch {
        return false;
    }
}

/** Show who is signed in, and make a legacy session impossible to miss. */
function renderActorBadge() {
    const holder = document.querySelector('.admin-profile span:last-child');
    if (!holder) return;
    if (STAFF_ME) {
        holder.innerHTML = `${escapeHtml(STAFF_ME.firstName)} ${escapeHtml(STAFF_ME.lastName)}
            <small class="actor-roles">${escapeHtml((STAFF_ME.roles || []).join(', '))}</small>`;
    } else {
        holder.innerHTML = `<span class="legacy-actor-chip" title="Actions are recorded as SYSTEM_LEGACY_ADMIN">
            <i class="fas fa-triangle-exclamation"></i> Legacy shared key</span>`;
    }
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
/** Auth header for the current actor: staff bearer token, else the legacy key. */
function authHeaders() {
    return isStaffSession()
        ? { 'Authorization': `Bearer ${STAFF_TOKEN}` }
        : { 'x-admin-key': ADMIN_KEY };
}

async function adminFetch(endpoint, method = 'GET', body = null) {
    try {
        const options = {
            method,
            headers: { ...authHeaders(), 'Content-Type': 'application/json' },
            body: body ? JSON.stringify(body) : null
        };
        const res = await fetch(`${API_BASE}${endpoint}`, options);

        // A staff access token is short-lived. One transparent refresh-and-retry
        // keeps a working session from dumping somebody back to the login screen
        // mid-task; a second failure is a genuinely dead session.
        if (res.status === 401 && isStaffSession() && !endpoint.startsWith('/__retry')) {
            const refreshed = await tryRefreshStaffSession();
            if (refreshed) {
                const retry = await fetch(`${API_BASE}${endpoint}`, {
                    ...options,
                    headers: { ...authHeaders(), 'Content-Type': 'application/json' },
                });
                if (retry.ok) return await retry.json();
            }
            handleStaffSessionExpired();
            throw new Error('Session expired');
        }

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

async function fetchApprovedDrivers() {
    const list = document.getElementById('approved-drivers-list');
    if (!list) return;
    list.innerHTML = '<tr><td colspan="5">Loading…</td></tr>';
    const drivers = await adminFetch('/drivers/all?status=approved');
    list.innerHTML = drivers.map(d => {
        const rating = (d.ratingCount || 0) > 0
            ? `⭐ ${(d.ratingSum / d.ratingCount).toFixed(2)} (${d.ratingCount})`
            : '—';
        return `
        <tr>
            <td>${escapeHtml(d.firstName)} ${escapeHtml(d.lastName)}</td>
            <td>${escapeHtml(d.vehicleModel)} (${escapeHtml(d.vehiclePlate)})</td>
            <td>${rating}</td>
            <td>${new Date(d.updatedAt || d.createdAt).toLocaleDateString()}</td>
            <td><button class="btn-secondary" onclick="reviewDriver('${escapeHtml(d.userId)}')">Inspect / Fix Docs</button></td>
        </tr>`;
    }).join('');
    if (!drivers.length) list.innerHTML = '<tr><td colspan="5">No approved drivers yet.</td></tr>';
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

// --- Held / Flagged rides review ---
function fmtM(v) { return (v === null || v === undefined) ? '—' : Math.round(Number(v)) + ' m'; }
function fmtS(v) { return (v === null || v === undefined) ? '—' : Math.round(Number(v)) + ' s'; }

async function fetchHeldRides() {
    const list = document.getElementById('held-rides-list');
    if (list) list.innerHTML = '<p class="muted">Loading…</p>';
    const rides = (await adminFetch('/rides/flagged')) || [];
    const held = rides.filter(r => r.paymentHeld);
    if (!list) return;
    if (!held.length) { list.innerHTML = '<p class="muted">No rides are currently held for review. 🎉</p>'; return; }

    list.innerHTML = held.map(r => {
        const consent = r.passengerConsentedEnd
            ? '<span class="pill pill-ok">Passenger confirmed</span>'
            : (r.earlyEndRequestedByDriver
                ? '<span class="pill pill-warn">Driver requested — not confirmed</span>'
                : '');
        const early = r.endedEarlyByPassenger ? '<span class="pill pill-info">Passenger ended early</span>' : '';
        const consentAt = r.passengerConsentAt ? new Date(r.passengerConsentAt).toLocaleString() : null;
        return `
        <div class="held-card">
            <div class="held-card-head">
                <strong>${escapeHtml(r.rideId)}</strong>
                <span class="pill pill-held">PAYMENT HELD</span>
            </div>
            <div class="held-pills">${consent}${early}</div>
            <div class="held-reason">Reason: <b>${escapeHtml(r.reviewReason || r.suspiciousReason || 'flagged')}</b></div>
            <div class="held-metrics">
                <div><span>Moved</span><b>${fmtM(r.movementDistanceM)}</b></div>
                <div><span>Duration</span><b>${fmtS(r.tripDurationSec)}</b></div>
                <div><span>From dest</span><b>${fmtM(r.endDestinationDistanceM)}</b></div>
                <div><span>Fare</span><b>₦${Number(r.finalFare ?? r.fare).toLocaleString()}</b></div>
            </div>
            <div class="held-meta">
                <span>${escapeHtml((r.paymentMode || 'cash').toUpperCase())}</span>
                ${consentAt ? `<span>Consent: ${escapeHtml(consentAt)}</span>` : ''}
            </div>
            <div class="held-actions">
                <button class="btn-primary" onclick="releaseRide('${escapeHtml(r.rideId)}')">Release payment</button>
                <button class="btn-danger" onclick="voidRide('${escapeHtml(r.rideId)}')">Void (no charge)</button>
            </div>
        </div>`;
    }).join('');
}

window.releaseRide = async function(rideId) {
    if (!confirm(`Release payment for ${rideId}? This settles the driver/passenger for the full fare.`)) return;
    try {
        await adminFetch(`/rides/${rideId}/release`, 'POST');
        fetchHeldRides();
    } catch (e) { alert('Release failed: ' + (e?.message || 'error')); }
};

window.voidRide = async function(rideId) {
    if (!confirm(`Void ${rideId}? The ride is dismissed with NO charge to the passenger and NO payout to the driver.`)) return;
    try {
        await adminFetch(`/rides/${rideId}/void`, 'POST');
        fetchHeldRides();
    } catch (e) { alert('Void failed: ' + (e?.message || 'error')); }
};

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

// ===================== Live Riders (real-time driver monitoring) =====================
let liveRidersData = null;
let liveRefreshTimer = null;
let liveGeocoding = false;

function stopLiveRefresh() {
    if (liveRefreshTimer) { clearInterval(liveRefreshTimer); liveRefreshTimer = null; }
}

function toggleLiveAutoRefresh() {
    stopLiveRefresh();
    const box = document.getElementById('live-autorefresh');
    if (box && box.checked) liveRefreshTimer = setInterval(() => fetchLiveRiders().catch(() => {}), 6000);
}

function liveStatusMeta(s) {
    switch (s) {
        case 'ACTIVELY_ONLINE': return { label: 'Actively Online', cls: 'ls-online' };
        case 'ON_TRIP':         return { label: 'On Trip',         cls: 'ls-ontrip' };
        case 'RECENTLY_SEEN':   return { label: 'Recently Seen',   cls: 'ls-recent' };
        case 'STALE_HEARTBEAT': return { label: 'Stale Heartbeat', cls: 'ls-stale' };
        case 'OFFLINE':         return { label: 'Offline',         cls: 'ls-offline' };
        default:                return { label: 'Never Online',    cls: 'ls-offline' };
    }
}

function liveAgeText(sec) {
    if (sec == null) return '—';
    if (sec < 60) return sec + 's ago';
    const m = Math.floor(sec / 60);
    if (m < 60) return m + 'm ago';
    return Math.floor(m / 60) + 'h ' + (m % 60) + 'm ago';
}

async function fetchLiveRiders() {
    const data = await adminFetch('/drivers/live');
    liveRidersData = data;
    const u = document.getElementById('live-updated');
    if (u) u.innerText = 'Updated ' + new Date().toLocaleTimeString();
    renderLiveRiders();
}

function liveRiderMatches(r, f) {
    switch (f) {
        case 'online':        return r.isActivelyOnline;
        case 'on_trip':       return r.liveStatus === 'ON_TRIP';
        case 'available':     return r.rideState === 'available';
        case 'recently':      return r.liveStatus === 'RECENTLY_SEEN';
        case 'stale':         return r.liveStatus === 'STALE_HEARTBEAT';
        case 'offline':       return r.liveStatus === 'OFFLINE' || r.liveStatus === 'NEVER_SEEN';
        case 'missing_token': return r.fcmTokenStatus === 'missing';
        case 'android':       return r.platform === 'android';
        case 'ios':           return r.platform === 'ios';
        default:              return true;
    }
}

function renderLiveRiders() {
    if (!liveRidersData) return;
    const f = (document.getElementById('live-filter') || {}).value || 'all';
    const q = ((document.getElementById('live-search') || {}).value || '').toLowerCase().trim();

    const c = liveRidersData.counts || {};
    const stats = document.getElementById('live-stats');
    if (stats) stats.innerHTML = `
        <span class="chip chip-online">${c.activelyOnline || 0} Actively Online</span>
        <span class="chip chip-trip">${c.onTrip || 0} On Trip</span>
        <span class="chip chip-recent">${c.recentlySeen || 0} Recently Seen</span>
        <span class="chip chip-stale">${c.stale || 0} Stale</span>
        <span class="chip chip-offline">${c.offline || 0} Offline</span>
        <span class="chip chip-warn">${c.missingToken || 0} No Push Token</span>`;

    const visible = liveRidersData.drivers.filter(r =>
        liveRiderMatches(r, f) &&
        (!q || (r.name || '').toLowerCase().includes(q) || (r.phone || '').toLowerCase().includes(q) || (r.email || '').toLowerCase().includes(q))
    );

    const groups = [
        { title: 'Actively Online Riders',        test: r => r.isActivelyOnline },
        { title: 'Recently Seen / Stale Riders',  test: r => r.liveStatus === 'RECENTLY_SEEN' || r.liveStatus === 'STALE_HEARTBEAT' },
        { title: 'Offline Approved Riders',       test: r => r.liveStatus === 'OFFLINE' || r.liveStatus === 'NEVER_SEEN' },
    ];

    const container = document.getElementById('live-groups');
    if (!container) return;
    container.innerHTML = groups.map(g => {
        const rows = visible.filter(g.test);
        return `<div class="live-group">
            <h3>${g.title} <span class="live-group-count">${rows.length}</span></h3>
            <div class="table-container"><table>
                <thead><tr>
                    <th>Driver</th><th>Contact</th><th>Status</th><th>Last Heartbeat</th>
                    <th>Location</th><th>Ride</th><th>Push</th><th>Actions</th>
                </tr></thead>
                <tbody>${rows.length ? rows.map(renderLiveRiderRow).join('') : '<tr><td colspan="8" class="muted">None</td></tr>'}</tbody>
            </table></div>
        </div>`;
    }).join('');

    lazyGeocodeLiveRows();
}

function renderLiveRiderRow(r) {
    const m = liveStatusMeta(r.liveStatus);
    const hasCoords = r.latitude != null && r.longitude != null;
    const coords = hasCoords ? `${r.latitude.toFixed(5)}, ${r.longitude.toFixed(5)}` : '—';
    const addrCell = hasCoords ? `<div class="addr muted" data-lat="${r.latitude}" data-lng="${r.longitude}">resolving…</div>` : '';
    const mapBtn = hasCoords ? `<a class="btn-mini" href="https://www.google.com/maps?q=${r.latitude},${r.longitude}" target="_blank" rel="noopener">Map</a>` : '';
    const callBtn = r.phone ? `<a class="btn-mini" href="tel:${escapeHtml(r.phone)}">Call</a>` : '';
    const push = r.fcmTokenStatus === 'active'
        ? '<span class="badge badge-ok">Active</span>'
        : '<span class="badge badge-warn">Missing</span>';
    const ride = r.currentRideId
        ? `${escapeHtml(String(r.currentRideStatus || ''))}<br><small class="muted">${escapeHtml(r.currentRideId)}</small>`
        : escapeHtml(r.rideState || 'offline');
    const platform = r.platform && r.platform !== 'unknown' ? escapeHtml(r.platform) : 'unknown';
    return `<tr>
        <td><strong>${escapeHtml(r.name)}</strong><br><small class="muted">${platform}</small></td>
        <td>${escapeHtml(r.phone || '—')}<br><small class="muted">${escapeHtml(r.email || '')}</small></td>
        <td><span class="ls-badge ${m.cls}">${m.label}</span></td>
        <td>${liveAgeText(r.heartbeatAgeSeconds)}${r.lastHeartbeatAt ? `<br><small class="muted">${new Date(r.lastHeartbeatAt).toLocaleTimeString()}</small>` : ''}</td>
        <td>${coords}${addrCell}</td>
        <td>${ride}</td>
        <td>${push}</td>
        <td class="live-actions">${mapBtn} ${callBtn}</td>
    </tr>`;
}

// Reverse-geocode visible rows one at a time — cached hits fill instantly, cache
// misses are spaced ~1.1s to respect Nominatim's usage policy.
async function lazyGeocodeLiveRows() {
    if (liveGeocoding) return;
    liveGeocoding = true;
    try {
        const cells = Array.from(document.querySelectorAll('#live-groups .addr'));
        for (const cell of cells) {
            const lat = cell.getAttribute('data-lat');
            const lng = cell.getAttribute('data-lng');
            if (!lat || !lng) continue;
            const cached = addressCache[`${lat},${lng}`];
            if (cached) { cell.innerText = cached; continue; }
            const addr = await getHumanReadableAddress(lat, lng);
            cell.innerText = addr;
            await new Promise(res => setTimeout(res, 1100));
        }
    } catch { /* non-fatal */ } finally {
        liveGeocoding = false;
    }
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
                    <p><strong>Rating:</strong> ${(driver.ratingCount || 0) > 0 ? `<span style="color:#f5a623;"><i class="fas fa-star"></i> ${(driver.ratingSum / driver.ratingCount).toFixed(2)}</span> <span style="color:#888;">(${driver.ratingCount} review${driver.ratingCount === 1 ? '' : 's'})</span>` : '<em style="color:#888;">No ratings yet</em>'}</p>
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
                    ${docReplaceControl(userId, 'license')}
                </div>
                <div class="doc-item">
                    <div class="doc-thumb loading" id="thumb-id"></div>
                    <span>ID Card ${driver.idCardUrl ? '✅' : '❌'}</span>
                    ${docReplaceControl(userId, 'id_card')}
                </div>
                <div class="doc-item">
                    <div class="doc-thumb loading" id="thumb-vehicle"></div>
                    <span>Vehicle Paper ${driver.vehiclePaperUrl ? '✅' : '❌'}</span>
                    ${docReplaceControl(userId, 'vehicle_paper')}
                </div>
                <div class="doc-item">
                    <div class="doc-thumb loading" id="thumb-photo"></div>
                    <span>Driver Selfie ${driver.photoUrl ? '✅' : '❌'}</span>
                    ${docReplaceControl(userId, 'photo')}
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
    document.body.classList.add('modal-open'); // stop the page behind from scrolling

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

// Maps a docType to its thumbnail container id in the review modal.
const DOC_THUMB_IDS = {
    license: 'thumb-license',
    id_card: 'thumb-id',
    vehicle_paper: 'thumb-vehicle',
    photo: 'thumb-photo',
};

// Small "Replace" control rendered under each KYC document in the modal.
// Lets an admin upload a corrected file on the driver's behalf.
function docReplaceControl(userId, docType) {
    return `
        <label class="doc-replace" style="display:inline-block;margin-top:6px;padding:4px 10px;font-size:12px;
            background:#333;color:#ddd;border-radius:6px;cursor:pointer;">
            <i class="fas fa-upload"></i> Replace
            <input type="file" accept="image/jpeg,image/png" style="display:none;"
                onchange="uploadDriverDoc('${escapeHtml(userId)}','${escapeHtml(docType)}',this)">
        </label>`;
}

// Admin uploads/replaces a driver's KYC document. Does not change the driver's
// approval status server-side — it only swaps the file.
window.uploadDriverDoc = async function(userId, docType, input) {
    const file = input.files && input.files[0];
    if (!file) return;

    const thumbId = DOC_THUMB_IDS[docType];
    const container = thumbId ? document.getElementById(thumbId) : null;
    if (container) { container.innerHTML = ''; container.classList.add('loading'); }

    const fd = new FormData();
    fd.append('document', file);

    try {
        // Note: do NOT set Content-Type — the browser adds the multipart boundary.
        const res = await fetch(`${API_BASE}/drivers/${userId}/documents/${docType}`, {
            method: 'POST',
            headers: { 'x-admin-key': ADMIN_KEY },
            body: fd,
        });
        if (!res.ok) {
            const data = await res.json().catch(() => ({}));
            throw new Error(data.error || `HTTP ${res.status}`);
        }
        showToast('Document replaced successfully', 'success');
    } catch (e) {
        showToast('Upload failed: ' + (e.message || 'error'), 'error');
    } finally {
        input.value = '';
        if (thumbId) loadDocThumbnail(userId, docType, thumbId);
    }
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

        // Escape closes the enlarged image first (if open), otherwise the modal.
        document.addEventListener('keydown', (e) => {
            if (e.key !== 'Escape') return;
            const lb = document.getElementById('kyc-lightbox');
            if (lb && lb.style.display !== 'none') { lb.style.display = 'none'; return; }
            const m = document.getElementById('review-modal');
            if (m && !m.classList.contains('hidden')) closeModal();
        });
    }
    return modal;
}

function closeModal() {
    const modal = document.getElementById('review-modal');
    if (modal) modal.classList.add('hidden');
    document.body.classList.remove('modal-open'); // re-enable page scroll
    const lb = document.getElementById('kyc-lightbox');
    if (lb) lb.style.display = 'none';
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
        if (typeof setLiveRequestsStreamState === 'function') setLiveRequestsStreamState(true);
        // Re-sync the monitor after any gap: incremental events that arrived
        // while we were away were never delivered, so reconcile once.
        if (currentSection === 'live-requests' && typeof fetchLiveRequests === 'function') {
            fetchLiveRequests().catch(() => {});
        }
    });
    socket.on('disconnect', () => {
        updateApiStatus(false);
        if (typeof setLiveRequestsStreamState === 'function') setLiveRequestsStreamState(false);
    });
    socket.on('reconnect',  () => { updateApiStatus(true); init(); });

    // Live Ride Requests: apply pushed deltas instead of refetching the world.
    socket.on('admin:dispatch_event', (ev) => {
        if (typeof applyDispatchEvent === 'function') applyDispatchEvent(ev);
    });

    socket.on('ride:status_update', (payload) => {
        if (typeof applyRideStatusUpdate === 'function') applyRideStatusUpdate(payload);
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

// ═══════════════════════════════════════════════════════════════════════════
//  Staff Management
// ═══════════════════════════════════════════════════════════════════════════

const STAFF_ROLES = [
    'SUPER_ADMIN', 'OPERATIONS_ADMIN', 'PARK_SUPERVISOR',
    'PARK_DISPATCHER', 'CASHIER', 'SUPPORT_OFFICER', 'READ_ONLY_ANALYST',
];

let staffPage = 1;
let staffAuditPage = 1;

function setupStaffListeners() {
    const roleFilter = document.getElementById('staff-role-filter');
    if (roleFilter && roleFilter.options.length <= 1) {
        STAFF_ROLES.forEach(r => {
            const opt = document.createElement('option');
            opt.value = r; opt.textContent = r.replace(/_/g, ' ');
            roleFilter.appendChild(opt);
        });
    }

    let searchTimer = null;
    document.getElementById('staff-search')?.addEventListener('input', () => {
        clearTimeout(searchTimer);
        searchTimer = setTimeout(() => { staffPage = 1; fetchStaffList(); }, 350);
    });
    document.getElementById('staff-status-filter')?.addEventListener('change', () => { staffPage = 1; fetchStaffList(); });
    document.getElementById('staff-role-filter')?.addEventListener('change', () => { staffPage = 1; fetchStaffList(); });
    document.getElementById('btn-new-staff')?.addEventListener('click', openCreateStaffModal);

    document.getElementById('btn-audit-filter')?.addEventListener('click', () => { staffAuditPage = 1; fetchStaffAudit(); });
    document.getElementById('btn-audit-export')?.addEventListener('click', exportStaffAudit);
}

function statusChip(status) {
    const tone = {
        active: 'success', invited: 'info', locked: 'warn',
        suspended: 'error', deactivated: 'muted',
    }[status] || 'muted';
    return `<span class="chip chip-${tone}">${escapeHtml(status)}</span>`;
}

async function fetchStaffList() {
    if (!can('staff:read')) return;
    const params = new URLSearchParams({ page: String(staffPage), pageSize: '25' });
    const search = document.getElementById('staff-search')?.value.trim();
    const status = document.getElementById('staff-status-filter')?.value;
    const role   = document.getElementById('staff-role-filter')?.value;
    if (search) params.set('search', search);
    if (status) params.set('status', status);
    if (role)   params.set('role', role);

    try {
        const data = await adminFetch(`/staff?${params.toString()}`);
        renderStaffList(data);
    } catch { /* adminFetch has already surfaced the error */ }
}

function renderStaffList(data) {
    const list = document.getElementById('staff-list');
    if (!list) return;

    if (!data.items.length) {
        list.innerHTML = '<tr><td colspan="7">No staff accounts match these filters.</td></tr>';
        document.getElementById('staff-pager').innerHTML = '';
        return;
    }

    list.innerHTML = data.items.map(s => `
        <tr>
            <td>${escapeHtml(s.firstName)} ${escapeHtml(s.lastName)}</td>
            <td>${escapeHtml(s.email)}</td>
            <td style="font-family:monospace;">${escapeHtml(s.phone || '—')}</td>
            <td>${s.roles.map(r => `<span class="chip chip-role">${escapeHtml(r.replace(/_/g, ' '))}</span>`).join(' ') || '—'}</td>
            <td>${statusChip(s.status)}</td>
            <td>${s.lastLoginAt ? new Date(s.lastLoginAt).toLocaleString() : 'never'}</td>
            <td>
                <button class="btn-small" onclick="openStaffDetail('${escapeHtml(s.id)}')">Open</button>
            </td>
        </tr>
    `).join('');

    const pages = Math.max(1, Math.ceil(data.total / data.pageSize));
    document.getElementById('staff-pager').innerHTML = `
        <button class="btn-small" ${data.page <= 1 ? 'disabled' : ''} onclick="changeStaffPage(-1)">Previous</button>
        <span>Page ${data.page} of ${pages} · ${data.total} accounts</span>
        <button class="btn-small" ${data.page >= pages ? 'disabled' : ''} onclick="changeStaffPage(1)">Next</button>`;
}

function changeStaffPage(delta) {
    staffPage = Math.max(1, staffPage + delta);
    fetchStaffList();
}

function closeStaffModal() {
    document.getElementById('staff-modal')?.remove();
}

function staffModalShell(title, innerHtml) {
    closeStaffModal();
    const el = document.createElement('div');
    el.id = 'staff-modal';
    el.className = 'modal-overlay';
    el.innerHTML = `
        <div class="modal-card">
            <div class="modal-head">
                <h3>${escapeHtml(title)}</h3>
                <button class="btn-small" onclick="closeStaffModal()">✕</button>
            </div>
            <div class="modal-body">${innerHtml}</div>
        </div>`;
    document.body.appendChild(el);
    return el;
}

function openCreateStaffModal() {
    if (!can('staff:create')) return;
    staffModalShell('New staff member', `
        <form id="create-staff-form" class="stack">
            <label>First name <input id="cs-first" required></label>
            <label>Last name <input id="cs-last" required></label>
            <label>Email <input id="cs-email" type="email" required></label>
            <label>Phone <input id="cs-phone" required placeholder="08012345678"></label>
            <fieldset class="roles-field">
                <legend>Roles</legend>
                ${STAFF_ROLES.map(r => `
                    <label class="check"><input type="checkbox" value="${r}" name="cs-role"> ${escapeHtml(r.replace(/_/g, ' '))}</label>
                `).join('')}
            </fieldset>
            <p class="section-note">
                No password is set here. The account is created in <strong>INVITED</strong>
                state and a single-use setup link is shown once, on the next screen.
            </p>
            <button type="submit" class="btn-primary full-width">Create account</button>
        </form>`);

    document.getElementById('create-staff-form').onsubmit = async (e) => {
        e.preventDefault();
        const roles = [...document.querySelectorAll('input[name="cs-role"]:checked')].map(i => i.value);
        if (!roles.length) return showToast('Select at least one role', 'error');
        try {
            const result = await adminFetch('/staff', 'POST', {
                firstName: document.getElementById('cs-first').value.trim(),
                lastName:  document.getElementById('cs-last').value.trim(),
                email:     document.getElementById('cs-email').value.trim(),
                phone:     document.getElementById('cs-phone').value.trim(),
                roles,
            });
            showSetupTokenModal(result);
            fetchStaffList();
        } catch { /* surfaced by adminFetch */ }
    };
}

/**
 * Copy the contents of an element, whether it holds them in `value` or as text.
 *
 * Clipboard access can be refused — an insecure origin, or a browser that wants
 * a fresher user gesture than it thinks it got. Say so instead of failing
 * silently, because the thing on screen is shown once and somebody who believes
 * they copied it will close the dialog.
 */
function copyFrom(id, message) {
    const el = document.getElementById(id);
    if (!el) return;
    const text = el.value !== undefined ? el.value : el.innerText;
    navigator.clipboard.writeText(text)
        .then(() => showToast(message, 'success'))
        .catch(() => showToast('Could not copy — select the text and copy it by hand', 'error'));
}

/**
 * Shown once, after an account is created or its credentials are reset.
 *
 * ── Why a link and not the bare token ───────────────────────────────────
 * The server returns both. An earlier version of this dialog showed only the
 * token, which left whoever created the account holding a random string and no
 * way to tell the recipient what to do with it — there was no page to type it
 * into until `activate.html` existed. The link is that page, already addressed.
 *
 * The ready-to-send message is visible rather than hidden behind the button so
 * that whoever is about to paste it into WhatsApp can read what they are
 * sending first.
 */
function showSetupTokenModal(result) {
    const staff = result.staff;
    const link = result.activationLink || '';
    const message = `${result.activationInstructions || ''}\n\n${link}`;

    staffModalShell('Account created', `
        <p>
            <strong>${escapeHtml(staff.firstName)} ${escapeHtml(staff.lastName)}</strong>
            now has an account, in <strong>INVITED</strong> state.
            No password has been set — and you will not be setting one.
        </p>

        <p class="section-note">
            Send this link to ${escapeHtml(staff.email)}. They open it once and choose
            their own password. Nobody else ever learns it, including you.
            It is shown <strong>once</strong>; if it is lost, reissue it from this
            person's page rather than trying to recover it.
        </p>

        <pre class="token-box" id="setup-link-box">${escapeHtml(link)}</pre>
        <p class="section-note">Expires ${new Date(result.setupTokenExpiresAt).toLocaleString()}</p>

        <label>Message to send
            <textarea id="setup-message-box" rows="4" readonly>${escapeHtml(message)}</textarea>
        </label>

        <div class="modal-actions">
            <button class="btn-primary" onclick="copyFrom('setup-link-box','Link copied')">Copy link</button>
            <button class="btn-secondary" onclick="copyFrom('setup-message-box','Message copied')">Copy whole message</button>
        </div>

        <details class="section-note">
            <summary>Raw token — only if you are building the URL yourself</summary>
            <pre class="token-box" id="setup-token-box">${escapeHtml(result.setupToken)}</pre>
        </details>

        <button class="btn-primary full-width" onclick="closeStaffModal()">Done</button>`);
}

async function openStaffDetail(id) {
    try {
        const data = await adminFetch(`/staff/${id}`);
        const s = data.staff;
        const canManage = can('staff:suspend');
        const canRoles  = can('staff:assign_roles');
        const canReset  = can('staff:reset_credentials');

        staffModalShell(`${s.firstName} ${s.lastName}`, `
            <div class="detail-grid">
                <div><span>Status</span>${statusChip(s.status)}</div>
                <div><span>Email</span>${escapeHtml(s.email)}</div>
                <div><span>Phone</span>${escapeHtml(s.phone || '—')}</div>
                <div><span>Last login</span>${s.lastLoginAt ? new Date(s.lastLoginAt).toLocaleString() : 'never'}</div>
                <div><span>Password changed</span>${s.lastPasswordChangeAt ? new Date(s.lastPasswordChangeAt).toLocaleString() : '—'}</div>
                <div><span>MFA</span>${s.mfaEnabled ? 'Enabled' : 'Not enrolled'}</div>
                ${s.suspensionReason ? `<div><span>Suspension reason</span>${escapeHtml(s.suspensionReason)}</div>` : ''}
            </div>

            <h4>Roles</h4>
            <fieldset class="roles-field" ${canRoles ? '' : 'disabled'}>
                ${STAFF_ROLES.map(r => `
                    <label class="check">
                        <input type="checkbox" name="sd-role" value="${r}" ${s.roles.includes(r) ? 'checked' : ''}>
                        ${escapeHtml(r.replace(/_/g, ' '))}
                    </label>`).join('')}
            </fieldset>
            ${canRoles ? `
                <label>Reason (required when removing a role)
                    <input id="sd-role-reason" placeholder="Why is this changing?">
                </label>
                <button class="btn-primary" onclick="saveStaffRoles('${escapeHtml(s.id)}')">Save roles</button>` : ''}

            <h4>Effective permissions</h4>
            <div class="perm-list">
                ${s.permissions.length
                    ? s.permissions.map(p => `<code>${escapeHtml(p)}</code>`).join(' ')
                    : '<em>None — a staff member who is not ACTIVE holds no permissions.</em>'}
            </div>

            <h4>Account actions</h4>
            <div class="action-row">
                ${canManage && s.status !== 'suspended' && s.status !== 'deactivated'
                    ? `<button class="btn-danger" onclick="staffAction('${escapeHtml(s.id)}','suspend','Suspend this account')">Suspend</button>` : ''}
                ${canManage && (s.status === 'suspended' || s.status === 'locked')
                    ? `<button class="btn-secondary" onclick="staffReactivate('${escapeHtml(s.id)}')">Reactivate</button>` : ''}
                ${canReset && s.status !== 'deactivated'
                    ? `<button class="btn-secondary" onclick="staffAction('${escapeHtml(s.id)}','reset-credentials','Reset credentials and end all sessions')">Reset credentials</button>` : ''}
                ${canManage && s.status !== 'deactivated'
                    ? `<button class="btn-danger" onclick="staffAction('${escapeHtml(s.id)}','deactivate','Permanently deactivate this account')">Deactivate</button>` : ''}
            </div>

            <h4>Recent actions</h4>
            <div class="table-container compact">
                <table>
                    <thead><tr><th>Time</th><th>Action</th><th>Resource</th><th>Outcome</th></tr></thead>
                    <tbody>
                        ${data.recentActions.length ? data.recentActions.map(a => `
                            <tr>
                                <td>${new Date(a.createdAt).toLocaleString()}</td>
                                <td>${escapeHtml(a.action)}</td>
                                <td>${escapeHtml(a.resourceType)}</td>
                                <td>${escapeHtml(a.outcome)}</td>
                            </tr>`).join('')
                            : '<tr><td colspan="4">No recorded actions.</td></tr>'}
                    </tbody>
                </table>
            </div>`);
    } catch { /* surfaced by adminFetch */ }
}

async function saveStaffRoles(id) {
    const roles = [...document.querySelectorAll('input[name="sd-role"]:checked')].map(i => i.value);
    if (!roles.length) return showToast('At least one role is required', 'error');
    const reason = document.getElementById('sd-role-reason')?.value.trim() || null;
    try {
        await adminFetch(`/staff/${id}/roles`, 'PUT', { roles, reason });
        showToast('Roles updated — existing sessions ended', 'success');
        closeStaffModal();
        fetchStaffList();
    } catch { /* surfaced */ }
}

/** Suspend / deactivate / reset — each requires a written reason. */
async function staffAction(id, action, title) {
    const reason = prompt(`${title}.\n\nReason (required, recorded in the audit log):`);
    if (reason == null) return;
    if (!reason.trim()) return showToast('A reason is required', 'error');
    try {
        const result = await adminFetch(`/staff/${id}/${action}`, 'POST', { reason: reason.trim() });
        if (result.setupToken) {
            showSetupTokenModal(result);
        } else {
            showToast('Done', 'success');
            closeStaffModal();
        }
        fetchStaffList();
    } catch { /* surfaced */ }
}

async function staffReactivate(id) {
    try {
        await adminFetch(`/staff/${id}/reactivate`, 'POST', {});
        showToast('Account reactivated', 'success');
        closeStaffModal();
        fetchStaffList();
    } catch { /* surfaced */ }
}

// ── Role matrix ────────────────────────────────────────────────────────────

async function fetchRoleMatrix() {
    try {
        const data = await adminFetch('/staff/role-matrix');
        const body = document.getElementById('role-matrix-body');
        if (!body) return;
        body.innerHTML = data.roles.map(r => `
            <div class="role-card">
                <h4>${escapeHtml(r.role.replace(/_/g, ' '))}</h4>
                <div class="perm-list">
                    ${r.permissions.map(p => `<code>${escapeHtml(p)}</code>`).join(' ')}
                </div>
                <small>${r.permissions.length} permissions</small>
            </div>`).join('');
    } catch { /* surfaced */ }
}

// ── Staff audit ────────────────────────────────────────────────────────────

function auditFilterParams() {
    const params = new URLSearchParams({ page: String(staffAuditPage), pageSize: '50' });
    const map = {
        actor:        'audit-actor-filter',
        action:       'audit-action-filter',
        resourceType: 'audit-resource-filter',
        from:         'audit-from-filter',
        to:           'audit-to-filter',
        outcome:      'audit-outcome-filter',
    };
    for (const [key, elementId] of Object.entries(map)) {
        const value = document.getElementById(elementId)?.value.trim();
        if (value) params.set(key, value);
    }
    return params;
}

async function fetchStaffAudit() {
    if (!can('audit:read')) return;
    try {
        const data = await adminFetch(`/audit/events?${auditFilterParams().toString()}`);
        const list = document.getElementById('staff-audit-list');
        if (!list) return;

        list.innerHTML = data.items.length ? data.items.map(e => `
            <tr class="${e.outcome === 'denied' ? 'row-denied' : ''}">
                <td>${new Date(e.createdAt).toLocaleString()}</td>
                <td>${e.actorIsLegacy
                        ? '<span class="chip chip-warn">Legacy key</span>'
                        : escapeHtml(e.actorName || e.actorStaffUserId)}</td>
                <td><small>${escapeHtml((e.actorRoleSnapshot || '').replace(/,/g, ', ') || '—')}</small></td>
                <td>${escapeHtml(e.action)}</td>
                <td><small>${escapeHtml(e.resourceType)}${e.resourceId ? ' · ' + escapeHtml(e.resourceId) : ''}</small></td>
                <td>${escapeHtml(e.outcome)}</td>
                <td>${escapeHtml(e.reason || '—')}</td>
            </tr>`).join('')
            : '<tr><td colspan="7">No audit events match these filters.</td></tr>';

        const pages = Math.max(1, Math.ceil(data.total / data.pageSize));
        document.getElementById('staff-audit-pager').innerHTML = `
            <button class="btn-small" ${data.page <= 1 ? 'disabled' : ''} onclick="changeAuditPage(-1)">Previous</button>
            <span>Page ${data.page} of ${pages} · ${data.total} events</span>
            <button class="btn-small" ${data.page >= pages ? 'disabled' : ''} onclick="changeAuditPage(1)">Next</button>`;
    } catch { /* surfaced */ }
}

function changeAuditPage(delta) {
    staffAuditPage = Math.max(1, staffAuditPage + delta);
    fetchStaffAudit();
}

/** CSV export. Gated on audit:export, and the export itself is audited. */
async function exportStaffAudit() {
    if (!can('audit:export')) return showToast('You do not have export permission', 'error');
    const reason = prompt('Reason for this export (recorded in the audit log):');
    if (reason == null) return;
    try {
        const res = await fetch(`${API_BASE}/audit/events/export?limit=5000&reason=${encodeURIComponent(reason)}`, {
            headers: authHeaders(),
        });
        if (!res.ok) return showToast('Export failed', 'error');
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'staff-audit.csv';
        a.click();
        URL.revokeObjectURL(url);
        showToast('Export downloaded', 'success');
    } catch {
        showToast('Export failed', 'error');
    }
}

// ═══════════════════════════════════════════════════════════════════════════
//  Park Operations  (Phase 2)
// ═══════════════════════════════════════════════════════════════════════════

const PRESENCE_LABEL = {
    offline: 'Offline', online: 'Online', at_park: 'At park', waiting: 'Waiting',
    assigned: 'Assigned', en_route: 'En route', passenger_boarding: 'Boarding',
    trip_started: 'On trip', unavailable: 'Unavailable',
};
const PRESENCE_TONE = {
    offline: 'muted', online: 'info', at_park: 'info', waiting: 'success',
    assigned: 'warn', en_route: 'warn', passenger_boarding: 'warn',
    trip_started: 'warn', unavailable: 'error',
};

let currentParkId = null;

function setupParkListeners() {
    let t = null;
    document.getElementById('park-search')?.addEventListener('input', () => {
        clearTimeout(t); t = setTimeout(fetchParks, 350);
    });
    document.getElementById('park-status-filter')?.addEventListener('change', fetchParks);
    document.getElementById('btn-new-park')?.addEventListener('click', openCreateParkModal);

    let bt = null;
    document.getElementById('badge-search')?.addEventListener('input', () => {
        clearTimeout(bt); bt = setTimeout(fetchBadges, 350);
    });
    document.getElementById('badge-status-filter')?.addEventListener('change', fetchBadges);
    document.getElementById('btn-issue-badge')?.addEventListener('click', openIssueBadgeModal);

    document.getElementById('btn-pd-refresh')?.addEventListener('click', fetchParkDispatch);
    document.getElementById('pd-window')?.addEventListener('change', fetchParkDispatch);
}

function parkStatusChip(status) {
    const tone = { active: 'success', draft: 'info', inactive: 'muted', suspended: 'error' }[status] || 'muted';
    return `<span class="chip chip-${tone}">${escapeHtml(status)}</span>`;
}

function fmtDuration(seconds) {
    if (seconds == null) return '—';
    const m = Math.floor(seconds / 60);
    if (m < 60) return `${m}m`;
    return `${Math.floor(m / 60)}h ${m % 60}m`;
}

// ── Park list ──────────────────────────────────────────────────────────────

async function fetchParks() {
    if (!can('park:read')) return;
    const params = new URLSearchParams({ pageSize: '50' });
    const search = document.getElementById('park-search')?.value.trim();
    const status = document.getElementById('park-status-filter')?.value;
    if (search) params.set('search', search);
    if (status) params.set('status', status);

    try {
        const data = await adminFetch(`/parks?${params.toString()}`);
        const grid = document.getElementById('parks-grid');
        if (!grid) return;

        if (!data.items.length) {
            grid.innerHTML = `<p class="section-note">No parks yet. Create one to begin — it starts as a
                <strong>draft</strong> and cannot receive work until it has a supervisor and a staging zone.</p>`;
            return;
        }

        grid.innerHTML = data.items.map(p => {
            const c = p.counts || {};
            return `
            <div class="park-card" onclick="openParkDetail('${escapeHtml(p.parkId)}')">
                <div class="park-card-head">
                    <div>
                        <h3>${escapeHtml(p.name)}</h3>
                        <code class="park-code">${escapeHtml(p.code)}</code>
                    </div>
                    ${parkStatusChip(p.status)}
                </div>
                <p class="park-address">${escapeHtml(p.addressLine || p.city || '—')}</p>
                <div class="park-metrics">
                    <div><span>${c.waitingDriverCount ?? 0}</span><label>Waiting</label></div>
                    <div><span>${c.activeDriverCount ?? 0}</span><label>At park</label></div>
                    <div><span>${c.onRideCount ?? 0}</span><label>On trip</label></div>
                    <div><span>${c.rosterSize ?? 0}</span><label>Roster</label></div>
                </div>
                <div class="park-foot">
                    <span>${p.serviceRadiusKm} km radius · capacity ${p.capacityDrivers}</span>
                    <span class="${p.withinOperatingHours ? 'open-now' : 'closed-now'}">
                        ${p.withinOperatingHours ? 'Open now' : 'Closed'}
                    </span>
                </div>
            </div>`;
        }).join('');
    } catch { /* surfaced by adminFetch */ }
}

// ── Park detail ────────────────────────────────────────────────────────────

async function openParkDetail(parkId) {
    currentParkId = parkId;
    switchSection('park-detail');
    const body = document.getElementById('park-detail-body');
    body.innerHTML = '<p class="section-note">Loading…</p>';

    try {
        const [detail, rosterRes, queueRes] = await Promise.all([
            adminFetch(`/parks/${parkId}`),
            adminFetch(`/parks/${parkId}/roster`).catch(() => ({ roster: [] })),
            adminFetch(`/parks/${parkId}/queue`).catch(() => ({ queue: [] })),
        ]);
        renderParkDetail(detail, rosterRes.roster, queueRes.queue);
    } catch {
        body.innerHTML = '<p class="section-note">Could not load this park.</p>';
    }
}

function renderParkDetail(detail, roster, queue) {
    const p = detail.park;
    const c = p.counts || {};
    const blockers = detail.activationBlockers || [];
    const body = document.getElementById('park-detail-body');
    if (!body) return;

    body.innerHTML = `
        <div class="park-detail-head">
            <div>
                <h2>${escapeHtml(p.name)} <code class="park-code">${escapeHtml(p.code)}</code></h2>
                <p class="section-note">${escapeHtml(p.addressLine || '')} ${p.city ? '· ' + escapeHtml(p.city) : ''}</p>
            </div>
            <div class="action-row">
                ${parkStatusChip(p.status)}
                ${p.status !== 'active' && can('park:activate')
                    ? `<button class="btn-primary" onclick="activatePark('${escapeHtml(p.parkId)}')">Activate</button>` : ''}
                ${p.status === 'active' && can('park:suspend')
                    ? `<button class="btn-danger" onclick="suspendPark('${escapeHtml(p.parkId)}')">Suspend</button>` : ''}
            </div>
        </div>

        ${blockers.length ? `
            <div class="blocker-box">
                <strong>Not ready to activate.</strong>
                <ul>${blockers.map(b => `<li>${escapeHtml(b)}</li>`).join('')}</ul>
                <small>A park cannot receive real passengers until each of these is resolved.</small>
            </div>` : ''}

        <div class="park-metrics wide">
            <div><span>${c.waitingDriverCount ?? 0}</span><label>Waiting</label></div>
            <div><span>${c.activeDriverCount ?? 0}</span><label>At park</label></div>
            <div><span>${c.onRideCount ?? 0}</span><label>On trip</label></div>
            <div><span>${c.unavailableCount ?? 0}</span><label>Unavailable</label></div>
            <div><span>${c.rosterActive ?? 0}</span><label>Roster (active)</label></div>
            <div><span>${c.capacityUtilisationPct ?? 0}%</span><label>Capacity used</label></div>
        </div>

        <div class="detail-grid">
            <div><span>Coordinates</span>${p.lat}, ${p.lng}</div>
            <div><span>Service radius</span>${p.serviceRadiusKm} km</div>
            <div><span>On-site radius</span>${p.operatingRadiusM} m</div>
            <div><span>Capacity</span>${p.capacityDrivers} drivers</div>
            <div><span>Hours</span>${p.opensAt ? `${escapeHtml(p.opensAt)}–${escapeHtml(p.closesAt || '')}` : 'always open'}</div>
            <div><span>Supervisor</span>${escapeHtml(p.supervisorName || 'not assigned')}</div>
        </div>

        <h4>On duty now</h4>
        ${detail.onDuty.length ? `
            <div class="table-container compact">
                <table>
                    <thead><tr><th>Dispatcher</th><th>Since</th><th>Duration</th><th>Start location</th><th></th></tr></thead>
                    <tbody>${detail.onDuty.map(s => `
                        <tr>
                            <td>${escapeHtml(s.staffName || s.staffUserId)}</td>
                            <td>${new Date(s.startedAt).toLocaleTimeString()}</td>
                            <td>${s.durationMinutes}m</td>
                            <td>${s.startLocationVerified
                                ? '<span class="chip chip-success">verified on-site</span>'
                                : `<span class="chip chip-warn">unverified${s.startDistanceM != null ? ' · ' + Math.round(s.startDistanceM) + 'm' : ''}</span>`}</td>
                            <td>${can('shift:close_any')
                                ? `<button class="btn-small" onclick="forceCloseShift('${escapeHtml(s.shiftId)}')">Force close</button>` : ''}</td>
                        </tr>`).join('')}</tbody>
                </table>
            </div>` : '<p class="section-note">Nobody is on duty at this park right now.</p>'}

        <h4>Assigned staff</h4>
        ${detail.assignedStaff.length ? `
            <div class="perm-list">${detail.assignedStaff.map(a =>
                `<code>${escapeHtml(a.name)} · ${escapeHtml(a.role.replace(/_/g, ' '))}</code>`).join(' ')}</div>`
            : '<p class="section-note">No staff assigned. Grant a park-scoped role under Staff.</p>'}

        <h4>Zones</h4>
        <div class="action-row">
            ${can('park:manage_zones') ? `<button class="btn-secondary" onclick="openCreateZoneModal('${escapeHtml(p.parkId)}')">Add zone</button>` : ''}
        </div>
        ${detail.zones.length ? `
            <div class="table-container compact">
                <table>
                    <thead><tr><th>Name</th><th>Code</th><th>Kind</th><th>Radius</th><th>Active</th></tr></thead>
                    <tbody>${detail.zones.map(z => `
                        <tr>
                            <td>${escapeHtml(z.name)}</td>
                            <td><code>${escapeHtml(z.code)}</code></td>
                            <td>${escapeHtml(z.kind)}</td>
                            <td>${z.radiusM} m</td>
                            <td>${z.active ? 'yes' : 'no'}</td>
                        </tr>`).join('')}</tbody>
                </table>
            </div>` : '<p class="section-note">No zones defined. A staging zone is required before activation.</p>'}

        <h4>Queue (${queue.length})</h4>
        ${queue.length ? `
            <div class="table-container compact">
                <table>
                    <thead><tr><th>#</th><th>Driver</th><th>Unit</th><th>Device</th><th>Presence</th><th>Ready?</th></tr></thead>
                    <tbody>${queue.map(q => `
                        <tr class="${q.assignable ? '' : 'row-denied'}">
                            <td><strong>${q.queuePosition ?? '—'}</strong></td>
                            <td>${escapeHtml(q.firstName)} ${escapeHtml(q.lastName)}</td>
                            <td>${escapeHtml(q.unitNumber || '—')}</td>
                            <td>${deviceChip(q)}</td>
                            <td>${presenceChip(q.presenceState)}</td>
                            <td>${q.assignable
                                ? '<span class="chip chip-success">ready</span>'
                                : q.problems.map(pr => `<span class="chip chip-warn" title="${escapeHtml(pr.message)}">${escapeHtml(pr.code.replace(/_/g, ' '))}</span>`).join(' ')}</td>
                        </tr>`).join('')}</tbody>
                </table>
            </div>` : '<p class="section-note">Nobody is in the queue.</p>'}

        <h4>Roster (${roster.length})</h4>
        <div class="action-row">
            ${can('park:manage_roster') ? `<button class="btn-secondary" onclick="openAddDriverModal('${escapeHtml(p.parkId)}')">Add driver</button>` : ''}
        </div>
        <div class="table-container compact">
            <table>
                <thead><tr>
                    <th>Driver</th><th>Unit</th><th>Vehicle</th><th>Device</th><th>Phone</th>
                    <th>Badge</th><th>Wallet</th><th>Presence</th><th>Last ride</th><th>Queue</th>
                </tr></thead>
                <tbody>${roster.length ? roster.map(r => `
                    <tr class="${r.status === 'suspended' ? 'row-denied' : ''}">
                        <td>${escapeHtml(r.firstName)} ${escapeHtml(r.lastName)}</td>
                        <td>${escapeHtml(r.unitNumber || '—')}</td>
                        <td>${escapeHtml(r.vehiclePlate)}</td>
                        <td>${deviceChip(r)}</td>
                        <td style="font-family:monospace">${escapeHtml(r.phone || '—')}</td>
                        <td>${r.badgeSerial
                            ? `<code>${escapeHtml(r.badgeSerial)}</code>`
                            : '<span class="chip chip-warn">none</span>'}</td>
                        <td class="${r.walletBlocked ? 'wallet-blocked' : ''}">
                            ₦${Number(r.walletBalance).toLocaleString()}
                            ${r.commissionDebt > 0 ? `<small>owes ₦${Number(r.commissionDebt).toLocaleString()}</small>` : ''}
                        </td>
                        <td>${presenceChip(r.presenceState)}</td>
                        <td>${r.lastRideAt ? new Date(r.lastRideAt).toLocaleDateString() : 'never'}</td>
                        <td>${r.queuePosition ?? '—'}</td>
                    </tr>`).join('')
                    : '<tr><td colspan="10">No drivers on this roster yet.</td></tr>'}
                </tbody>
            </table>
        </div>`;
}

/** Device capability must be visible at a glance — it changes how a ride runs. */
function deviceChip(entry) {
    if (entry.smartphoneCapable) return '<span class="chip chip-info">smartphone</span>';
    if (entry.deviceCapability === 'feature_phone') return '<span class="chip chip-warn">feature phone</span>';
    // "no device", not "no phone": the phone column beside this often holds a
    // number that reaches the driver through a family member or the park, and
    // labelling the capability "no phone" made those two read as contradictory.
    return '<span class="chip chip-error">no device</span>';
}

function presenceChip(state) {
    if (!state) return '<span class="chip chip-muted">unknown</span>';
    return `<span class="chip chip-${PRESENCE_TONE[state] || 'muted'}">${escapeHtml(PRESENCE_LABEL[state] || state)}</span>`;
}

// ── Park actions ───────────────────────────────────────────────────────────

function openCreateParkModal() {
    staffModalShell('New park', `
        <form id="create-park-form" class="stack">
            <label>Name <input id="np-name" required placeholder="Awka Main Park"></label>
            <label>Code <input id="np-code" required placeholder="AWK-MAIN" style="text-transform:uppercase"></label>
            <label>Address <input id="np-address" placeholder="Zik Avenue"></label>
            <label>City <input id="np-city" placeholder="Awka"></label>
            <label>Latitude <input id="np-lat" required placeholder="6.2109"></label>
            <label>Longitude <input id="np-lng" required placeholder="7.0740"></label>
            <label>Service radius (km) <input id="np-radius" type="number" step="0.1" value="4"></label>
            <label>Capacity (drivers) <input id="np-capacity" type="number" value="50"></label>
            <label>Opens at <input id="np-opens" placeholder="06:00"></label>
            <label>Closes at <input id="np-closes" placeholder="19:00"></label>
            <p class="section-note">
                The park is created as a <strong>draft</strong>. It cannot be activated until it has a
                supervisor and at least one staging zone.
            </p>
            <button type="submit" class="btn-primary full-width">Create park</button>
        </form>`);

    document.getElementById('create-park-form').onsubmit = async (e) => {
        e.preventDefault();
        try {
            const result = await adminFetch('/parks', 'POST', {
                name: document.getElementById('np-name').value.trim(),
                code: document.getElementById('np-code').value.trim().toUpperCase(),
                addressLine: document.getElementById('np-address').value.trim(),
                city: document.getElementById('np-city').value.trim(),
                lat: Number(document.getElementById('np-lat').value),
                lng: Number(document.getElementById('np-lng').value),
                serviceRadiusKm: Number(document.getElementById('np-radius').value),
                capacityDrivers: Number(document.getElementById('np-capacity').value),
                opensAt: document.getElementById('np-opens').value.trim() || null,
                closesAt: document.getElementById('np-closes').value.trim() || null,
            });
            showToast('Park created as draft', 'success');
            closeStaffModal();
            openParkDetail(result.park.parkId);
        } catch { /* surfaced */ }
    };
}

function openCreateZoneModal(parkId) {
    staffModalShell('Add zone', `
        <form id="create-zone-form" class="stack">
            <label>Name <input id="nz-name" required placeholder="Main shed"></label>
            <label>Code <input id="nz-code" required placeholder="BAY-A" style="text-transform:uppercase"></label>
            <label>Kind
                <select id="nz-kind">
                    <option value="staging">Staging — where drivers wait</option>
                    <option value="boarding">Boarding — where passengers meet their Keke</option>
                    <option value="service">Service — a sub-area this park covers</option>
                </select>
            </label>
            <label>Latitude <input id="nz-lat" required></label>
            <label>Longitude <input id="nz-lng" required></label>
            <label>Radius (m) <input id="nz-radius" type="number" value="150"></label>
            <button type="submit" class="btn-primary full-width">Add zone</button>
        </form>`);

    document.getElementById('create-zone-form').onsubmit = async (e) => {
        e.preventDefault();
        try {
            await adminFetch(`/parks/${parkId}/zones`, 'POST', {
                name: document.getElementById('nz-name').value.trim(),
                code: document.getElementById('nz-code').value.trim().toUpperCase(),
                kind: document.getElementById('nz-kind').value,
                lat: Number(document.getElementById('nz-lat').value),
                lng: Number(document.getElementById('nz-lng').value),
                radiusM: Number(document.getElementById('nz-radius').value),
            });
            showToast('Zone added', 'success');
            closeStaffModal();
            openParkDetail(parkId);
        } catch { /* surfaced */ }
    };
}

async function activatePark(parkId) {
    try {
        await adminFetch(`/parks/${parkId}/activate`, 'POST', {});
        showToast('Park activated', 'success');
        openParkDetail(parkId);
    } catch { /* the blockers come back in the error message */ }
}

async function suspendPark(parkId) {
    const reason = prompt('Suspend this park.\n\nReason (required, recorded in the audit log):');
    if (reason == null) return;
    if (!reason.trim()) return showToast('A reason is required', 'error');
    try {
        await adminFetch(`/parks/${parkId}/suspend`, 'POST', { reason: reason.trim() });
        showToast('Park suspended', 'success');
        openParkDetail(parkId);
    } catch { /* surfaced */ }
}

async function forceCloseShift(shiftId) {
    const reason = prompt('Force-close this shift.\n\nReason (required):');
    if (reason == null) return;
    if (!reason.trim()) return showToast('A reason is required', 'error');
    try {
        await adminFetch(`/shifts/${shiftId}/force-close`, 'POST', { reason: reason.trim() });
        showToast('Shift closed', 'success');
        if (currentParkId) openParkDetail(currentParkId);
    } catch { /* surfaced */ }
}

function openAddDriverModal(parkId) {
    staffModalShell('Add driver to roster', `
        <form id="add-driver-form" class="stack">
            <label>Driver ID <input id="ad-driver" required placeholder="uuid from Approved Drivers"></label>
            <p class="section-note">
                Roster membership is not presence and not queue position. Adding a driver means
                "this driver works out of this park" — they join the queue separately, when they arrive.
            </p>
            <button type="submit" class="btn-primary full-width">Add to roster</button>
        </form>`);

    document.getElementById('add-driver-form').onsubmit = async (e) => {
        e.preventDefault();
        try {
            await adminFetch(`/parks/${parkId}/roster`, 'POST', {
                driverId: document.getElementById('ad-driver').value.trim(),
            });
            showToast('Driver added to roster', 'success');
            closeStaffModal();
            openParkDetail(parkId);
        } catch { /* surfaced */ }
    };
}

// ── Badges ─────────────────────────────────────────────────────────────────

async function fetchBadges() {
    if (!can('badge:read')) return;
    const params = new URLSearchParams({ pageSize: '100' });
    const search = document.getElementById('badge-search')?.value.trim();
    const status = document.getElementById('badge-status-filter')?.value;
    if (search) params.set('search', search);
    if (status) params.set('status', status);

    try {
        const data = await adminFetch(`/badges?${params.toString()}`);
        const counts = data.counts || {};
        document.getElementById('badge-counts').innerHTML = Object.entries(counts)
            .map(([k, v]) => `<div class="count-tile"><span>${v}</span><label>${escapeHtml(k.replace(/_/g, ' '))}</label></div>`)
            .join('') || '<p class="section-note">No badges issued yet.</p>';

        const list = document.getElementById('badge-list');
        list.innerHTML = data.items.length ? data.items.map(b => `
            <tr>
                <td><code>${escapeHtml(b.badgeSerial)}</code></td>
                <td>${escapeHtml(b.driverName)}</td>
                <td>${escapeHtml(b.unitNumber || '—')}</td>
                <td style="font-family:monospace">${escapeHtml(b.shortCode)}</td>
                <td>${badgeStatusChip(b.status)}</td>
                <td>${new Date(b.issuedAt).toLocaleDateString()}</td>
                <td>
                    ${b.status === 'pending_activation' && can('badge:issue')
                        ? `<button class="btn-small" onclick="activateBadge('${escapeHtml(b.badgeSerial)}')">Activate</button>` : ''}
                    ${(b.status === 'active' || b.status === 'pending_activation') && can('badge:revoke')
                        ? `<button class="btn-small" onclick="revokeBadge('${escapeHtml(b.badgeSerial)}')">Revoke</button>` : ''}
                </td>
            </tr>`).join('')
            : '<tr><td colspan="7">No badges match these filters.</td></tr>';
    } catch { /* surfaced */ }
}

function badgeStatusChip(status) {
    const tone = { active: 'success', pending_activation: 'info', revoked: 'error', lost: 'error', replaced: 'muted' }[status] || 'muted';
    return `<span class="chip chip-${tone}">${escapeHtml(status.replace(/_/g, ' '))}</span>`;
}

function openIssueBadgeModal() {
    staffModalShell('Issue badge', `
        <form id="issue-badge-form" class="stack">
            <label>Driver ID <input id="ib-driver" required placeholder="uuid from Approved Drivers"></label>
            <p class="section-note">
                A badge is an <strong>identity claim, not a credential</strong>. It can be photographed,
                so it never unlocks a wallet, a profile or an account — and it is issued only to an
                approved driver with a verified photo, because the photo is the control that defeats
                badge sharing.
            </p>
            <button type="submit" class="btn-primary full-width">Issue badge</button>
        </form>`);

    document.getElementById('issue-badge-form').onsubmit = async (e) => {
        e.preventDefault();
        try {
            const result = await adminFetch('/badges', 'POST', {
                driverId: document.getElementById('ib-driver').value.trim(),
            });
            showBadgeIssuedModal(result.badge);
            fetchBadges();
        } catch { /* surfaced */ }
    };
}

function showBadgeIssuedModal(badge) {
    staffModalShell('Badge issued', `
        <div class="detail-grid">
            <div><span>Serial</span><code>${escapeHtml(badge.badgeSerial)}</code></div>
            <div><span>Driver</span>${escapeHtml(badge.driverName)}</div>
            <div><span>Unit</span>${escapeHtml(badge.unitNumber || '—')}</div>
            <div><span>Six-digit code</span><code>${escapeHtml(badge.shortCode)}</code></div>
        </div>
        <h4>QR payload</h4>
        <p class="section-note">
            Opaque and signed. It carries no name, phone, plate or internal id, so a photographed
            badge reveals nothing about the driver.
        </p>
        <pre class="token-box">${escapeHtml(badge.qrPayload)}</pre>
        <p class="section-note">
            Status is <strong>pending activation</strong>: the badge identifies nobody until somebody
            confirms the physical card reached the right person.
        </p>
        <button class="btn-primary" onclick="closeStaffModal()">Done</button>`);
}

async function activateBadge(serial) {
    try {
        await adminFetch(`/badges/${serial}/activate`, 'POST', {});
        showToast('Badge activated', 'success');
        fetchBadges();
    } catch { /* surfaced */ }
}

async function revokeBadge(serial) {
    const reason = prompt('Revoke this badge.\n\nReason (required):');
    if (reason == null) return;
    if (!reason.trim()) return showToast('A reason is required', 'error');
    try {
        await adminFetch(`/badges/${serial}/revoke`, 'POST', { reason: reason.trim() });
        showToast('Badge revoked', 'success');
        fetchBadges();
    } catch { /* surfaced */ }
}

// ── Park Dispatch monitoring (Phase 3) ─────────────────────────────────────

function fmtMs(ms) {
    if (ms == null) return '—';
    const s = Math.round(ms / 1000);
    if (s < 60) return `${s}s`;
    return `${Math.floor(s / 60)}m ${s % 60}s`;
}

/**
 * The runtime suspension control.
 *
 * Only rendered for staff who hold `park:suspend`, which the shared admin key
 * is denied outright — a shared secret has no human behind it and this action's
 * whole point is being attributable.
 */
async function fetchParkDispatchSwitch() {
    const panel = document.getElementById('pd-switch-panel');
    if (!panel) return;

    if (!can('park:suspend')) { panel.classList.add('hidden'); return; }
    panel.classList.remove('hidden');

    try {
        const st = await adminFetch('/park-dispatch/switch');
        const suspended = st.override?.disabled === true;

        document.getElementById('btn-pd-suspend').classList.toggle('hidden', suspended);
        document.getElementById('btn-pd-resume').classList.toggle('hidden', !suspended);
        document.getElementById('pd-switch-reason').classList.toggle('hidden', suspended);

        const state = document.getElementById('pd-switch-state');
        if (!st.envEnabled) {
            // The environment has it off. Nothing here can turn that back on,
            // and pretending otherwise would send someone hunting the wrong fix.
            state.innerHTML = '<strong>Disabled in the environment.</strong> '
                + 'PARK_DISPATCH_ENABLED is false; this control cannot switch it on. '
                + 'That needs a configuration change and a restart.';
        } else if (suspended) {
            const who = st.override.setBy || 'unknown';
            const when = st.override.setAt ? new Date(st.override.setAt).toLocaleString() : 'unknown time';
            state.innerHTML = `<strong>Suspended.</strong> ${escapeHtml(st.override.reason || 'no reason recorded')}`
                + `<br><small>By ${escapeHtml(who)} at ${escapeHtml(when)}</small>`;
        } else {
            state.innerHTML = '<strong>Running.</strong> New requests are reaching parks normally.';
        }
    } catch (err) {
        document.getElementById('pd-switch-state').textContent =
            `Could not read the switch: ${err.message}`;
    }
}

document.getElementById('btn-pd-suspend')?.addEventListener('click', async () => {
    const reason = document.getElementById('pd-switch-reason').value.trim();
    if (reason.length < 3) {
        showToast('Give a reason — it is recorded against your name.', 'error');
        return;
    }
    if (!confirm('Suspend new park requests?\n\nRequests already taken by a dispatcher can still be assigned. This does not affect rides already assigned.')) return;
    try {
        await adminFetch('/park-dispatch/switch', 'POST', { disabled: true, reason });
        showToast('Park Dispatch suspended.', 'success');
        document.getElementById('pd-switch-reason').value = '';
        await fetchParkDispatchSwitch();
    } catch (err) { showToast(err.message, 'error'); }
});

document.getElementById('btn-pd-resume')?.addEventListener('click', async () => {
    if (!confirm('Resume Park Dispatch? New requests will start reaching parks again.')) return;
    try {
        await adminFetch('/park-dispatch/switch', 'POST', { disabled: false });
        showToast('Park Dispatch resumed.', 'success');
        await fetchParkDispatchSwitch();
    } catch (err) { showToast(err.message, 'error'); }
});

async function fetchParkDispatch() {
    if (!can('park:read')) return;
    fetchParkDispatchSwitch();
    const hours = document.getElementById('pd-window')?.value || '24';
    try {
        const data = await adminFetch(`/park-dispatch/overview?hours=${hours}`);
        const m = data.metrics || {};

        // The feature flag is the first thing an operator needs to see. A
        // dashboard of zeroes means something very different when the fallback
        // is switched off than when it is on and nothing is happening.
        const flag = document.getElementById('pd-flag');
        if (flag) {
            flag.className = `chip chip-${data.enabled ? 'success' : 'muted'}`;
            flag.textContent = data.enabled ? 'fallback ENABLED' : 'fallback disabled';
        }

        document.getElementById('pd-metrics').innerHTML = `
            <div class="count-tile"><span>${m.offered ?? 0}</span><label>Offered</label></div>
            <div class="count-tile"><span>${m.assigned ?? 0}</span><label>Assigned</label></div>
            <div class="count-tile"><span>${m.assignmentSuccessRatePct ?? 0}%</span><label>Success rate</label></div>
            <div class="count-tile"><span>${fmtMs(m.medianResponseTimeMs)}</span><label>Median response</label></div>
            <div class="count-tile"><span>${fmtMs(m.medianAssignmentTimeMs)}</span><label>Median assign</label></div>
            <div class="count-tile"><span>${fmtMs(m.avgPassengerWaitMs)}</span><label>Avg passenger wait</label></div>
            <div class="count-tile"><span>${m.expired ?? 0}</span><label>Expired</label></div>
            <div class="count-tile"><span>${(m.skipped ?? 0) + (m.rejected ?? 0)}</span><label>Skipped / rejected</label></div>`;

        const live = document.getElementById('pd-live-list');
        live.innerHTML = data.liveJobs.length ? data.liveJobs.map(j => `
            <tr>
                <td style="font-family:monospace;font-size:11px">${escapeHtml(j.rideId)}</td>
                <td style="font-family:monospace;font-size:11px">${escapeHtml(j.parkId.slice(0, 8))}…</td>
                <td><span class="chip chip-${j.status === 'claimed' ? 'warn' : 'info'}">${escapeHtml(j.status)}</span></td>
                <td>${escapeHtml(String(j.priority))}</td>
                <td>${new Date(j.offeredAt).toLocaleTimeString()}</td>
                <td>${escapeHtml(j.claimedByStaffId ? j.claimedByStaffId.slice(0, 8) + '…' : '—')}</td>
                <td>${j.attemptNumber}</td>
            </tr>`).join('')
            : '<tr><td colspan="7">Nothing in a park queue right now.</td></tr>';

        const disp = document.getElementById('pd-dispatchers');
        disp.innerHTML = data.dispatchers.length ? data.dispatchers.map(d => `
            <tr>
                <td>${escapeHtml(d.name)}</td>
                <td>${d.claimed}</td>
                <td>${d.assigned}</td>
                <td>${d.skipped}</td>
                <td>${fmtMs(d.avgResponseMs)}</td>
            </tr>`).join('')
            : '<tr><td colspan="5">No dispatcher activity in this window.</td></tr>';

        document.getElementById('pd-utilisation').innerHTML = data.parkUtilisation.length
            ? data.parkUtilisation.map(p => {
                const c = p.counts || {};
                const w = p.windowMetrics || {};
                return `
                <div class="park-card" onclick="openParkDetail('${escapeHtml(p.parkId)}')">
                    <div class="park-card-head">
                        <div><h3>${escapeHtml(p.name)}</h3><code class="park-code">${escapeHtml(p.code)}</code></div>
                        <span class="chip chip-${p.liveJobs > 0 ? 'warn' : 'muted'}">${p.liveJobs} live</span>
                    </div>
                    <div class="park-metrics">
                        <div><span>${c.waitingDriverCount ?? 0}</span><label>Waiting</label></div>
                        <div><span>${c.capacityUtilisationPct ?? 0}%</span><label>Capacity</label></div>
                        <div><span>${w.offered ?? 0}</span><label>Offered</label></div>
                        <div><span>${w.assignmentSuccessRatePct ?? 0}%</span><label>Success</label></div>
                    </div>
                </div>`;
            }).join('')
            : '<p class="section-note">No active parks.</p>';
    } catch { /* surfaced by adminFetch */ }
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
