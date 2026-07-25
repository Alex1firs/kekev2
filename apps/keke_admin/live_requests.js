/* =============================================================================
 * Live Ride Requests — dispatch lifecycle monitoring
 *
 * Sits beside Live Riders (which monitors driver presence) and does not touch it.
 *
 * Realtime design: the server pushes `admin:dispatch_event` per event, and this
 * module applies them INCREMENTALLY to an in-memory index. A full
 * `/live-requests` fetch happens on section entry, on reconnect, and as a slow
 * safety reconcile — never per event. The previous pattern (refetch everything
 * on every ride:status_update) does not survive a busy evening.
 *
 * Deltas are ignored entirely while the section is off-screen: events reach every
 * admin socket regardless of the page being viewed, and re-syncing for a page
 * nobody is looking at burns a tight admin request budget for nothing.
 *
 * Honesty rules enforced in this file:
 *   - Delivery state is rendered from the strongest recorded signal only. There
 *     is no code path that can print "delivered" or "driver saw it".
 *   - "Unknown" is shown as unknown, not blank and not optimistic.
 *   - Rejection reasons are labelled "not collected", because none are.
 * ========================================================================== */

/** Ride id -> request row (masked). */
let lrIndex = new Map();
/** Ride id -> array of dispatch events received live (bounded per ride). */
let lrLiveEvents = new Map();
let lrReconcileTimer = null;
let lrTickTimer = null;
let lrMap = null;
let lrMapLayer = null;
let lrSelectedRideId = null;
let lrLastServerTime = null;
let lrStreamConnected = false;
let lrRole = null;
/** rideId -> last fetched detail payload. */
const lrDetailCache = new Map();

/** Cap per-ride live event retention so a long search cannot grow unbounded. */
const LR_MAX_EVENTS_PER_RIDE = 400;
/** Slow reconcile: catches anything a dropped socket frame would have missed. */
const LR_RECONCILE_MS = 30000;

const LR_STATUS_META = {
    searching:   { label: 'Searching',    cls: 'lr-st-searching' },
    accepted:    { label: 'Accepted',     cls: 'lr-st-accepted' },
    arrived:     { label: 'Arriving',     cls: 'lr-st-arriving' },
    in_progress: { label: 'In progress',  cls: 'lr-st-inprogress' },
    started:     { label: 'In progress',  cls: 'lr-st-inprogress' },
    canceled:    { label: 'Cancelled',    cls: 'lr-st-cancelled' },
    failed:      { label: 'No driver',    cls: 'lr-st-nodriver' },
    completed:   { label: 'Completed',    cls: 'lr-st-completed' },
};

/** Outcome codes carry their own tone: availability is not a technical failure. */
const LR_OUTCOME_META = {
    NO_DRIVER_ACCEPTED: { label: 'No driver accepted', cls: 'lr-st-nodriver' },
    NO_ELIGIBLE_DRIVER: { label: 'No eligible driver', cls: 'lr-st-nodriver' },
    REQUEST_EXPIRED:    { label: 'Request expired',    cls: 'lr-st-nodriver' },
};

/**
 * Delivery labels. Deliberately verbose: an operator must be able to tell
 * "the provider took it" from "the handset showed it".
 */
const LR_DELIVERY_META = {
    acknowledged:      { label: 'Device acknowledged', cls: 'lr-dl-ack',     icon: 'fa-mobile-screen-button' },
    provider_accepted: { label: 'FCM accepted',        cls: 'lr-dl-partial', icon: 'fa-cloud-arrow-up' },
    socket_emitted:    { label: 'Socket emitted',      cls: 'lr-dl-partial', icon: 'fa-plug' },
    failed:            { label: 'Delivery failed',     cls: 'lr-dl-failed',  icon: 'fa-triangle-exclamation' },
    unknown:           { label: 'Delivery unknown',    cls: 'lr-dl-unknown', icon: 'fa-circle-question' },
};

const LR_OUTCOME_LABEL = {
    accepted: 'Accepted',
    rejected: 'Rejected',
    expired: 'Offer expired',
    delivery_failed: 'Never reached device',
    stale_before_offer: 'Went stale before offer',
    reservation_conflict: 'Reserved by another ride',
    ineligible: 'Not eligible',
    cancelled_before_response: 'Cancelled before response',
    awaiting_response: 'Awaiting response',
};

