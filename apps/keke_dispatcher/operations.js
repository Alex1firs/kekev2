/*
 * Operations Dispatch — the phone surface.
 *
 * A field interface, not an admin dashboard. The dispatcher using this is
 * standing up, holding the phone in one hand, and about to ring somebody. So:
 * cards not tables, one column, large touch targets, and the single most
 * important fact about each ride visible without opening it.
 *
 * Lives alongside the park-dispatch workspace rather than replacing it. A
 * staff member with ops:queue_read gets the switch; everyone else never sees
 * it and nothing about their app changes.
 */
(function () {
    'use strict';

    const OPS = {
        active: false,
        rides: [],
        counts: {},
        tab: 'attention',        // attention | live | drivers | history
        selected: null,          // rideId of the open detail sheet
        drivers: [],
        driverCategory: 'ALL',
        interventions: [],
        config: null,
        /** Rides this dispatcher currently holds a lease on. */
        owned: new Set(),
        renewTimer: null,
        pollTimer: null,
        busy: false,
        /** True while the reason picker is open. */
        reassigning: false,
    };

    const $$ = (id) => document.getElementById(id);
    const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
        ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

    /** Whoever loaded this page — the park app owns the session. */
    const api = (path, method, body) => window.__kdApi(path, method, body);
    const toast = (m, k) => window.__kdToast(m, k);
    const me = () => window.__kdMe();

    function canOps() {
        const p = me()?.permissions || [];
        return p.includes('ops:queue_read');
    }
    const can = (perm) => (me()?.permissions || []).includes(perm);

    // ── Time and formatting ─────────────────────────────────────────────

    function waited(seconds) {
        if (seconds == null) return '—';
        if (seconds < 60) return `${seconds}s`;
        const m = Math.floor(seconds / 60);
        return m < 60 ? `${m}m ${seconds % 60}s` : `${Math.floor(m / 60)}h ${m % 60}m`;
    }

    function ago(seconds) {
        if (seconds == null) return 'never';
        if (seconds < 60) return `${seconds}s ago`;
        const m = Math.floor(seconds / 60);
        return m < 60 ? `${m}m ago` : `${Math.floor(m / 60)}h ago`;
    }

    const TRIGGER_TEXT = {
        NO_ELIGIBLE_DRIVER: 'No eligible driver',
        NO_DRIVER_ACCEPTED: 'Nobody accepted',
        WAIT_EXCEEDS_THRESHOLD: 'Waiting a long time',
        TECHNICAL_FAILURE: 'Dispatch failed',
        DISPATCH_EXHAUSTED: 'Dispatch exhausted',
    };

    const STATE_TEXT = {
        AUTO_HEALTHY: 'Auto dispatch working',
        NEEDS_ATTENTION: 'Needs attention',
        OPERATIONS_CONTROL: 'You have control',
        ASSIGNED: 'Driver assigned',
        COMPLETED: 'Completed',
        CANCELLED: 'Cancelled',
        FAILED: 'Failed',
    };

    // ── Data ────────────────────────────────────────────────────────────

    async function refresh() {
        if (!OPS.active) return;
        try {
            const data = await api('/operations/queue');
            OPS.rides = data.rows || [];
            OPS.counts = data.counts || {};
            OPS.config = data.config || null;
            // Keep the owned set honest: a lease we lost (expiry, someone
            // else's takeover, an assignment) must stop being renewed.
            const mineNow = new Set(
                OPS.rides
                    .filter((r) => r.control?.mode === 'operations'
                                && r.control?.ownerStaffId === me()?.staffUserId)
                    .map((r) => r.rideId),
            );
            for (const id of OPS.owned) {
                if (!mineNow.has(id)) OPS.owned.delete(id);
            }
            for (const id of mineNow) OPS.owned.add(id);
            render();
        } catch (e) {
            // A failed poll leaves the last board up rather than blanking it.
            console.warn('[OPS] refresh failed', e?.message);
        }
    }

    /**
     * Renew every lease we hold, on a timer.
     *
     * This is what a lease costs: the client must keep saying it is alive. A
     * failed renewal is not treated as fatal — the next tick tries again, and
     * the server decides when control really lapses.
     */
    async function renewLeases() {
        for (const rideId of [...OPS.owned]) {
            try {
                await api(`/operations/rides/${encodeURIComponent(rideId)}/renew`, 'POST', {});
            } catch (e) {
                // 409 means the lease is genuinely gone. Anything else is
                // probably transient and worth another tick.
                if (/409/.test(String(e?.message))) OPS.owned.delete(rideId);
            }
        }
    }

    // ── Actions ─────────────────────────────────────────────────────────

    async function takeover(rideId) {
        if (OPS.busy) return;
        OPS.busy = true;
        try {
            const r = await api(`/operations/rides/${encodeURIComponent(rideId)}/takeover`, 'POST', {});
            OPS.owned.add(rideId);
            toast(r.idempotent ? 'You already had control.' : 'You have control of this ride.', 'ok');
            await refresh();
        } catch (e) {
            // Losing the race is an outcome, not a fault — say who has it.
            toast(e?.message || 'Could not take control.', 'warn');
            await refresh();
        } finally {
            OPS.busy = false;
        }
    }

    async function release(rideId) {
        if (OPS.busy) return;
        OPS.busy = true;
        try {
            const ride = OPS.rides.find((r) => r.rideId === rideId);
            await api(`/operations/rides/${encodeURIComponent(rideId)}/release`, 'POST',
                { version: ride?.control?.version });
            OPS.owned.delete(rideId);
            toast('Back to automatic dispatch.', 'ok');
            await refresh();
        } catch (e) {
            toast(e?.message || 'Could not release control.', 'warn');
            await refresh();
        } finally {
            OPS.busy = false;
        }
    }

    const REASSIGN_REASONS = [
        ['DRIVER_DECLINED_MANUALLY', 'Driver declined'],
        ['DRIVER_UNAVAILABLE', 'Driver unavailable'],
        ['DRIVER_CANNOT_REACH_PICKUP', 'Cannot reach pickup'],
        ['DRIVER_VEHICLE_PROBLEM', 'Vehicle problem'],
        ['DRIVER_REQUESTED_REASSIGNMENT', 'Driver asked to be swapped'],
        ['OPERATIONS_CORRECTION', 'Operations correction'],
        ['OTHER', 'Other'],
    ];

    /**
     * Take the assigned driver off the ride so another can be chosen.
     *
     * A reason is required, not optional: "how often does a manually-assigned
     * driver fall through, and why" is the question this data exists to
     * answer, and a nullable free-text field would never answer it.
     */
    async function releaseDriver(rideId, reason) {
        if (OPS.busy) return;
        OPS.busy = true;
        try {
            await api(`/operations/rides/${encodeURIComponent(rideId)}/release-driver`, 'POST', { reason });
            toast('Driver released. Choose another.', 'ok');
            OPS.reassigning = false;
            await refresh();
            await loadDrivers(rideId);
        } catch (e) {
            // A started trip is the important refusal — it carries the
            // incident-workflow sentence from the server.
            toast(e?.message || 'Could not release the driver.', 'warn');
            await refresh();
        } finally {
            OPS.busy = false;
        }
    }

    async function assign(rideId, driverId) {
        if (OPS.busy) return;
        OPS.busy = true;
        try {
            await api(`/operations/rides/${encodeURIComponent(rideId)}/assign`, 'POST',
                { driverId, reason: 'OPERATIONS_INTERVENTION' });
            toast('Driver assigned.', 'ok');
            OPS.owned.delete(rideId);
            OPS.selected = null;
            await refresh();
        } catch (e) {
            toast(e?.message || 'Could not assign.', 'warn');
            await loadDrivers(rideId);
        } finally {
            OPS.busy = false;
        }
    }

    /**
     * Ring a driver.
     *
     * The number is fetched at the moment of the tap rather than shipped with
     * the driver list — a list of forty drivers should not put forty real
     * numbers into a browser that might be sitting unlocked on a bench. The
     * same request is the audited record that somebody decided to call.
     *
     * Then it actually dials. Previously this recorded the intent and showed a
     * toast telling the operator to go and find the number in the admin
     * console, which on a phone reads as the button doing nothing.
     */
    async function contactDriver(rideId, driver) {
        let contact = null;
        try {
            contact = await api(`/operations/rides/${encodeURIComponent(rideId)}/contact-driver`, 'POST', {
                driverId: driver.driverId,
                presence: driver.presence,
                distanceKm: driver.distanceKm,
                lastSeenSeconds: driver.lastSeenSeconds,
            });
        } catch (e) {
            toast(e?.message || 'Could not record the call.', 'warn');
            return;
        }

        if (!contact?.dialable) {
            toast('Phone number unavailable for this driver.', 'warn');
            return;
        }
        dial(contact.dialable, contact.name || driver.name);
    }

    /**
     * Hand a number to the OS dialer, with a visible way out if it refuses.
     *
     * A synthesised anchor click is used rather than assigning location.href:
     * the tap has already been through an await by this point, and some
     * installed-PWA contexts drop a programmatic navigation that is no longer
     * attached to a user gesture. If the dialer does not come up the operator
     * is left looking at a screen that did nothing — so the number is also
     * rendered as a real link they can tap themselves, plus a copy button.
     */
    function dial(number, who) {
        let launched = false;
        try {
            const a = document.createElement('a');
            a.href = `tel:${number}`;
            a.style.display = 'none';
            document.body.appendChild(a);
            a.click();
            a.remove();
            launched = true;
        } catch (err) {
            console.warn('[OPS] dialer launch failed', err?.message);
        }
        // Shown regardless. On a handset the dialer covers it; coming back, the
        // operator still has the number in front of them for a second attempt.
        showCallFallback(number, who, launched);
    }

    function showCallFallback(number, who, launched) {
        const box = $$('ops-call-fallback');
        if (!box) return;
        box.innerHTML = `
          <div class="ops-call-card">
            <div class="ops-call-who">${esc(who)}</div>
            <a class="ops-call-number" href="tel:${esc(number)}">${esc(number)}</a>
            <div class="ops-call-actions">
              <a class="ops-btn" href="tel:${esc(number)}">Call now</a>
              <button class="ops-btn-ghost" data-copy="${esc(number)}">Copy</button>
              <button class="ops-btn-ghost" data-call-dismiss="1">Done</button>
            </div>
            ${launched ? '' : '<div class="ops-call-note">The dialer did not open. Tap the number above.</div>'}
          </div>`;
        box.classList.remove('hidden');
    }

    async function loadDrivers(rideId) {
        try {
            const data = await api(
                `/operations/rides/${encodeURIComponent(rideId)}/drivers?category=${OPS.driverCategory}`);
            OPS.drivers = data.drivers || [];
        } catch {
            OPS.drivers = [];
        }
        render();
    }

    async function loadInterventions(rideId) {
        try {
            const d = await api(`/operations/rides/${encodeURIComponent(rideId)}/interventions`);
            OPS.interventions = d.interventions || [];
        } catch {
            OPS.interventions = [];
        }
        render();
    }

    // ── Rendering ───────────────────────────────────────────────────────

    function rideCard(r) {
        const mine = r.control?.ownerStaffId === me()?.staffUserId
                  && r.control?.mode === 'operations';
        const sev = r.attention?.severity || 'none';
        const cls = mine ? 'ops-card-mine'
            : sev === 'urgent' ? 'ops-card-urgent'
            : sev === 'warning' ? 'ops-card-warn' : '';

        const triggers = (r.attention?.triggers || [])
            .map((t) => `<span class="ops-chip">${esc(TRIGGER_TEXT[t] || t)}</span>`).join('');

        // The single most useful supply fact, stated plainly.
        const supply = r.candidateCount === 0
            ? 'no drivers found'
            : `${r.eligibleDriverCount}/${r.candidateCount} eligible · ${r.offersSent} offered`;

        return `
        <article class="ops-card ${cls}" data-ride="${esc(r.rideId)}">
          <div class="ops-card-top">
            <div class="ops-wait">${esc(waited(r.waitingSeconds))}</div>
            <div class="ops-state">${esc(STATE_TEXT[r.queueState] || r.queueState)}</div>
          </div>
          <div class="ops-route">
            <div class="ops-leg"><span class="ops-dot ops-dot-a"></span>
              ${esc(r.pickupArea || r.pickupAddress || 'Area not recorded')}</div>
            <div class="ops-leg"><span class="ops-dot ops-dot-b"></span>
              ${esc(r.destinationArea || r.destinationAddress || 'Area not recorded')}</div>
          </div>
          <div class="ops-meta">
            <span>${esc(r.passenger?.name || 'Unknown passenger')}</span>
            <span>${r.fare != null ? '₦' + Number(r.fare).toLocaleString() : '—'}</span>
          </div>
          <div class="ops-supply">${esc(supply)}</div>
          ${triggers ? `<div class="ops-chips">${triggers}</div>` : ''}
          ${r.control?.mode === 'operations' && !mine
            ? `<div class="ops-owner">Held by ${esc(r.control.ownerLabel || 'another dispatcher')}</div>` : ''}
        </article>`;
    }

    function driverRow(d, rideId) {
        const dist = d.distanceKm == null ? '—'
            : `${d.distanceKm} km${d.distanceIsLastKnown ? '' : ''}`;
        // Stale intelligence is labelled, always. A 40-minute-old fix must
        // never read as "where this driver is".
        const lastKnown = d.distanceIsLastKnown
            ? `<span class="ops-stale">last known ${esc(ago(d.lastKnownAgeSeconds))}</span>` : '';

        return `
        <div class="ops-driver ${d.assignable ? '' : 'ops-driver-blocked'}">
          <div class="ops-driver-main">
            <div class="ops-driver-name">
              ${d.favourite ? '<span class="ops-star">★</span>' : ''}${esc(d.name)}
            </div>
            <div class="ops-driver-sub">
              ${esc(d.vehiclePlate || 'no plate')} · ${esc(d.presence.toLowerCase().replace('_', ' '))}
              ${d.presence !== 'ONLINE' ? ' · seen ' + esc(ago(d.lastSeenSeconds)) : ''}
            </div>
            <div class="ops-driver-sub">${esc(dist)} ${lastKnown}</div>
            ${d.assignable ? '' :
              `<div class="ops-driver-block">${esc(d.ineligibleExplanation || 'Cannot assign')}</div>`}
          </div>
          <div class="ops-driver-actions">
            ${can('ops:contact_driver')
              ? `<button class="ops-btn-ghost" data-call="${esc(d.driverId)}">Call</button>` : ''}
            ${d.assignable && can('ops:assign')
              ? `<button class="ops-btn" data-assign="${esc(d.driverId)}">Assign</button>`
              : `<button class="ops-btn" disabled>Assign</button>`}
          </div>
        </div>`;
    }

    function detailSheet(r) {
        const mine = r.control?.ownerStaffId === me()?.staffUserId
                  && r.control?.mode === 'operations';
        const held = r.control?.mode === 'operations';

        return `
        <div class="ops-sheet-head">
          <div>
            <div class="ops-sheet-title">${esc(r.pickupArea || 'Area not recorded')} → ${esc(r.destinationArea || '—')}</div>
            <div class="ops-sheet-sub">${esc(r.passenger?.name || 'Unknown')} · waiting ${esc(waited(r.waitingSeconds))}</div>
          </div>
          <button class="ops-close" data-close="1" aria-label="Close">✕</button>
        </div>

        <div class="ops-sheet-body">
          <!-- The state is a sentence, not a number. Keeping it in the numeric
               grid made "You have control" wrap to three lines on a 360px
               phone and threw the whole row out of alignment. -->
          <div class="ops-status-line ${r.queueState === 'OPERATIONS_CONTROL' ? 'ops-status-control' : ''}">
            ${esc(STATE_TEXT[r.queueState] || r.queueState)}
            ${r.control?.mode === 'operations' && r.control?.ownerLabel
              ? `<span>· ${esc(r.control.ownerLabel)}</span>` : ''}
          </div>

          <div class="ops-facts">
            <div><span>Round</span><strong>${r.dispatchRound ?? '—'}</strong></div>
            <div><span>Radius</span><strong>${r.radiusKm != null ? r.radiusKm + ' km' : '—'}</strong></div>
            <div><span>Found</span><strong>${r.candidateCount}</strong></div>
            <div><span>Eligible</span><strong>${r.eligibleDriverCount}</strong></div>
            <div><span>Offered</span><strong>${r.offersSent}</strong></div>
            <div><span>Declined</span><strong>${r.rejected}</strong></div>
            <div><span>No answer</span><strong>${r.expired}</strong></div>
          </div>

          <div class="ops-addr">
            <div><span class="ops-dot ops-dot-a"></span> ${esc(r.pickupAddress || 'No address captured')}</div>
            <div><span class="ops-dot ops-dot-b"></span> ${esc(r.destinationAddress || 'No address captured')}</div>
          </div>

          ${r.driver ? `
          <div class="ops-section">
            <h4>Assigned driver</h4>
            <div class="ops-assigned">
              <div class="ops-assigned-main">
                <div class="ops-driver-name">${esc(r.driver.name)}</div>
                <div class="ops-driver-sub">${esc(r.driver.phoneMasked || 'no number on file')}</div>
              </div>
              <div class="ops-driver-actions">
                ${can('ops:contact_driver')
                  ? `<button class="ops-btn-ghost" data-call-assigned="${esc(r.driver.id)}">Call</button>` : ''}
              </div>
            </div>
            ${mine && can('ops:assign') && ['ASSIGNED'].includes(r.queueState) ? (
              OPS.reassigning ? `
              <div class="ops-reassign">
                <div class="ops-reassign-title">Why is this driver being taken off?</div>
                ${REASSIGN_REASONS.map(([code, label]) =>
                  `<button class="ops-btn-ghost ops-reason" data-release-reason="${code}">${esc(label)}</button>`).join('')}
                <button class="ops-btn-ghost" data-reassign-cancel="1">Cancel</button>
              </div>`
              : `<button class="ops-btn-ghost ops-btn-big" data-reassign="1">Reassign driver</button>`
            ) : ''}
            ${!mine && r.queueState === 'ASSIGNED' && can('ops:takeover')
              ? '<p class="ops-note">Take control of this ride to reassign the driver.</p>' : ''}
          </div>` : ''}

          <div class="ops-actions">
            ${!held && can('ops:takeover')
              ? `<button class="ops-btn ops-btn-big" data-takeover="${esc(r.rideId)}">Take over dispatch</button>` : ''}
            ${mine && can('ops:release')
              ? `<button class="ops-btn-ghost ops-btn-big" data-release="${esc(r.rideId)}">Release to auto</button>` : ''}
            ${held && !mine
              ? `<div class="ops-owner">Held by ${esc(r.control.ownerLabel || 'another dispatcher')}</div>` : ''}
          </div>

          ${mine ? `
          <div class="ops-section">
            <div class="ops-section-head">
              <h4>Drivers</h4>
              <select id="ops-driver-cat">
                ${['ALL','ONLINE','NEARBY','FAVOURITE','OFFLINE','AT_PARK','BUSY']
                  .map((c) => `<option value="${c}" ${OPS.driverCategory===c?'selected':''}>${c.replace('_',' ')}</option>`).join('')}
              </select>
            </div>
            <div class="ops-drivers">
              ${OPS.drivers.length
                ? OPS.drivers.map((d) => driverRow(d, r.rideId)).join('')
                : '<div class="ops-empty">No drivers in this category.</div>'}
            </div>
          </div>` : `
          <p class="ops-note">Take control to see drivers and assign one.</p>`}

          <div class="ops-section">
            <h4>Intervention history</h4>
            ${OPS.interventions.length ? `<ul class="ops-history">${OPS.interventions.map((i) => `
              <li><span>${esc(new Date(i.createdAt).toLocaleTimeString())}</span>
                  ${esc(i.type.replace(/_/g, ' '))}${i.staffLabel ? ' · ' + esc(i.staffLabel) : ''}
                  ${i.outcomeCode ? ` <em>${esc(i.outcomeCode)}</em>` : ''}</li>`).join('')}</ul>`
              : '<div class="ops-empty">Nobody has intervened on this ride.</div>'}
          </div>
        </div>`;
    }

    function render() {
        if (!OPS.active) return;
        const root = $$('ops-root');
        if (!root) return;

        const attention = OPS.rides.filter((r) =>
            r.queueState === 'NEEDS_ATTENTION' || r.queueState === 'OPERATIONS_CONTROL');
        const live = OPS.rides.filter((r) =>
            ['AUTO_HEALTHY', 'NEEDS_ATTENTION', 'OPERATIONS_CONTROL', 'ASSIGNED'].includes(r.queueState));
        const list = OPS.tab === 'attention' ? attention : live;

        root.innerHTML = `
          <div class="ops-tabs">
            <button class="${OPS.tab==='attention'?'on':''}" data-tab="attention">
              Needs attention ${attention.length ? `<span class="ops-badge">${attention.length}</span>` : ''}
            </button>
            <button class="${OPS.tab==='live'?'on':''}" data-tab="live">
              Live ${live.length ? `<span class="ops-badge">${live.length}</span>` : ''}
            </button>
          </div>
          <div class="ops-list">
            ${list.length ? list.map(rideCard).join('')
              : `<div class="ops-empty ops-empty-big">
                   ${OPS.tab === 'attention'
                     ? 'Nothing needs you right now. Automatic dispatch is coping.'
                     : 'No live requests.'}
                 </div>`}
          </div>`;

        const sheet = $$('ops-sheet');
        const ride = OPS.selected ? OPS.rides.find((r) => r.rideId === OPS.selected) : null;
        if (ride) {
            sheet.innerHTML = detailSheet(ride);
            sheet.classList.remove('hidden');
        } else {
            sheet.classList.add('hidden');
            sheet.innerHTML = '';
        }
    }

    // ── Wiring ──────────────────────────────────────────────────────────

    function onClick(e) {
        const tab = e.target.closest('[data-tab]');
        if (tab) { OPS.tab = tab.dataset.tab; render(); return; }

        if (e.target.closest('[data-close]')) { OPS.selected = null; render(); return; }

        const to = e.target.closest('[data-takeover]');
        if (to) { takeover(to.dataset.takeover).then(() => loadDrivers(to.dataset.takeover)); return; }

        const rel = e.target.closest('[data-release]');
        if (rel) { release(rel.dataset.release); return; }

        const asg = e.target.closest('[data-assign]');
        if (asg && OPS.selected) { assign(OPS.selected, asg.dataset.assign); return; }

        if (e.target.closest('[data-reassign]')) { OPS.reassigning = true; render(); return; }
        if (e.target.closest('[data-reassign-cancel]')) { OPS.reassigning = false; render(); return; }

        const rr = e.target.closest('[data-release-reason]');
        if (rr && OPS.selected) { releaseDriver(OPS.selected, rr.dataset.releaseReason); return; }

        // Calling the driver who is already assigned, from the summary panel.
        const ca = e.target.closest('[data-call-assigned]');
        if (ca && OPS.selected) {
            const r = OPS.rides.find((x) => x.rideId === OPS.selected);
            contactDriver(OPS.selected, {
                driverId: ca.dataset.callAssigned,
                name: r?.driver?.name,
                presence: 'ASSIGNED',
                distanceKm: null,
                lastSeenSeconds: null,
            });
            return;
        }

        const copy = e.target.closest('[data-copy]');
        if (copy) {
            const n = copy.dataset.copy;
            navigator.clipboard?.writeText(n)
                .then(() => toast('Number copied.', 'ok'))
                .catch(() => toast(`Copy unavailable — the number is ${n}`, 'warn'));
            return;
        }
        if (e.target.closest('[data-call-dismiss]')) {
            $$('ops-call-fallback')?.classList.add('hidden');
            return;
        }

        const call = e.target.closest('[data-call]');
        if (call && OPS.selected) {
            const d = OPS.drivers.find((x) => x.driverId === call.dataset.call);
            if (d) contactDriver(OPS.selected, d);
            return;
        }

        const card = e.target.closest('[data-ride]');
        if (card) {
            OPS.selected = card.dataset.ride;
            OPS.interventions = [];
            OPS.drivers = [];
            OPS.reassigning = false;
            render();
            loadInterventions(OPS.selected);
            const r = OPS.rides.find((x) => x.rideId === OPS.selected);
            if (r?.control?.ownerStaffId === me()?.staffUserId) loadDrivers(OPS.selected);
        }
    }

    function onChange(e) {
        if (e.target.id === 'ops-driver-cat') {
            OPS.driverCategory = e.target.value;
            if (OPS.selected) loadDrivers(OPS.selected);
        }
    }

    /**
     * Show one ride. Observation only — no side effects on dispatch.
     */
    function openRide(rideId) {
        if (!OPS.active) enter();
        OPS.selected = rideId;
        OPS.interventions = [];
        OPS.drivers = [];
        OPS.reassigning = false;
        render();
        loadInterventions(rideId);
        refresh().then(() => {
            const r = OPS.rides.find((x) => x.rideId === rideId);
            if (r?.control?.ownerStaffId === me()?.staffUserId) loadDrivers(rideId);
        });
    }

    function enter() {
        if (!canOps()) { toast('You do not have Operations access.', 'warn'); return; }
        OPS.active = true;
        $$('ops-screen').classList.remove('hidden');
        document.getElementById('workspace')?.classList.add('hidden');
        document.getElementById('shift-gate')?.classList.add('hidden');
        refresh();
        OPS.pollTimer = setInterval(refresh, 8000);
        // Renewal cadence comes from the server's config, halved so a single
        // missed tick never costs the lease.
        const renewMs = Math.max(10_000, (OPS.config?.leaseRenewIntervalMs || 30_000));
        OPS.renewTimer = setInterval(renewLeases, renewMs);

        const deepLink = pendingDeepLink();
        if (deepLink) { clearDeepLink(); openRide(deepLink); }
    }

    function leave() {
        OPS.active = false;
        clearInterval(OPS.pollTimer); OPS.pollTimer = null;
        clearInterval(OPS.renewTimer); OPS.renewTimer = null;
        $$('ops-screen').classList.add('hidden');
    }

    /**
     * A notification tap lands here with ?ops=1&ride=<id>.
     *
     * Opening a ride from an alert must NEVER take control — the dispatcher is
     * looking, not committing, and automatic dispatch carries on exactly as it
     * was. Takeover is only ever the explicit button.
     */
    function pendingDeepLink() {
        try {
            const q = new URLSearchParams(location.search);
            if (q.get('ops') !== '1') return null;
            return q.get('ride') || null;
        } catch { return null; }
    }

    /** Consume the deep link so a later reload does not reopen the same ride. */
    function clearDeepLink() {
        try {
            const u = new URL(location.href);
            u.searchParams.delete('ops');
            u.searchParams.delete('ride');
            history.replaceState({}, '', u.toString());
        } catch { /* a browser that refuses is not a reason to fail */ }
    }

    function init() {
        document.addEventListener('click', onClick);
        document.addEventListener('change', onChange);

        // A push tap while the app is already open arrives as a message from
        // the service worker rather than as a fresh page load.
        navigator.serviceWorker?.addEventListener?.('message', (ev) => {
            const rideId = ev?.data?.rideId;
            if (ev?.data?.type === 'OPS_OPEN_RIDE' && rideId) openRide(rideId);
        });
        $$('ops-exit')?.addEventListener('click', () => {
            leave();
            document.getElementById('shift-gate')?.classList.remove('hidden');
        });
    }

    window.__kdOps = { init, enter, leave, canOps, openRide, pendingDeepLink, refresh: () => refresh(), state: OPS };
})();
