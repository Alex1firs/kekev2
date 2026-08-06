/**
 * Communications Centre — calendar, analytics, insights, previews, history.
 *
 * ── Why the charts are hand-drawn SVG ────────────────────────────────────
 * No chart library. The admin dashboard is served by nginx with a strict origin
 * and no build step, so a charting dependency would mean either a CDN request
 * (another origin to trust, and one that can go down) or a vendored bundle
 * nobody updates. These charts are bar, line and donut — three shapes — and
 * drawing them directly is less code than configuring a library to draw them.
 *
 * ── Every chart states its denominator ───────────────────────────────────
 * An open rate with no visible denominator is a number somebody will repeat in
 * a meeting. The backend returns the counts alongside the rates and the tiles
 * show both.
 *
 * ── "Not instrumented" is drawn differently from zero ────────────────────
 * A flat line reading "nobody opened it" and a flat line reading "nothing is
 * counting opens" are the same picture and opposite facts. Channels the backend
 * marks `instrumented: false` get a hatched panel and the reason, never a zero.
 *
 * Loaded after app.js; uses its adminFetch, escapeHtml and showToast.
 */

/* global adminFetch, escapeHtml, showToast, ccSwitch, ccOpen, ccCampaignId */

// ═══════════════════════════════════════════════════════════════════════
//  Small drawing helpers
// ═══════════════════════════════════════════════════════════════════════

const CP_PALETTE = {
    email: '#60a5fa', push: '#a78bfa', in_app: '#34d399', sms: '#fbbf24',
    good: '#34d399', warn: '#fbbf24', bad: '#f87171', muted: '#64748b',
};

const CP_STATUS = {
    draft:             { label: 'Draft',            colour: '#94a3b8' },
    awaiting_approval: { label: 'Awaiting approval', colour: '#fbbf24' },
    approved:          { label: 'Approved',          colour: '#60a5fa' },
    scheduled:         { label: 'Scheduled',         colour: '#a78bfa' },
    sending:           { label: 'Running',           colour: '#34d399' },
    paused:            { label: 'Paused',            colour: '#fb923c' },
    completed:         { label: 'Completed',         colour: '#22d3ee' },
    cancelled:         { label: 'Cancelled',         colour: '#64748b' },
    failed:            { label: 'Failed',            colour: '#f87171' },
};

const cpNum = (n) => (n == null ? '—' : Number(n).toLocaleString());
const cpPct = (n) => (n == null ? '—' : `${n}%`);

/** A horizontal bar chart. Values are labelled; no axis to misread. */
function cpBars(items, opts = {}) {
    const max = Math.max(1, ...items.map((i) => i.value || 0));
    return `<div class="cp-bars">${items.map((i) => `
        <div class="cp-bar-row">
            <span class="cp-bar-label">${escapeHtml(i.label)}</span>
            <span class="cp-bar-track">
                <span class="cp-bar-fill" style="width:${Math.round((i.value / max) * 100)}%;
                    background:${i.colour || opts.colour || CP_PALETTE.email}"></span>
            </span>
            <span class="cp-bar-value">${cpNum(i.value)}${i.suffix || ''}</span>
        </div>`).join('')}</div>`;
}

/**
 * A donut. Renders a single grey ring when everything is zero, rather than
 * nothing at all — an absent chart reads as a broken page.
 */
function cpDonut(segments, centreLabel, centreValue) {
    const total = segments.reduce((s, x) => s + (x.value || 0), 0);
    const R = 52, C = 2 * Math.PI * R;
    let offset = 0;

    const rings = total === 0
        ? `<circle cx="60" cy="60" r="${R}" fill="none" stroke="rgba(148,163,184,0.18)" stroke-width="14"/>`
        : segments.filter((s) => s.value > 0).map((s) => {
            const len = (s.value / total) * C;
            const dash = `${len} ${C - len}`;
            const el = `<circle cx="60" cy="60" r="${R}" fill="none" stroke="${s.colour}"
                stroke-width="14" stroke-dasharray="${dash}" stroke-dashoffset="${-offset}"
                transform="rotate(-90 60 60)"><title>${escapeHtml(s.label)}: ${s.value}</title></circle>`;
            offset += len;
            return el;
        }).join('');

    return `
    <div class="cp-donut">
        <svg viewBox="0 0 120 120" width="120" height="120" role="img"
             aria-label="${escapeHtml(centreLabel)}: ${escapeHtml(String(centreValue))}">
            ${rings}
            <text x="60" y="56" text-anchor="middle" class="cp-donut-value">${escapeHtml(String(centreValue))}</text>
            <text x="60" y="74" text-anchor="middle" class="cp-donut-label">${escapeHtml(centreLabel)}</text>
        </svg>
        <ul class="cp-legend">
            ${segments.map((s) => `<li>
                <span class="cp-swatch" style="background:${s.colour}"></span>
                ${escapeHtml(s.label)} <strong>${cpNum(s.value)}</strong>
            </li>`).join('')}
        </ul>
    </div>`;
}

/**
 * A multi-series line chart over days.
 *
 * Days with no activity are plotted as zero rather than skipped — a line that
 * omits empty days silently compresses time and turns a gap into a plateau.
 */