const LR_EVENT_LABEL = {
    ride_created: 'Ride created',
    round_started: 'Dispatch round started',
    round_transition: 'Dispatch round started',
    candidate_discovered: 'Candidate found',
    eligibility_passed: 'Eligibility passed',
    eligibility_rejected: 'Eligibility rejected',
    candidate_stale: 'Candidate stale before offer',
    reservation_acquired: 'Driver reserved',
    reservation_conflict: 'Reservation conflict',
    notification_queued: 'Offer created / notification queued',
    socket_offer_emitted: 'Socket offer emitted',
    fcm_accepted_by_provider: 'FCM accepted by provider',
    offer_delivery_failed: 'Notification delivery failed',
    device_offer_ack: 'Device acknowledged offer',
    driver_rejected: 'Driver rejected',
    offer_expired: 'Offer expired',
    driver_accepted: 'Driver accepted',
    dispatch_failed: 'Dispatch ended without assignment',
    ride_cancelled: 'Passenger cancelled',
};

// ── helpers ────────────────────────────────────────────────────────────────

function lrEsc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c =>
        ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function lrAge(sec) {
    if (sec == null) return '—';
    if (sec < 60) return sec + 's';
    const m = Math.floor(sec / 60);
    if (m < 60) return m + 'm ' + (sec % 60) + 's';
    return Math.floor(m / 60) + 'h ' + (m % 60) + 'm';
}

function lrMs(ms) {
    if (ms == null) return '—';
    if (ms < 1000) return ms + 'ms';
    return (ms / 1000).toFixed(1) + 's';
}

function lrKm(km) { return km == null ? '—' : Number(km).toFixed(2) + ' km'; }
function lrMoney(n) { return n == null ? '—' : '₦' + Number(n).toLocaleString(); }

function lrDistance(m) {
    if (m == null) return '—';
    return m >= 1000 ? (m / 1000).toFixed(1) + ' km' : Math.round(m) + ' m';
}

function lrDuration(sec) {
    if (sec == null) return '—';
    const m = Math.round(sec / 60);
    return m < 60 ? m + ' min' : Math.floor(m / 60) + 'h ' + (m % 60) + 'm';
}

function lrClock(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    return d.toLocaleTimeString([], { hour12: false });
}

// ── data loading ───────────────────────────────────────────────────────────

async function fetchLiveRequests() {
    try {
        const data = await adminFetch('/live-requests');
        lrIndex = new Map((data.requests || []).map(r => [r.rideId, r]));
        lrLastServerTime = data.serverTime || null;
        const el = document.getElementById('lr-updated');
        if (el) el.innerText = 'Synced ' + new Date().toLocaleTimeString();
        renderLiveRequests();
    } catch (e) {
        const el = document.getElementById('lr-updated');
        if (el) el.innerText = 'Sync failed — showing last known data';
    }
}

async function fetchAdminRole() {
    if (lrRole) return lrRole;
    try {
        const who = await adminFetch('/whoami');
        lrRole = who.role || 'superadmin';
    } catch { lrRole = 'superadmin'; }
    const badge = document.getElementById('lr-role-badge');
    if (badge) badge.innerText = 'Role: ' + lrRole;
    return lrRole;
}

/** Section entry. Full sync once, then live deltas. */
async function enterLiveRequests() {
    // Nothing is buffered while the section is off-screen, so start from a clean
    // slate rather than replaying whatever a previous visit left behind.
    lrLiveEvents.clear();
    lrDetailCache.clear();
    await fetchAdminRole();
    await fetchLiveRequests();
    toggleLiveRequestsStream();
    lrEnsureMap();
}

function stopLiveRequestsStream() {
    if (lrReconcileTimer) { clearInterval(lrReconcileTimer); lrReconcileTimer = null; }
    if (lrTickTimer) { clearInterval(lrTickTimer); lrTickTimer = null; }
}

function toggleLiveRequestsStream() {
    stopLiveRequestsStream();
    const box = document.getElementById('lr-live');
    if (!box || !box.checked) { renderLiveRequests(); return; }
    // Slow reconcile only — the socket carries the real updates.
    lrReconcileTimer = setInterval(() => { fetchLiveRequests().catch(() => {}); }, LR_RECONCILE_MS);
    // Local 1s tick just re-renders ages; no network, no server load.
    lrTickTimer = setInterval(() => lrRenderAgesOnly(), 1000);
}

// ── incremental realtime application ───────────────────────────────────────

/**
 * Apply one pushed dispatch event.
 *
 * Only the counters this event genuinely proves are advanced; nothing here can
 * upgrade a delivery state by inference.
 */
/** True only while an operator is actually looking at the monitor. */
function lrIsActive() {
    return typeof currentSection !== 'undefined' && currentSection === 'live-requests';
}

