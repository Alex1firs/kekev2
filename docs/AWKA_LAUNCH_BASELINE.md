# Awka launch baseline

The certified known-good state, recorded 2 September 2026. This is the reference
a launch-day rollback returns to, and the record against which "did something
change?" is answered.

Recording this changed no production behaviour. Everything below was read.

---

## Software

| | |
|---|---|
| **Deployed backend commit** | `26337b4` |
| **Serving colour at record time** | `blue` (started 2026-09-02 12:22:23 UTC) — blue-green alternates each deploy, so always resolve it, never assume |
| **Previous good** | `6448a64` (image tagged `keke_backend-api_prod:previous`) |
| **Doc-only commits after this** | do not change the deployed artifact |
| **Backend rollback** | `infra/rollback.sh` — re-points nginx at the other colour |
| **Migrations** | none pending; latest is `1810000000000-ServiceZones` |
| **Schema changes in this phase** | none since the ServiceZones migration |

### App versions

| App | Version | Status |
|---|---|---|
| Passenger (installed) | `1.5.0+32` | live on Play — **this is what launch runs on** |
| Passenger (prepared) | `1.5.1+35` | source only — version bumped and tested, **no binary built yet**; carries the out-of-coverage fix |
| Driver | `1.5.0+50` | live on Play — **no change required** |
| Operations console | `sw.js v5.15.0`, assets `?v=1.6` | deployed, serving the zone chips |

---

## Database and zone configuration

`keke_prod_db` on `206.189.96.147`.

```
code | name     | state   | status | enforcement | buffer | priority
-----+----------+---------+--------+-------------+--------+---------
AWK  | Awka     | Anambra | draft  | off         |  400 m |     100
ONI  | Onitsha  | Anambra | active | observe     |  400 m |     100

enforcing zones     0
global posture      observe
fail closed         false   (needs ≥2 enforcing zones)
kill switch         SERVICE_ZONES_ENABLED unset → enabled (normal)
zone cache TTL      60 000 ms
```

| | |
|---|---|
| **ONI mode** | `active` / `observe` — dispatching normally, measuring, refusing nothing |
| **AWK mode** | `draft` / `off` — invisible to dispatch |
| **Global posture** | `observe` — the strongest enforcement among active zones |
| **Enforcement** | **not enabled anywhere** |

### Data at baseline

```
rides total           998        ONI/exact 940 · AWK/exact 20 · null/none 38
rides last 24h          6
rides last 7d          67
service_area_miss      13 rows, 0 refused, 355–667 km from nearest
                       (11 recorded under off, 2 under observe)
driver_profile         175 homeZoneCode = ONI · 5 null
ledger entries 7d       3, ₦3,291.36
```

### Storage of record

Zones live **only in Postgres**. Redis holds no zone keys — confirmed by
`--scan --pattern "*zone*"` returning nothing. The only cache is in-process,
60 s, busted explicitly by `ServiceZoneService.setMode`.

---

## Geometry

Live Postgres geometry was compared to the approved fixture
`test/fixtures/service_zone_golden.json` and **matches exactly** for both zones —
GeoJSON `Polygon`, `[lng, lat]` ordering, ring closed.

| | ONI | AWK |
|---|---|---|
| Vertices | 12 | 9 |
| Area | 211.2 km² | **92.8 km²** |
| North–south | 21.1 km | **10.2 km** |
| East–west | 14.1 km | **13.2 km** |
| Bounding box (lat) | 6.056 – 6.247 | **6.176 – 6.268** |
| Bounding box (lng) | 6.754 – 6.881 | **7.026 – 7.145** |
| Self-intersections | 0 | 0 |
| Buffer | 400 m | 400 m |

**No overlap is possible.** The bounding boxes are disjoint in longitude with a
**16.05 km** gap. All 21 vertices of both polygons cross-classify to their own
zone with zero errors.

### What Awka covers, in plain terms

Roughly **93 km² centred on Awka town**, about 10 km north–south by 13 km
east–west. Confirmed inside, all `exact`:

Aroma Junction · UNIZIK Main Gate · Eke Awka Market · Government House ·
Awka Motor Park · Ifite / UNIZIK north · Okpuno · Amawbia · Agu Awka ·
Nibo edge

Deliberately **outside**, with the nearest-zone distance the resolver reports:

| Place | Result |
|---|---|
| Nnewi | outside, 11.3 km from ONI |
| Asaba | outside, 3.2 km from ONI (across the river, another state) |
| Atani | outside, 10.4 km from ONI |
| Ogidi | **inside ONI** — correct, it is on the Onitsha axis |

This is the focused urban launch zone that was approved, not the Anambra Capital
Territory. Expansion is a polygon edit, by migration, not a code change.

---

## Test totals

| Suite | Tests |
|---|---|
| Backend unit + concurrency | 1 199 (48 suites) |
| Backend integration | 453 (18 suites) |
| **Backend total** | **1 652 across 66 suites** |
| Passenger (Flutter) | 297 |

All green at this commit.

---

## Health baseline

Measured immediately after the deployment of this commit.

| | |
|---|---|
| `/health` | `status ok`, `db up`, `redis up`, colour `blue` |
| Latency | 0.45 – 0.50 s (5 samples) |
| Errors in log since cutover | 0 |
| Firebase push | initialised, **enabled** |
| Redis | `PONG`, 82 GEO entries |
| Postgres | up, connections normal |
| Containers | `api_prod_blue` healthy; nginx, redis, postgres up |
| Zone CLI verified live | `zone:status`, `zone:probe`, and both dry runs, against the running container |
| Availability across the deploy | **1 229 requests, 2 connection resets** — both at 12:25:26 and 12:25:50 UTC as the drained colour stopped, each recovering immediately |

The GEO index has no TTL, so entry count is not a supply measure. Live supply is
`driver:available:*`, which at baseline sampled 0–1 — normal for the current
Onitsha shift pattern.

---

## Passenger release — a separate decision from the Awka launch

Do not conflate these. **The Awka launch does not need this release.**

| | |
|---|---|
| Current, installed | `1.5.0+32` — live on Play |
| Corrected, prepared | `1.5.1+35` — **version bumped and source tested; NOT yet built.** No `.aab` exists. |
| What changed | `OUTSIDE_SERVICE_AREA` maps to its own outcome instead of falling through to a generic server failure |
| Store submission status | **not built, not submitted.** `flutter build appbundle` still has to be run before anything can be uploaded. |
| Needed for Awka launch | **No.** Launch runs at `enforcement = off`, where the server never emits that code, so an old binary never meets it. |
| Needed before enforcement | **Yes.** |

### Why the launch is safe on the old binary

`OUTSIDE_SERVICE_AREA` is emitted only when a zone is **enforcing**. With zero
enforcing zones the branch is unreachable in production, so `1.5.0+32` behaves
identically before and after Awka opens. The app is geography-agnostic in every
other respect: nationwide place search, server-side dispatch, and a no-fix map
fallback that already points at Awka Main Park.

### Adoption threshold before enforcement

**Hold enforcement until the corrected build carries ≥95% of active passenger
sessions.**

Measured in **Play Console → Android vitals → Users by app version** (or
Statistics → filter by app version). It is the only place this is observable;
the backend does not record client versions.

### What happens to old clients after enforcement

An out-of-coverage passenger still on `1.5.0+32` sees:

> *Something went wrong on our end — We couldn't process your request. Please
> try again in a moment.*

A false statement plus a futile instruction. It reads like an outage, generates
support calls, and lands on exactly the people we most want to convert when we
reach their city. Passengers **inside** a covered city are unaffected regardless
of version.

### What waiting costs

Very little. Automatic dispatch has never produced a candidate for an
out-of-area ride across 987 rides, so enforcement's only real addition is
refusing a cross-city **manual** assignment — and the Operations console now
makes that mismatch unmistakable to the operator who would have to make it
deliberately.

**Recommendation:** build and submit `1.5.1+35` now so the adoption clock starts, launch
Awka without waiting for it, and revisit enforcement as a separate decision once
adoption is there. Check Play Console for the highest existing version code
before uploading — this repo's codes have drifted behind Play before.

---

## Activation state

| | |
|---|---|
| **AWK activated** | **NO** |
| **Enforcement enabled** | **NO** |
| Canonical activation | `npm run zone:activate:prod -- --code=AWK --apply` |
| Canonical rollback | `npm run zone:rollback:prod -- --code=AWK --apply` |
| Both documented in | [`AWKA_FIELD_LAUNCH_RUNBOOK.md`](AWKA_FIELD_LAUNCH_RUNBOOK.md) |

Returning to this baseline after a launch is the rollback command alone. No
deploy, no migration, no data change.