function cpLines(series, days) {
    const W = 720, H = 180, PAD = 28;
    const n = Math.max(days.length, 2);
    const max = Math.max(1, ...series.flatMap((s) => s.values));
    const x = (i) => PAD + (i * (W - PAD * 2)) / (n - 1);
    const y = (v) => H - PAD - (v / max) * (H - PAD * 2);

    /*
     * Gridline labels are de-duplicated. With a max of 1 the three fractions
     * round to 0, 1, 1 — an axis reading "1, 1, 0" makes the chart look broken
     * even when the data is a perfectly correct flat zero.
     */
    const seen = new Set();
    const gridlines = [0, 0.5, 1].map((f) => {
        const value = Math.round(max * f);
        const label = seen.has(value) ? '' : String(value);
        seen.add(value);
        return `
        <line x1="${PAD}" x2="${W - PAD}" y1="${y(max * f)}" y2="${y(max * f)}"
              stroke="rgba(148,163,184,0.14)" stroke-width="1"/>
        ${label ? `<text x="4" y="${y(max * f) + 4}" class="cp-axis">${label}</text>` : ''}`;
    }).join('');

    const paths = series.map((s) => {
        const d = s.values.map((v, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
        return `<path d="${d}" fill="none" stroke="${s.colour}" stroke-width="2"
                      stroke-linejoin="round" stroke-linecap="round"/>`;
    }).join('');

    // Label the ends only. A tick per day is unreadable at 30 days and
    // pointless at 7.
    const first = days[0] ? days[0].slice(5) : '';
    const last = days[days.length - 1] ? days[days.length - 1].slice(5) : '';

    return `
    <div class="cp-chart">
        <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" class="cp-linechart">
            ${gridlines}${paths}
            <text x="${PAD}" y="${H - 6}" class="cp-axis">${escapeHtml(first)}</text>
            <text x="${W - PAD}" y="${H - 6}" text-anchor="end" class="cp-axis">${escapeHtml(last)}</text>
        </svg>
        <ul class="cp-legend cp-legend-row">
            ${series.map((s) => `<li><span class="cp-swatch" style="background:${s.colour}"></span>
                ${escapeHtml(s.label)}</li>`).join('')}
        </ul>
    </div>`;
}

// ═══════════════════════════════════════════════════════════════════════
//  1. Calendar
// ═══════════════════════════════════════════════════════════════════════

let cpCalScale = 'month';
let cpCalDate = new Date().toISOString();

async function ccRenderCalendar(body) {
    body.innerHTML = '<div class="cc-loading">Loading calendar…</div>';

    let d;
    try {
        d = await adminFetch(`/communications/calendar?scale=${cpCalScale}&date=${encodeURIComponent(cpCalDate)}`);
    } catch (e) {
        body.innerHTML = `<p class="section-note">Could not load the calendar. ${escapeHtml(e.message || '')}</p>`;
        return;
    }

    const from = new Date(d.from);
    const to = new Date(d.to);
    const byDay = new Map();
    for (const e of d.entries) {
        const key = new Date(e.date).toISOString().slice(0, 10);
        if (!byDay.has(key)) byDay.set(key, []);
        byDay.get(key).push(e);
    }

    const heading = cpCalScale === 'month'
        ? from.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })
        : cpCalScale === 'week'
            ? `Week of ${from.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}`
            : from.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });

    const legend = Object.entries(CP_STATUS).map(([k, v]) => `
        <span class="cp-legend-chip"><span class="cp-swatch" style="background:${v.colour}"></span>
        ${escapeHtml(v.label)} <strong>${d.counts[k] || 0}</strong></span>`).join('');

    body.innerHTML = `
        <div class="cp-cal-head">
            <div class="cp-cal-nav">
                <button class="btn-secondary btn-small" onclick="cpCalStep(-1)"><i class="fas fa-chevron-left"></i></button>
                <h2 class="cc-h2" style="margin:0">${escapeHtml(heading)}</h2>
                <button class="btn-secondary btn-small" onclick="cpCalStep(1)"><i class="fas fa-chevron-right"></i></button>
                <button class="btn-secondary btn-small" onclick="cpCalToday()">Today</button>
            </div>
            <div class="cp-scale-tabs">
                ${['day', 'week', 'month'].map((s) => `
                    <button class="cp-scale ${s === cpCalScale ? 'active' : ''}"
                            onclick="cpCalSetScale('${s}')">${s[0].toUpperCase() + s.slice(1)}</button>`).join('')}
            </div>
        </div>

        <div class="cp-cal-legend">${legend}</div>

        ${d.entries.length === 0 ? `
            <div class="cc-empty">
                <h3>Nothing in this ${cpCalScale}</h3>
                <p class="section-note">No campaign was created, scheduled or sent in this period.</p>
            </div>` : ''}

        ${cpCalScale === 'month' ? cpMonthGrid(from, to, byDay) : cpDayList(from, to, byDay)}

        <p class="section-note cp-cal-foot">
            <i class="fas fa-circle-info"></i>
            A campaign sits on the day it was sent, or failing that the day it is scheduled for,
            or failing that the day it was created. Drag a card to reschedule — only campaigns that
            have not started sending can be moved, and only to a future date.
        </p>`;

    cpWireDragAndDrop();
}

function cpCard(e) {
    const s = CP_STATUS[e.status] || { label: e.status, colour: CP_PALETTE.muted };
    return `
    <div class="cp-cal-card ${e.canReschedule ? 'draggable' : 'locked'}"
         ${e.canReschedule ? 'draggable="true"' : ''}
         data-campaign="${escapeHtml(e.id)}"
         title="${escapeHtml(e.canReschedule ? 'Drag to reschedule' : (e.lockReason || ''))}"
         onclick="ccOpen('${escapeHtml(e.id)}')">
        <span class="cp-cal-dot" style="background:${s.colour}"></span>
        <span class="cp-cal-name">${escapeHtml(e.name)}</span>
        <span class="cp-cal-meta">
            ${escapeHtml(s.label)}${e.channels.length ? ' · ' + e.channels.map((c) => escapeHtml(c.replace('_', '-'))).join(', ') : ''}
        </span>
        ${e.canReschedule ? '' : '<i class="fas fa-lock cp-cal-lock"></i>'}
    </div>`;
}