function applyDispatchEvent(ev) {
    if (!ev || !ev.rideId) return;
    // Events stream to every admin socket regardless of the page being viewed.
    // Buffering and re-syncing off-screen wastes a tight request budget and
    // grows the event map without bound in a dashboard left open all day.
    if (!lrIsActive()) return;

    const list = lrLiveEvents.get(ev.rideId) || [];
    list.push(ev);
    if (list.length > LR_MAX_EVENTS_PER_RIDE) list.splice(0, list.length - LR_MAX_EVENTS_PER_RIDE);
    lrLiveEvents.set(ev.rideId, list);

    const row = lrIndex.get(ev.rideId);
    if (!row) {
        // A brand-new ride: pull it in so it appears immediately rather than at
        // the next reconcile.
        if (ev.eventType === 'ride_created') fetchLiveRequests().catch(() => {});
        return;
    }

    if (ev.dispatchRound != null) row.dispatchRound = ev.dispatchRound;
    if (ev.radiusKm != null) row.searchRadiusKm = ev.radiusKm;

    switch (ev.eventType) {
        case 'eligibility_passed':
            row.eligibleDriverCount = (row.eligibleDriverCount || 0) + 1; break;
        case 'socket_offer_emitted':
        case 'fcm_accepted_by_provider':
            row.notifiedDriverCount = (row.notifiedDriverCount || 0) + 1; break;
        case 'device_offer_ack':
            row.acknowledgedCount = (row.acknowledgedCount || 0) + 1; break;
        case 'driver_rejected':
            row.rejectionCount = (row.rejectionCount || 0) + 1; break;
        case 'offer_expired':
            row.expiredOfferCount = (row.expiredOfferCount || 0) + 1; break;
        case 'offer_delivery_failed':
            row.deliveryFailureCount = (row.deliveryFailureCount || 0) + 1; break;
        case 'dispatch_failed':
            row.finalOutcomeCode = (ev.detail && ev.detail.outcomeCode) || row.finalOutcomeCode;
            row.status = 'failed';
            break;
        case 'ride_cancelled':
            row.status = 'canceled'; break;
        case 'driver_accepted':
            row.status = 'accepted'; break;
        default: break;
    }

    row.dataSource = 'live';
    renderLiveRequests();
    if (lrSelectedRideId === ev.rideId) appendDrawerTimelineEvent(ev);
}

/** Status transitions pushed for rides we already hold. */
function applyRideStatusUpdate(payload) {
    if (!payload || !payload.rideId) return;
    if (!lrIsActive()) return; // see applyDispatchEvent
    const row = lrIndex.get(payload.rideId);
    if (!row) {
        // Unknown ride entering an active state → sync it in.
        if (payload.status === 'searching') fetchLiveRequests().catch(() => {});
        return;
    }
    row.status = payload.status || row.status;
    // A ride leaving the active set drops out of the list on the next reconcile;
    // remove it now so the operator is not looking at a finished trip.
    if (['completed', 'canceled', 'failed'].includes(row.status)) {
        setTimeout(() => { lrIndex.delete(payload.rideId); renderLiveRequests(); }, 6000);
    }
    renderLiveRequests();
}

function setLiveRequestsStreamState(connected) {
    lrStreamConnected = connected;
    const el = document.getElementById('lr-updated');
    if (el && !connected) el.innerText = 'Realtime disconnected — data may be stale';
}

// ── filtering ──────────────────────────────────────────────────────────────

function lrVisibleRequests() {
    const q = ((document.getElementById('lr-search') || {}).value || '').toLowerCase().trim();
    const status = (document.getElementById('lr-status') || {}).value || 'all';
    const payment = (document.getElementById('lr-payment') || {}).value || 'all';
    const round = (document.getElementById('lr-round') || {}).value || 'all';
    const dispatch = (document.getElementById('lr-dispatch') || {}).value || 'all';
    const fareMin = parseFloat((document.getElementById('lr-fare-min') || {}).value);
    const fareMax = parseFloat((document.getElementById('lr-fare-max') || {}).value);

    return [...lrIndex.values()].filter(r => {
        if (status !== 'all') {
            const norm = r.status === 'started' ? 'in_progress' : r.status;
            if (norm !== status) return false;
        }
        if (payment !== 'all' && r.paymentMode !== payment) return false;
        if (round !== 'all' && String(r.dispatchRound || 1) !== round) return false;
        if (Number.isFinite(fareMin) && (r.estimatedFare == null || r.estimatedFare < fareMin)) return false;
        if (Number.isFinite(fareMax) && (r.estimatedFare == null || r.estimatedFare > fareMax)) return false;
        if (dispatch !== 'all') {
            if (dispatch === 'no_offers' && (r.notifiedDriverCount || 0) > 0) return false;
            if (dispatch === 'offered' && (r.notifiedDriverCount || 0) === 0) return false;
            if (dispatch === 'rejected' && (r.rejectionCount || 0) === 0) return false;
            if (dispatch === 'expired' && (r.expiredOfferCount || 0) === 0) return false;
            if (dispatch === 'delivery_failed' && (r.deliveryFailureCount || 0) === 0) return false;
            if (dispatch === 'assigned' && !r.assignedDriver) return false;
        }
        if (q) {
            const hay = [r.rideId, r.passengerName, r.pickupArea, r.destinationArea,
                r.assignedDriver && r.assignedDriver.name].join(' ').toLowerCase();
            if (!hay.includes(q)) return false;
        }
        return true;
    }).sort((a, b) => new Date(b.requestedAt) - new Date(a.requestedAt));
}