function cpMonthGrid(from, to, byDay) {
    const cells = [];
    // Pad to the Monday before the first, so columns line up.
    const start = new Date(from);
    start.setDate(start.getDate() - ((start.getDay() + 6) % 7));

    const todayKey = new Date().toISOString().slice(0, 10);
    for (let i = 0; i < 42; i++) {
        const day = new Date(start);
        day.setDate(start.getDate() + i);
        const key = day.toISOString().slice(0, 10);
        const outside = day < from || day >= to;
        const entries = byDay.get(key) || [];
        cells.push(`
            <div class="cp-cal-cell ${outside ? 'outside' : ''} ${key === todayKey ? 'today' : ''}"
                 data-date="${key}">
                <span class="cp-cal-daynum">${day.getDate()}</span>
                ${entries.map(cpCard).join('')}
            </div>`);
        if (day >= to && day.getDay() === 0) break;
    }

    return `
        <div class="cp-cal-grid">
            ${['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
                .map((d) => `<div class="cp-cal-dayname">${d}</div>`).join('')}
            ${cells.join('')}
        </div>`;
}

function cpDayList(from, to, byDay) {
    const rows = [];
    const day = new Date(from);
    const todayKey = new Date().toISOString().slice(0, 10);
    while (day < to) {
        const key = day.toISOString().slice(0, 10);
        const entries = byDay.get(key) || [];
        rows.push(`
            <div class="cp-cal-daycol ${key === todayKey ? 'today' : ''}" data-date="${key}">
                <div class="cp-cal-dayhead">
                    ${day.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })}
                </div>
                ${entries.length ? entries.map(cpCard).join('')
                    : '<p class="cp-cal-empty">—</p>'}
            </div>`);
        day.setDate(day.getDate() + 1);
    }
    return `<div class="cp-cal-days cp-cal-days-${rows.length}">${rows.join('')}</div>`;
}

function cpCalSetScale(scale) { cpCalScale = scale; ccRenderCalendar(document.getElementById('cc-body')); }
function cpCalToday() { cpCalDate = new Date().toISOString(); ccRenderCalendar(document.getElementById('cc-body')); }

function cpCalStep(direction) {
    const d = new Date(cpCalDate);
    if (cpCalScale === 'day') d.setDate(d.getDate() + direction);
    else if (cpCalScale === 'week') d.setDate(d.getDate() + 7 * direction);
    else d.setMonth(d.getMonth() + direction);
    cpCalDate = d.toISOString();
    ccRenderCalendar(document.getElementById('cc-body'));
}

/**
 * Drag-and-drop rescheduling.
 *
 * The drop keeps the campaign's existing time of day and changes only the
 * date. Dropping onto a day should not silently move a 9am send to midnight,
 * and midnight is what a naive `new Date(dateKey)` produces.
 */
function cpWireDragAndDrop() {
    let dragging = null;

    document.querySelectorAll('.cp-cal-card.draggable').forEach((card) => {
        card.addEventListener('dragstart', (ev) => {
            dragging = card.dataset.campaign;
            card.classList.add('dragging');
            ev.dataTransfer.effectAllowed = 'move';
        });
        card.addEventListener('dragend', () => {
            card.classList.remove('dragging');
            dragging = null;
        });
    });

    document.querySelectorAll('[data-date]').forEach((cell) => {
        cell.addEventListener('dragover', (ev) => {
            if (!dragging) return;
            ev.preventDefault();
            cell.classList.add('drop-target');
        });
        cell.addEventListener('dragleave', () => cell.classList.remove('drop-target'));
        cell.addEventListener('drop', async (ev) => {
            ev.preventDefault();
            cell.classList.remove('drop-target');
            if (!dragging) return;

            const card = document.querySelector(`.cp-cal-card[data-campaign="${dragging}"]`);
            const existing = card ? card.closest('[data-date]') : null;
            if (existing && existing.dataset.date === cell.dataset.date) return;

            // Keep the time of day; change only the date.
            const now = new Date();
            const target = new Date(`${cell.dataset.date}T${String(now.getHours()).padStart(2, '0')}:00:00`);

            try {
                await adminFetch('/communications/calendar/reschedule', 'POST', {
                    campaignId: dragging,
                    scheduledAt: target.toISOString(),
                });
                showToast('Rescheduled.', 'success');
            } catch (e) {
                showToast(e.message || 'Could not reschedule.', 'error');
            }
            ccRenderCalendar(document.getElementById('cc-body'));
        });
    });
}

// ═══════════════════════════════════════════════════════════════════════
//  2. Analytics
// ═══════════════════════════════════════════════════════════════════════

let cpAnalyticsDays = 30;