// ── rendering ──────────────────────────────────────────────────────────────

/** Cheap 1s path: only the age fields change, so only those are rewritten. */
function lrRenderAgesOnly() {
    for (const row of lrIndex.values()) {
        const el = document.querySelector(`[data-lr-age="${CSS.escape(row.rideId)}"]`);
        if (!el) continue;
        const base = Math.max(0, Math.floor((Date.now() - new Date(row.requestedAt).getTime()) / 1000));
        el.innerText = lrAge(base);
    }
}

function renderLiveRequests() {
    const list = document.getElementById('lr-list');
    if (!list) return;

    const all = [...lrIndex.values()];
    const stats = document.getElementById('lr-stats');
    if (stats) {
        const c = {};
        for (const r of all) {
            const norm = r.status === 'started' ? 'in_progress' : r.status;
            c[norm] = (c[norm] || 0) + 1;
        }
        stats.innerHTML = `
            <span class="chip lr-st-searching">${c.searching || 0} Searching</span>
            <span class="chip lr-st-accepted">${c.accepted || 0} Accepted</span>
            <span class="chip lr-st-arriving">${c.arrived || 0} Arriving</span>
            <span class="chip lr-st-inprogress">${c.in_progress || 0} In progress</span>
            ${lrStreamConnected ? '' : '<span class="chip lr-stale-chip"><i class="fas fa-plug-circle-xmark"></i> Realtime offline</span>'}`;
    }

    const visible = lrVisibleRequests();
    if (!visible.length) {
        list.innerHTML = `<div class="lr-empty"><i class="fas fa-inbox"></i><p>No active ride requests.</p></div>`;
        lrDrawMap(null);
        return;
    }

    list.innerHTML = visible.map(r => {
        const meta = LR_STATUS_META[r.status] || { label: r.status, cls: '' };
        const outcome = r.finalOutcomeCode ? LR_OUTCOME_META[r.finalOutcomeCode] : null;
        const selected = lrSelectedRideId === r.rideId ? ' lr-card-selected' : '';
        const stale = r.dataSource === 'persisted' && r.status === 'searching';

        return `
        <div class="lr-card${selected}" onclick="openRequestDrawer('${lrEsc(r.rideId)}')">
            <div class="lr-card-top">
                <span class="lr-badge ${meta.cls}">${lrEsc(meta.label)}</span>
                ${outcome ? `<span class="lr-badge ${outcome.cls}">${lrEsc(outcome.label)}</span>` : ''}
                <span class="lr-round">Round ${r.dispatchRound || 1}</span>
                ${r.searchRadiusKm != null ? `<span class="lr-radius">${Number(r.searchRadiusKm).toFixed(1)} km tier</span>` : ''}
                ${stale ? '<span class="lr-badge lr-stale-chip" title="No live dispatch run — server may have restarted">stale</span>' : ''}
                <span class="lr-ride-id">${lrEsc(r.rideId)}</span>
            </div>

            <div class="lr-card-route">
                <div><i class="fas fa-circle-dot" style="color:#f5a623"></i> ${lrEsc(r.pickupArea || 'Unknown pickup')}</div>
                <div><i class="fas fa-location-dot" style="color:#ff4d4d"></i> ${lrEsc(r.destinationArea || 'Unknown destination')}</div>
            </div>

            <div class="lr-card-meta">
                <span title="Passenger (masked)"><i class="fas fa-user"></i> ${lrEsc(r.passengerName)}</span>
                <span title="Masked phone"><i class="fas fa-phone"></i> ${lrEsc(r.passengerPhoneMasked || '—')}</span>
                <span title="Estimated fare"><i class="fas fa-coins"></i> ${lrMoney(r.estimatedFare)}</span>
                <span title="Payment method"><i class="fas fa-wallet"></i> ${lrEsc(r.paymentMode)}</span>
                <span title="Estimated distance"><i class="fas fa-ruler"></i> ${lrDistance(r.estimatedDistanceM)}</span>
                <span title="Estimated duration"><i class="fas fa-clock"></i> ${lrDuration(r.estimatedDurationSec)}</span>
                <span title="Request age"><i class="fas fa-hourglass-half"></i> <b data-lr-age="${lrEsc(r.rideId)}">${lrAge(r.requestAgeSec)}</b></span>
            </div>

            <div class="lr-card-dispatch">
                <span title="Drivers that passed eligibility">${r.eligibleDriverCount || 0} eligible</span>
                <span title="Offers that genuinely left the server">${r.notifiedDriverCount || 0} notified</span>
                <span title="Devices that confirmed the offer rendered">${r.acknowledgedCount || 0} ack</span>
                <span title="Explicit driver rejections">${r.rejectionCount || 0} rejected</span>
                <span title="Offers that expired unanswered">${r.expiredOfferCount || 0} expired</span>
                ${(r.deliveryFailureCount || 0) > 0
                    ? `<span class="lr-warn" title="Offers that reached no device">${r.deliveryFailureCount} delivery fail</span>` : ''}
            </div>

            ${r.assignedDriver ? `
            <div class="lr-card-driver">
                <i class="fas fa-id-badge"></i>
                <b>${lrEsc(r.assignedDriver.name)}</b>
                <span>${lrEsc(r.assignedDriver.vehiclePlate || 'no plate')}</span>
                <span>${lrEsc(r.assignedDriver.phoneMasked || '—')}</span>
            </div>` : ''}
        </div>`;
    }).join('');

    if (lrSelectedRideId && lrIndex.has(lrSelectedRideId)) lrDrawMap(lrIndex.get(lrSelectedRideId));
    else if (visible.length) lrDrawMap(visible[0]);
}

// ── map ────────────────────────────────────────────────────────────────────

function lrEnsureMap() {
    const el = document.getElementById('lr-map');
    if (!el || typeof L === 'undefined') return;
    if (lrMap) { setTimeout(() => lrMap.invalidateSize(), 60); return; }
    lrMap = L.map('lr-map', { zoomControl: true, attributionControl: false }).setView([6.2097, 7.0562], 13);
    L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', { maxZoom: 19 }).addTo(lrMap);
    lrMapLayer = L.layerGroup().addTo(lrMap);
    setTimeout(() => lrMap.invalidateSize(), 120);
}

function lrDot(color, radius) {
    return { radius: radius || 7, color: '#0b0f14', weight: 2, fillColor: color, fillOpacity: 0.95 };
}

/**
 * Draw one request. Driver markers come from the dispatch trail we already hold:
 * offer-sent drivers are drawn distinctly from merely-eligible candidates, and
 * the assigned driver is drawn distinctly again.
 */
function lrDrawMap(row) {
    lrEnsureMap();
    if (!lrMap || !lrMapLayer) return;
    lrMapLayer.clearLayers();
    if (!row) return;

    const points = [];
    if (row.pickup) {
        L.circleMarker([row.pickup.lat, row.pickup.lng], lrDot('#f5a623', 9))
            .bindTooltip('Pickup — ' + (row.pickupArea || ''), { direction: 'top' }).addTo(lrMapLayer);
        points.push([row.pickup.lat, row.pickup.lng]);
    }
    if (row.destination) {
        L.circleMarker([row.destination.lat, row.destination.lng], lrDot('#ff4d4d', 9))
            .bindTooltip('Destination — ' + (row.destinationArea || ''), { direction: 'top' }).addTo(lrMapLayer);
        points.push([row.destination.lat, row.destination.lng]);
    }
    if (points.length === 2) {
        L.polyline(points, { color: '#4a5568', weight: 2, dashArray: '6 6' }).addTo(lrMapLayer);
    }

    // Search-radius ring for the tier currently being worked.
    if (row.pickup && row.searchRadiusKm) {
        L.circle([row.pickup.lat, row.pickup.lng], {
            radius: Number(row.searchRadiusKm) * 1000,
            color: '#f5a623', weight: 1, opacity: 0.45, fillOpacity: 0.04,
        }).addTo(lrMapLayer);
    }

    // Driver positions come from the detail payload when a request is open.
    const detail = lrDetailCache.get(row.rideId);
    if (detail && Array.isArray(detail.driverPoints)) {
        for (const d of detail.driverPoints) {
            if (d.lat == null || d.lng == null) continue;
            const color = d.role === 'assigned' ? '#2ecc71' : d.role === 'offered' ? '#3498db' : '#7f8c9a';
            L.circleMarker([d.lat, d.lng], lrDot(color, d.role === 'assigned' ? 9 : 6))
                .bindTooltip(`${d.name} — ${d.roleLabel}`, { direction: 'top' })
                .addTo(lrMapLayer);
            points.push([d.lat, d.lng]);
        }
    }

    if (points.length) {
        try { lrMap.fitBounds(L.latLngBounds(points).pad(0.25), { maxZoom: 15 }); } catch { /* noop */ }
    }
}