async function ccRenderAnalytics(body) {
    body.innerHTML = '<div class="cc-loading">Loading analytics…</div>';

    let d;
    try {
        d = await adminFetch(`/communications/analytics?days=${cpAnalyticsDays}`);
    } catch (e) {
        body.innerHTML = `<p class="section-note">Could not load analytics. ${escapeHtml(e.message || '')}</p>`;
        return;
    }

    const growthDays = d.growth.map((g) => g.day);
    const series = [
        { label: 'Email sent', colour: CP_PALETTE.email, values: d.growth.map((g) => g.emailSent) },
        { label: 'Opened', colour: CP_PALETTE.good, values: d.growth.map((g) => g.emailOpened) },
        { label: 'Clicked', colour: CP_PALETTE.warn, values: d.growth.map((g) => g.emailClicked) },
        { label: 'Push sent', colour: CP_PALETTE.push, values: d.growth.map((g) => g.pushSent) },
        { label: 'New opt-ins', colour: '#22d3ee', values: d.growth.map((g) => g.newConsents) },
    ];

    body.innerHTML = `
        <div class="cp-head">
            <h2 class="cc-h2" style="margin:0">Campaign analytics</h2>
            <div class="cp-scale-tabs">
                ${[7, 30, 90].map((n) => `
                    <button class="cp-scale ${n === cpAnalyticsDays ? 'active' : ''}"
                            onclick="cpSetAnalyticsDays(${n})">${n} days</button>`).join('')}
            </div>
        </div>

        ${d.empty ? `
            <div class="cc-alert cc-alert-info">
                <i class="fas fa-circle-info"></i>
                <div><strong>No campaign has been sent.</strong> ${escapeHtml(d.emptyReason)}</div>
            </div>` : ''}

        <div class="cp-channels">
            ${d.channels.map(cpChannelCard).join('')}
        </div>

        <h3 class="cc-h3">Growth over time</h3>
        ${cpLines(series, growthDays)}

        <h3 class="cc-h3">Top performing campaigns</h3>
        ${d.topCampaigns.length === 0
            ? `<p class="section-note">Nothing to rank yet. Campaigns appear here once they have been sent.</p>`
            : `<div class="table-wrap"><table class="data-table">
                <thead><tr><th>Campaign</th><th>Sent</th><th>Delivered</th>
                    <th>Opened</th><th>Clicked</th><th>Open rate</th><th>CTR</th></tr></thead>
                <tbody>${d.topCampaigns.map((c) => `
                    <tr onclick="ccOpen('${escapeHtml(c.campaignId)}')" style="cursor:pointer">
                        <td><strong>${escapeHtml(c.name)}</strong></td>
                        <td>${cpNum(c.sent)}</td><td>${cpNum(c.delivered)}</td>
                        <td>${cpNum(c.opened)}</td><td>${cpNum(c.clicked)}</td>
                        <td>${cpPct(c.openRate)}</td><td><strong>${cpPct(c.clickThroughRate)}</strong></td>
                    </tr>`).join('')}</tbody></table></div>
               <p class="section-note">Ranked by click-through, not opens. Open tracking is a pixel most
               mail clients block, so ranking by it largely ranks which mail app people use.</p>`}
    `;
}

function cpSetAnalyticsDays(n) { cpAnalyticsDays = n; ccRenderAnalytics(document.getElementById('cc-body')); }

function cpChannelCard(c) {
    const titles = { email: 'Email', push: 'Push', in_app: 'In-app', sms: 'SMS' };
    const colour = CP_PALETTE[c.channel];

    if (!c.instrumented) {
        return `
        <div class="cp-channel cp-channel-dark">
            <div class="cp-channel-head">
                <h4>${escapeHtml(titles[c.channel])}</h4>
                <span class="cc-pill cc-pill-muted">Not measured</span>
            </div>
            <div class="cp-nodata">
                <i class="fas fa-circle-question"></i>
                <p>${escapeHtml(c.note || 'No measurement available.')}</p>
                <p class="cp-nodata-note">Shown as unmeasured rather than as zero — those look
                identical on a chart and mean opposite things.</p>
            </div>
        </div>`;
    }

    const m = c.metrics;
    const bars = {
        email: [
            { label: 'Delivered', value: m.delivered, colour: CP_PALETTE.good },
            { label: 'Opened', value: m.opened, colour: colour },
            { label: 'Clicked', value: m.clicked, colour: CP_PALETTE.warn },
            { label: 'Bounced', value: m.bounced, colour: CP_PALETTE.bad },
            { label: 'Complaints', value: m.complaints, colour: CP_PALETTE.bad },
            { label: 'Unsubscribes', value: m.unsubscribes, colour: CP_PALETTE.muted },
        ],
        push: [
            { label: 'Sent', value: m.sent, colour: colour },
            { label: 'Delivered', value: m.delivered, colour: CP_PALETTE.good },
            { label: 'Opened', value: m.opened, colour: CP_PALETTE.warn },
        ],
        in_app: [
            { label: 'Displayed', value: m.displayed, colour: colour },
            { label: 'Viewed', value: m.viewed, colour: CP_PALETTE.good },
            { label: 'Clicked', value: m.clicked, colour: CP_PALETTE.warn },
            { label: 'Dismissed', value: m.dismissed, colour: CP_PALETTE.muted },
        ],
        sms: [
            { label: 'Sent', value: m.sent, colour: colour },
            { label: 'Delivered', value: m.delivered, colour: CP_PALETTE.good },
            { label: 'Failed', value: m.failed, colour: CP_PALETTE.bad },
        ],
    }[c.channel];

    const rateTiles = Object.entries(c.rates)
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => `
            <div class="cp-rate">
                <span class="cp-rate-v">${cpPct(v)}</span>
                <span class="cp-rate-l">${escapeHtml(k.replace(/([A-Z])/g, ' $1').toLowerCase())}</span>
            </div>`).join('');

    return `
    <div class="cp-channel">
        <div class="cp-channel-head">
            <h4><span class="cp-swatch" style="background:${colour}"></span>
                ${escapeHtml(titles[c.channel])}</h4>
            <span class="cp-channel-total">${cpNum(m.sent ?? m.displayed ?? m.queued)} sent</span>
        </div>
        ${c.note ? `<p class="cp-channel-note"><i class="fas fa-triangle-exclamation"></i>
            ${escapeHtml(c.note)}</p>` : ''}
        ${cpBars(bars)}
        <div class="cp-rates">${rateTiles}</div>
    </div>`;
}

// ═══════════════════════════════════════════════════════════════════════
//  3. Audience insights
// ═══════════════════════════════════════════════════════════════════════

async function cpRenderInsights(container, definition) {
    container.innerHTML = '<div class="cc-loading">Describing this audience…</div>';

    let d;
    try {
        d = await adminFetch('/communications/audience/insights', 'POST', { definition: definition || {} });
    } catch (e) {
        container.innerHTML = `<p class="section-note">${escapeHtml(e.message || 'Could not describe that audience.')}</p>`;
        return;
    }

    if (d.total === 0) {
        container.innerHTML = `<div class="cc-empty"><h3>No passengers match</h3>
            <p class="section-note">Widen the filters — as written, this audience is empty.</p></div>`;
        return;
    }

    const L = d.lifecycle;
    const tip = (k) => escapeHtml(d.definitions[k] || '');

    container.innerHTML = `
    <div class="cp-insights">
        <div class="cp-insight-block">
            <h4 class="cc-h4">Lifecycle</h4>
            ${cpBars([
                { label: 'Active', value: L.active, colour: CP_PALETTE.good },
                { label: 'Inactive', value: L.inactive, colour: CP_PALETTE.warn },
                { label: 'New', value: L.newPassengers, colour: '#22d3ee' },
                { label: 'Returning', value: L.returning, colour: CP_PALETTE.email },
                { label: 'High-frequency', value: L.highFrequency, colour: CP_PALETTE.push },
                { label: 'Dormant', value: L.dormant, colour: CP_PALETTE.muted },
                { label: 'Never completed a ride', value: L.neverCompletedRide, colour: CP_PALETTE.bad },
            ])}
            <details class="cp-defs">
                <summary>What these mean</summary>
                <ul>
                    <li><strong>Active</strong> — ${tip('active')}</li>
                    <li><strong>Inactive</strong> — ${tip('inactive')}</li>
                    <li><strong>New</strong> — ${tip('new')}</li>
                    <li><strong>Returning</strong> — ${tip('returning')}</li>
                    <li><strong>High-frequency</strong> — ${tip('highFrequency')}</li>
                    <li><strong>Dormant</strong> — ${tip('dormant')}</li>
                    <li><strong>Never completed</strong> — ${tip('neverCompletedRide')}</li>
                </ul>
            </details>
        </div>

        <div class="cp-insight-block">
            <h4 class="cc-h4">Devices</h4>
            ${cpDonut([
                { label: 'Android only', value: d.devices.android, colour: '#34d399' },
                { label: 'iPhone only', value: d.devices.ios, colour: '#60a5fa' },
                { label: 'Both', value: d.devices.both || 0, colour: '#a78bfa' },
                { label: 'No device', value: d.devices.noDevice, colour: 'rgba(148,163,184,0.35)' },
            ], 'Android', d.devices.androidSharePct == null ? '—' : `${d.devices.androidSharePct}%`)}
            <p class="section-note">${tip('devices')}</p>
        </div>

        <div class="cp-insight-block">
            <h4 class="cc-h4">Behaviour</h4>
            <div class="cp-rates">
                <div class="cp-rate"><span class="cp-rate-v">${d.behaviour.averageRides}</span>
                    <span class="cp-rate-l">average rides</span></div>
                <div class="cp-rate"><span class="cp-rate-v">${d.behaviour.medianRides}</span>
                    <span class="cp-rate-l">median rides</span></div>
                <div class="cp-rate"><span class="cp-rate-v">₦${cpNum(d.behaviour.averageSpendNaira)}</span>
                    <span class="cp-rate-l">average spend</span></div>
                <div class="cp-rate"><span class="cp-rate-v">₦${cpNum(d.behaviour.totalSpendNaira)}</span>
                    <span class="cp-rate-l">total spend</span></div>
            </div>
            <p class="section-note">${tip('averageSpend')}</p>
        </div>

        <div class="cp-insight-block">
            <h4 class="cc-h4">Cities</h4>
            ${d.cities.length ? cpBars(d.cities.map((c) => ({ label: c.name, value: c.count })))
                : '<p class="section-note">No completed rides through a park yet.</p>'}
            <p class="section-note">${tip('cities')}</p>
        </div>

        <div class="cp-insight-block">
            <h4 class="cc-h4">Parks</h4>
            ${d.parks.length ? cpBars(d.parks.map((p) => ({ label: p.name, value: p.count })),
                { colour: CP_PALETTE.push })
                : '<p class="section-note">No completed rides through a park yet.</p>'}
        </div>
    </div>

    <p class="section-note cp-insight-foot">
        <i class="fas fa-circle-info"></i>
        This describes everyone the filters <strong>matched</strong> — ${cpNum(d.total)} passengers —
        before consent and suppression are applied. How many will actually receive it is on the
        readiness panel, and the gap between the two numbers is usually the thing worth looking at.
    </p>`;
}

// ═══════════════════════════════════════════════════════════════════════
//  4. Previews
// ═══════════════════════════════════════════════════════════════════════

let cpPreviewMode = 'desktop';