// ── detail drawer ──────────────────────────────────────────────────────────

async function openRequestDrawer(rideId) {
    lrSelectedRideId = rideId;
    const drawer = document.getElementById('lr-drawer');
    const body = document.getElementById('lr-drawer-body');
    const title = document.getElementById('lr-drawer-title');
    const sub = document.getElementById('lr-drawer-sub');
    if (!drawer || !body) return;

    drawer.classList.remove('hidden');
    title.innerText = rideId;
    sub.innerText = 'Loading dispatch timeline…';
    body.innerHTML = '<div class="lr-empty"><i class="fas fa-spinner fa-spin"></i></div>';

    try {
        const detail = await adminFetch('/live-requests/' + encodeURIComponent(rideId));
        lrDetailCache.set(rideId, detail);
        renderRequestDrawer(detail);
        renderLiveRequests();
    } catch (e) {
        body.innerHTML = '<div class="lr-empty"><p>Could not load this request.</p></div>';
    }
}

function closeRequestDrawer() {
    lrSelectedRideId = null;
    const drawer = document.getElementById('lr-drawer');
    if (drawer) drawer.classList.add('hidden');
    renderLiveRequests();
}

function lrDeliveryBadge(state) {
    const m = LR_DELIVERY_META[state] || LR_DELIVERY_META.unknown;
    return `<span class="lr-delivery ${m.cls}"><i class="fas ${m.icon}"></i> ${m.label}</span>`;
}