async function cpRenderPreviews(container, campaignId) {
    container.innerHTML = '<div class="cc-loading">Rendering previews…</div>';

    let d;
    try {
        d = await adminFetch(`/communications/mc/campaigns/${campaignId}/previews`);
    } catch (e) {
        container.innerHTML = `<p class="section-note">${escapeHtml(e.message || 'Could not render previews.')}</p>`;
        return;
    }

    const previews = d.previews || d.channels || [];
    if (!previews.length) {
        container.innerHTML = '<p class="section-note">No channel is enabled on this campaign.</p>';
        return;
    }

    container.innerHTML = previews.map((p) => cpPreviewFor(p)).join('') + `
        <p class="section-note cp-preview-foot">
            <i class="fas fa-triangle-exclamation"></i>
            These are rendered by KekeRide's own code. They show what was written, not what a mail
            client or a phone will do with it — Gmail rewrites CSS, Android truncates at a different
            width on every skin. Send a test and read it on a real device before approving.
        </p>`;
}

function cpPreviewFor(p) {
    const channel = p.channel || p.kind;
    if (channel === 'email') return cpEmailPreview(p);
    if (channel === 'push') return cpPushPreview(p);
    if (channel === 'in_app') return cpInAppPreview(p);
    if (channel === 'sms') return cpSmsPreview(p);
    return '';
}

function cpEmailPreview(p) {
    const subject = p.subject || p.content?.subject || '(no subject)';
    const preheader = p.previewText || p.content?.previewText || '';
    const html = p.html || p.content?.html || '';

    return `
    <section class="cp-preview">
        <div class="cp-preview-head">
            <h4><i class="fas fa-envelope"></i> Email</h4>
            <div class="cp-scale-tabs">
                ${[['desktop', 'Desktop'], ['mobile', 'Mobile'], ['dark', 'Dark mode']].map(([k, label]) => `
                    <button class="cp-scale ${cpPreviewMode === k ? 'active' : ''}"
                            onclick="cpSetPreviewMode('${k}')">${label}</button>`).join('')}
            </div>
        </div>

        <div class="cp-inbox-line">
            <strong>KekeRide</strong>
            <span class="cp-inbox-subject">${escapeHtml(subject)}</span>
            <span class="cp-inbox-preheader">${escapeHtml(preheader)}</span>
        </div>

        <div class="cp-frame cp-frame-${cpPreviewMode}">
            <iframe title="Email preview" sandbox
                    srcdoc="${escapeHtml(cpPreviewMode === 'dark' ? cpDarkWrap(html) : html)}"></iframe>
        </div>
        ${cpPreviewMode === 'dark' ? `
            <p class="section-note">A simulation of forced dark mode. Gmail and Outlook each invert
            differently, and neither matches this exactly — it shows whether the layout survives
            inversion, not what any one client will produce.</p>` : ''}
    </section>`;
}

/** Wrap a rendered email so it can be judged under an inverting client. */
function cpDarkWrap(html) {
    return `<div style="background:#111418;color:#e6e8eb;padding:8px">
        <style>body,table,td{background:#111418 !important;color:#e6e8eb !important}
        a{color:#8ab4f8 !important}</style>${html}</div>`;
}

function cpSetPreviewMode(mode) {
    cpPreviewMode = mode;
    // Re-render in place. The panel keeps one id throughout — reassigning it
    // per tab would break the lookup the moment somebody switched back.
    const host = document.getElementById('cp-detail-panel');
    if (host && window.ccCampaignId) cpRenderPreviews(host, window.ccCampaignId);
}

function cpPushPreview(p) {
    const title = p.title || p.content?.title || '(no title)';
    const bodyText = p.body || p.content?.body || '';

    return `
    <section class="cp-preview">
        <div class="cp-preview-head"><h4><i class="fas fa-mobile-screen"></i> Push</h4></div>
        <div class="cp-phones">
            <div class="cp-phone cp-phone-android">
                <span class="cp-phone-label">Android</span>
                <div class="cp-push-android">
                    <div class="cp-push-app"><i class="fas fa-taxi"></i> KekeRide · now</div>
                    <div class="cp-push-title">${escapeHtml(title)}</div>
                    <div class="cp-push-body">${escapeHtml(bodyText)}</div>
                </div>
                <p class="cp-phone-note">Delivered on the <code>keke_promotions</code> channel at
                normal priority, so it never rings like a ride alert.</p>
            </div>

            <div class="cp-phone cp-phone-ios">
                <span class="cp-phone-label">iPhone</span>
                <div class="cp-push-ios">
                    <div class="cp-push-ios-head">
                        <i class="fas fa-taxi"></i><span>KEKERIDE</span><span class="cp-push-time">now</span>
                    </div>
                    <div class="cp-push-title">${escapeHtml(title)}</div>
                    <div class="cp-push-body">${escapeHtml(bodyText)}</div>
                </div>
                <p class="cp-phone-note">iOS truncates to roughly two lines when the phone is locked.
                Front-load the point.</p>
            </div>
        </div>
    </section>`;
}

function cpInAppPreview(p) {
    const title = p.title || p.content?.title || '';
    const bodyText = p.body || p.content?.body || '';
    const cta = p.ctaLabel || p.content?.ctaLabel || 'Open';

    return `
    <section class="cp-preview">
        <div class="cp-preview-head"><h4><i class="fas fa-window-maximize"></i> In-app</h4></div>
        <div class="cp-inapp-grid">
            <div class="cp-inapp-surface">
                <span class="cp-phone-label">Banner</span>
                <div class="cp-inapp-banner">
                    <i class="fas fa-tag"></i>
                    <div><strong>${escapeHtml(title)}</strong><span>${escapeHtml(bodyText)}</span></div>
                    <i class="fas fa-xmark cp-inapp-close"></i>
                </div>
            </div>

            <div class="cp-inapp-surface">
                <span class="cp-phone-label">Popup</span>
                <div class="cp-inapp-popup">
                    <strong>${escapeHtml(title)}</strong>
                    <p>${escapeHtml(bodyText)}</p>
                    <div class="cp-inapp-actions">
                        <button class="btn-secondary btn-small" type="button">Not now</button>
                        <button class="btn-primary btn-small" type="button">${escapeHtml(cta)}</button>
                    </div>
                </div>
            </div>

            <div class="cp-inapp-surface">
                <span class="cp-phone-label">Inbox</span>
                <div class="cp-inapp-inbox">
                    <div class="cp-inapp-inbox-row">
                        <span class="cp-inapp-unread"></span>
                        <div><strong>${escapeHtml(title)}</strong><span>${escapeHtml(bodyText)}</span></div>
                        <span class="cp-inapp-when">now</span>
                    </div>
                </div>
            </div>
        </div>
        <p class="section-note">The released passenger app has no in-app inbox. These surfaces are
        the design the app will implement, not something that can be delivered today.</p>
    </section>`;
}

function cpSmsPreview(p) {
    const text = p.text || p.body || p.content?.body || '';
    const a = p.analysis || {};
    const segments = a.segments ?? Math.max(1, Math.ceil(text.length / 160));
    const encoding = a.encoding || (/^[\x00-\x7F£€]*$/.test(text) ? 'GSM-7' : 'UCS-2');
    const perSegment = encoding === 'GSM-7' ? 160 : 70;
    // A stated illustrative rate, not a quote — no provider is commissioned.
    const NGN_PER_SEGMENT = 4;

    return `
    <section class="cp-preview">
        <div class="cp-preview-head"><h4><i class="fas fa-comment-sms"></i> SMS</h4></div>
        <div class="cp-phones">
            <div class="cp-phone">
                <div class="cp-sms-bubble">${escapeHtml(text) || '<em>(empty)</em>'}</div>
            </div>
            <div class="cp-sms-meta">
                <div class="cp-rates">
                    <div class="cp-rate"><span class="cp-rate-v">${text.length}</span>
                        <span class="cp-rate-l">characters</span></div>
                    <div class="cp-rate"><span class="cp-rate-v">${segments}</span>
                        <span class="cp-rate-l">segments</span></div>
                    <div class="cp-rate"><span class="cp-rate-v">${encoding}</span>
                        <span class="cp-rate-l">encoding</span></div>
                    <div class="cp-rate"><span class="cp-rate-v">${perSegment}</span>
                        <span class="cp-rate-l">chars per segment</span></div>
                </div>
                ${encoding === 'UCS-2' ? `
                    <div class="cc-alert cc-alert-warn"><i class="fas fa-triangle-exclamation"></i>
                    <div>A non-GSM character — often a curly quote pasted from a document — drops
                    the limit from 160 to 70 and more than doubles the cost. Replace it with a
                    straight quote.</div></div>` : ''}
                <p class="section-note">
                    Illustrative cost: <strong>₦${(segments * NGN_PER_SEGMENT).toFixed(2)}</strong>
                    per recipient at ₦${NGN_PER_SEGMENT}/segment.
                    No SMS provider is commissioned, so that rate is an assumption for sizing, not a quote.
                </p>
            </div>
        </div>
    </section>`;
}

// ═══════════════════════════════════════════════════════════════════════
//  5. History
// ═══════════════════════════════════════════════════════════════════════

const CP_ACTION_ICON = {
    created: 'fa-plus', edited: 'fa-pen', content_edited: 'fa-pen',
    channel_enabled: 'fa-toggle-on', channel_disabled: 'fa-toggle-off',
    approval_requested: 'fa-paper-plane', approved: 'fa-circle-check',
    rejected: 'fa-circle-xmark', scheduled: 'fa-calendar', rescheduled: 'fa-calendar-day',
    schedule_cancelled: 'fa-calendar-xmark', send_started: 'fa-play',
    paused: 'fa-pause', resumed: 'fa-play', completed: 'fa-flag-checkered',
    cancelled: 'fa-ban', failed: 'fa-triangle-exclamation', test_sent: 'fa-flask',
    duplicated: 'fa-copy',
};