function renderRequestDrawer(detail) {
    const body = document.getElementById('lr-drawer-body');
    const sub = document.getElementById('lr-drawer-sub');
    if (!body) return;

    const r = detail.ride || {};
    const p = detail.passenger || {};
    const s = detail.dispatchSummary || {};
    const meta = LR_STATUS_META[r.status] || { label: r.status, cls: '' };
    if (sub) sub.innerHTML = `<span class="lr-badge ${meta.cls}">${lrEsc(meta.label)}</span>
        <span class="lr-drawer-time">created ${lrClock(r.createdAt)}</span>`;

    const canReveal = lrRole === 'superadmin' || lrRole === 'support';

    body.innerHTML = `
    <div class="lr-drawer-grid">
        <div class="lr-panel">
            <h4><i class="fas fa-user"></i> Passenger</h4>
            <div class="lr-kv"><span>Name</span><b>${lrEsc(p.name)}</b></div>
            <div class="lr-kv"><span>Phone</span><b>${lrEsc(p.phoneMasked || '—')}</b></div>
            <div class="lr-kv"><span>Email</span><b>${lrEsc(p.emailMasked || '—')}</b></div>
            <div class="lr-kv"><span>Completed rides</span><b>${p.completedRides ?? 0}</b></div>
            <div class="lr-kv"><span>Cancelled rides</span><b>${p.cancelledRides ?? 0}</b></div>
            <div class="lr-kv"><span>App</span><b>${lrEsc(p.appVersion || 'unknown')} · ${lrEsc(p.platform || 'unknown')}</b></div>
            ${canReveal
                ? `<button class="btn-secondary lr-reveal" onclick="revealRideContact('${lrEsc(r.rideId)}')">
                     <i class="fas fa-eye"></i> Reveal contact (audited)</button>`
                : `<p class="lr-note">Your role cannot reveal contact details.</p>`}
        </div>

        <div class="lr-panel">
            <h4><i class="fas fa-route"></i> Trip</h4>
            <div class="lr-kv"><span>Pickup</span><b>${lrEsc(r.pickupArea || '—')}</b></div>
            <div class="lr-kv"><span>Pickup coords</span><b>${r.pickup ? `${r.pickup.lat.toFixed(5)}, ${r.pickup.lng.toFixed(5)}` : '—'}</b></div>
            <div class="lr-kv"><span>Destination</span><b>${lrEsc(r.destinationArea || '—')}</b></div>
            <div class="lr-kv"><span>Estimated fare</span><b>${lrMoney(r.estimatedFare)}</b></div>
            <div class="lr-kv"><span>Final fare</span><b>${lrMoney(r.finalFare)}</b></div>
            <div class="lr-kv"><span>Distance</span><b>${lrDistance(r.estimatedDistanceM)}</b></div>
            <div class="lr-kv"><span>Duration</span><b>${lrDuration(r.estimatedDurationSec)}</b></div>
            <div class="lr-kv"><span>Payment</span><b>${lrEsc(r.paymentMode)}</b></div>
        </div>

        <div class="lr-panel">
            <h4><i class="fas fa-tower-broadcast"></i> Dispatch summary</h4>
            <div class="lr-kv"><span>Current round</span><b>${s.dispatchRound ?? '—'}</b></div>
            <div class="lr-kv"><span>Search radius</span><b>${lrKm(s.radiusKm)}</b></div>
            <div class="lr-kv"><span>Candidates found</span><b>${s.candidateCount ?? 0}</b></div>
            <div class="lr-kv"><span>Eligible</span><b>${s.eligibleDriverCount ?? 0}</b></div>
            <div class="lr-kv"><span>Reserved</span><b>${s.reservedDriverCount ?? 0}</b></div>
            <div class="lr-kv"><span>Offers notified</span><b>${s.notifiedDriverCount ?? 0}</b></div>
            <div class="lr-kv"><span>Device acks</span><b>${s.acknowledgedCount ?? 0}</b></div>
            <div class="lr-kv"><span>Rejections</span><b>${s.rejectionCount ?? 0}</b></div>
            <div class="lr-kv"><span>Expired offers</span><b>${s.expiredOfferCount ?? 0}</b></div>
            <div class="lr-kv"><span>Delivery failures</span><b>${s.deliveryFailureCount ?? 0}</b></div>
            <div class="lr-kv"><span>Time to assignment</span><b>${lrMs(s.timeToAssignmentMs)}</b></div>
            ${s.finalOutcomeCode
                ? `<div class="lr-kv"><span>Final outcome</span><b>${lrEsc((LR_OUTCOME_META[s.finalOutcomeCode] || {}).label || s.finalOutcomeCode)}</b></div>`
                : ''}
            <div class="lr-kv"><span>Data source</span><b>${lrEsc(s.source || 'persisted')}</b></div>
        </div>
    </div>

    <h4 class="lr-section-h"><i class="fas fa-users"></i> Candidate drivers</h4>
    <div class="lr-candidates">
        ${(detail.candidates || []).length === 0
            ? '<p class="lr-note">No candidate drivers recorded for this request.</p>'
            : detail.candidates.map(c => `
            <div class="lr-cand">
                <div class="lr-cand-head">
                    <b>${lrEsc(c.name)}</b>
                    <span class="lr-cand-id">${lrEsc(c.driverId)}</span>
                    <span>${lrEsc(c.vehiclePlate || 'no plate')}</span>
                    <span class="lr-cand-outcome">${lrEsc(LR_OUTCOME_LABEL[c.outcome] || c.outcome)}</span>
                </div>
                <div class="lr-cand-meta">
                    <span>Round ${c.dispatchRound ?? '—'}</span>
                    <span>${lrKm(c.distanceKm)} away</span>
                    <span>HB age ${lrMs(c.heartbeatAgeMs)}</span>
                    <span>Loc age ${lrMs(c.locationAgeMs)}</span>
                    <span>Response ${lrMs(c.responseTimeMs)}</span>
                    ${lrDeliveryBadge(c.deliveryState)}
                    ${c.outcome === 'rejected'
                        ? '<span class="lr-note-inline">rejection reason not collected</span>' : ''}
                </div>
            </div>`).join('')}
    </div>

    <h4 class="lr-section-h"><i class="fas fa-timeline"></i> Dispatch timeline</h4>
    <div class="lr-timeline" id="lr-timeline">
        ${(detail.timeline || []).map(lrTimelineRow).join('')}
    </div>
    <p class="lr-note">
        Labels reflect only the strongest signal actually recorded. "FCM accepted" means the
        provider took the push, not that the handset received it. Only "Device acknowledged"
        proves the offer reached the driver's screen, and older driver app builds never send it.
    </p>`;

    // Driver map points, derived from the trail: offered vs merely eligible.
    detail.driverPoints = [];
    lrDrawMap(lrIndex.get(detail.ride.rideId) || null);
}

function lrTimelineRow(e) {
    const label = LR_EVENT_LABEL[e.eventType] || e.eventType;
    const who = e.driverName ? ` — ${lrEsc(e.driverName)}` : '';
    const extras = [];
    if (e.dispatchRound != null) extras.push('round ' + e.dispatchRound);
    if (e.radiusKm != null) extras.push(Number(e.radiusKm).toFixed(1) + ' km tier');
    if (e.distanceKm != null) extras.push(Number(e.distanceKm).toFixed(2) + ' km away');
    if (e.detail && e.detail.reason) extras.push(String(e.detail.reason));
    if (e.detail && e.detail.outcomeCode) extras.push(String(e.detail.outcomeCode));
    if (e.detail && e.detail.acceptedTokenCount) extras.push(e.detail.acceptedTokenCount + ' token(s)');
    return `<div class="lr-tl-row lr-tl-${lrEsc(e.eventType)}">
        <span class="lr-tl-time">${lrClock(e.occurredAt)}</span>
        <span class="lr-tl-label">${lrEsc(label)}${who}</span>
        ${extras.length ? `<span class="lr-tl-extra">${lrEsc(extras.join(' · '))}</span>` : ''}
    </div>`;
}

/** Live-append a pushed event to an open drawer, without refetching. */
function appendDrawerTimelineEvent(ev) {
    const tl = document.getElementById('lr-timeline');
    if (!tl) return;
    tl.insertAdjacentHTML('beforeend', lrTimelineRow({
        eventType: ev.eventType,
        occurredAt: ev.occurredAt,
        driverName: null,
        dispatchRound: ev.dispatchRound,
        radiusKm: ev.radiusKm,
        distanceKm: ev.distanceKm,
        detail: ev.detail,
    }));
    tl.scrollTop = tl.scrollHeight;
}

async function revealRideContact(rideId) {
    const reason = prompt('Reason for revealing contact details (recorded in the audit log):');
    if (reason == null) return;
    try {
        const data = await adminFetch('/live-requests/' + encodeURIComponent(rideId) + '/reveal-contact', 'POST', { reason });
        const lines = [];
        if (data.passenger) lines.push(`Passenger: ${data.passenger.name} · ${data.passenger.phone || '—'}`);
        if (data.driver) lines.push(`Driver: ${data.driver.name} · ${data.driver.phone || '—'}`);
        showToast(lines.join('\n') || 'No contact on file', 'success');
    } catch (e) {
        showToast('Reveal denied or failed', 'error');
    }
}

// ── dispatch metrics ───────────────────────────────────────────────────────

let dmData = null;

async function fetchDispatchMetrics() {
    const hours = (document.getElementById('dm-window') || {}).value || '24';
    try {
        dmData = await adminFetch('/dispatch/driver-metrics?hours=' + encodeURIComponent(hours));
        const u = document.getElementById('dm-updated');
        if (u) u.innerText = 'Updated ' + new Date().toLocaleTimeString();
        renderDispatchMetrics();
    } catch (e) {
        const u = document.getElementById('dm-updated');
        if (u) u.innerText = 'Failed to load metrics';
    }
}

const DM_FLAG_LABEL = {
    notification_delivery_help: 'Push delivery help',
    battery_or_network_help: 'Battery / network help',
    ack_unsupported_or_app_update: 'App update needed',
    operational_follow_up: 'Operational follow-up',
    training_conversation: 'Training conversation',
};

function renderDispatchMetrics() {
    const body = document.getElementById('dm-list');
    if (!body || !dmData) return;
    const q = ((document.getElementById('dm-search') || {}).value || '').toLowerCase().trim();
    const flag = (document.getElementById('dm-flag') || {}).value || 'all';

    const rows = (dmData.metrics || []).filter(m => {
        if (q && !`${m.name} ${m.vehiclePlate || ''}`.toLowerCase().includes(q)) return false;
        if (flag === 'flagged' && (m.suggestedFollowUp || []).length === 0) return false;
        if (flag !== 'all' && flag !== 'flagged' && !(m.suggestedFollowUp || []).includes(flag)) return false;
        return true;
    });

    if (!rows.length) {
        body.innerHTML = '<tr><td colspan="11">No dispatch activity in this window.</td></tr>';
        return;
    }

    body.innerHTML = rows.map(m => `
        <tr>
            <td><b>${lrEsc(m.name)}</b><br><span class="lr-cand-id">${lrEsc(m.vehiclePlate || m.driverId)}</span></td>
            <td>${m.offersNotified}</td>
            <td>${m.deviceAcknowledged}</td>
            <td>${m.accepted}</td>
            <td>${m.explicitRejects}</td>
            <td>${m.offerExpiries}</td>
            <td>${m.notificationDeliveryFailures > 0 ? `<span class="lr-warn">${m.notificationDeliveryFailures}</span>` : 0}</td>
            <td>${m.staleHeartbeatOccurrences}</td>
            <td>${lrMs(m.medianResponseMs)}</td>
            <td>${m.acceptanceRate == null ? '—' : Math.round(m.acceptanceRate * 100) + '%'}</td>
            <td>${(m.suggestedFollowUp || []).map(f =>
                `<span class="lr-badge lr-flag">${lrEsc(DM_FLAG_LABEL[f] || f)}</span>`).join(' ') || '—'}</td>
        </tr>`).join('');
}