async function cpRenderHistory(container, campaignId) {
    container.innerHTML = '<div class="cc-loading">Loading history…</div>';

    let d;
    try {
        d = await adminFetch(`/communications/mc/campaigns/${campaignId}/history`);
    } catch (e) {
        container.innerHTML = `<p class="section-note">${escapeHtml(e.message || 'Could not load the history.')}</p>`;
        return;
    }

    const who = (x) => (x ? `${escapeHtml(x.name || 'Unknown')}<span class="cp-when">${
        new Date(x.at).toLocaleString()}</span>` : '<span class="muted">—</span>');

    const a = d.attribution;

    container.innerHTML = `
    <div class="cp-attribution">
        <div><span class="cp-attr-label">Created by</span>${who(a.created)}</div>
        <div><span class="cp-attr-label">Last edited by</span>${who(a.lastEdited)}</div>
        <div><span class="cp-attr-label">Approved by</span>${who(a.approved)}</div>
        <div><span class="cp-attr-label">Paused by</span>${who(a.paused)}</div>
        <div><span class="cp-attr-label">Resumed by</span>${who(a.resumed)}</div>
        <div><span class="cp-attr-label">Cancelled by</span>${who(a.cancelled)}</div>
    </div>

    ${d.history.length === 0
        ? '<p class="section-note">Nothing recorded yet.</p>'
        : `<ol class="cp-timeline">${d.history.map((e) => `
            <li class="cp-event">
                <span class="cp-event-icon"><i class="fas ${CP_ACTION_ICON[e.action] || 'fa-circle'}"></i></span>
                <div class="cp-event-body">
                    <div class="cp-event-head">
                        <strong>${escapeHtml(e.action.replace(/_/g, ' '))}</strong>
                        ${e.channel ? `<span class="cc-pill cc-pill-muted">${escapeHtml(e.channel)}</span>` : ''}
                        <span class="cp-when">${new Date(e.at).toLocaleString()}</span>
                    </div>
                    <div class="cp-event-actor">${escapeHtml(e.actor.name || 'Unknown')}${
                        e.actor.role ? ` · ${escapeHtml(e.actor.role)}` : ''}${
                        e.ipAddress ? ` · ${escapeHtml(e.ipAddress)}` : ''}</div>
                    ${e.note ? `<p class="cp-event-note">${escapeHtml(e.note)}</p>` : ''}
                    ${e.changes.length ? `<ul class="cp-changes">${e.changes.map((c) => `
                        <li><code>${escapeHtml(c.field)}</code>
                            <span class="cp-from">${escapeHtml(String(c.from ?? '—'))}</span>
                            <i class="fas fa-arrow-right"></i>
                            <span class="cp-to">${escapeHtml(String(c.to ?? '—'))}</span>
                        </li>`).join('')}</ul>` : ''}
                </div>
            </li>`).join('')}</ol>`}

    <p class="section-note">
        <i class="fas fa-lock"></i>
        This record is append-only. Nothing in the admin dashboard can edit or delete an entry —
        a history somebody could tidy up would be worth nothing on the day it matters.
    </p>`;
}

// ═══════════════════════════════════════════════════════════════════════
//  6 & 7. Template library and audience registry
// ═══════════════════════════════════════════════════════════════════════

async function ccRenderLibrary(body) {
    body.innerHTML = '<div class="cc-loading">Loading…</div>';

    let templates = [];
    let audiences = [];
    try {
        const [t, a] = await Promise.all([
            adminFetch('/communications/templates'),
            adminFetch('/communications/audiences'),
        ]);
        templates = t.templates || t || [];
        audiences = a.audiences || [];
    } catch (e) {
        body.innerHTML = `<p class="section-note">Could not load the library. ${escapeHtml(e.message || '')}</p>`;
        return;
    }

    const CATEGORY_NOTE = {
        promotionalOffers: 'Requires promotional consent. Withdrawable at any time.',
        productUpdates: 'Requires product-update consent.',
        safetyAnnouncements: 'Safety consent — on by default and not withdrawable by an ordinary unsubscribe. '
            + 'Never carry an offer on this.',
    };

    const groups = {};
    for (const t of templates) {
        const g = t.group || 'Other';
        (groups[g] = groups[g] || []).push(t);
    }

    body.innerHTML = `
        <h2 class="cc-h2">Template library</h2>
        <p class="section-note">${templates.length} templates. The consent category is a property of the
        template, not a choice made per campaign — a discount cannot be sent under safety consent.</p>

        ${Object.entries(groups).map(([group, list]) => `
            <h3 class="cc-h3">${escapeHtml(group)}</h3>
            <div class="cp-templates">
                ${list.map((t) => `
                    <div class="cp-template ${t.audience === 'driver' ? 'locked' : ''}">
                        <div class="cp-template-head">
                            <strong>${escapeHtml(t.name)}</strong>
                            ${t.audience === 'driver'
                                ? '<span class="cc-pill cc-pill-bad">Drivers · not sendable</span>' : ''}
                        </div>
                        <p class="cp-template-desc">${escapeHtml(t.description || '')}</p>
                        ${t.whenToUse ? `<p class="cp-template-when"><i class="fas fa-lightbulb"></i>
                            ${escapeHtml(t.whenToUse)}</p>` : ''}
                        <div class="cp-template-foot">
                            <span class="cc-pill cc-pill-muted" title="${escapeHtml(CATEGORY_NOTE[t.category] || '')}">
                                ${escapeHtml(t.category)}</span>
                            <code>${escapeHtml(t.key)}</code>
                        </div>
                    </div>`).join('')}
            </div>`).join('')}

        <h3 class="cc-h3">Audiences</h3>
        <p class="section-note">Only passengers can be addressed today. The others are listed with what
        each still needs, because a gap you can see is a gap somebody can close.</p>
        <div class="cp-audiences">
            ${audiences.map((a) => `
                <div class="cp-audience ${a.enabled ? 'on' : 'off'}">
                    <div class="cp-audience-head">
                        <strong>${escapeHtml(a.label)}</strong>
                        ${a.enabled
                            ? '<span class="cc-pill cc-pill-ok">Available</span>'
                            : '<span class="cc-pill cc-pill-muted">Not yet</span>'}
                    </div>
                    <p class="cp-template-desc">${escapeHtml(a.description)}</p>
                    <div class="cp-audience-channels">
                        ${a.channels.map((c) => `<span class="cc-pill cc-pill-muted">${escapeHtml(c.replace('_', '-'))}</span>`).join('')}
                    </div>
                    ${a.mostlyOperational ? `
                        <p class="cp-template-when"><i class="fas fa-circle-info"></i>
                        Most messaging to this audience is operational, not marketing — it belongs in
                        notifications at priority 2, with no consent gate and no approval.</p>` : ''}
                    ${a.prerequisites.length ? `
                        <details class="cp-defs"><summary>Still needed (${a.prerequisites.length})</summary>
                        <ul>${a.prerequisites.map((p) => `<li>${escapeHtml(p)}</li>`).join('')}</ul>
                        </details>` : ''}
                </div>`).join('')}
        </div>`;
}
