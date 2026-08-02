/**
 * Park lifecycle and configuration.
 *
 * Every mutation takes the acting staff member and writes an audit row. The
 * pattern is the one Phase 1 established: services own policy, AuditService
 * owns the record, and no method returns an entity — `toDto` is the single
 * place output is shaped.
 *
 * The state machine is deliberately narrow. A park starts as DRAFT and cannot
 * become ACTIVE until it is genuinely usable: coordinates, a supervisor, and at
 * least one staging zone. "Someone will remember to finish setting it up" is
 * not a control, and a half-configured park that receives real passengers is a
 * failure nobody can undo.
 */
import { AppDataSource } from '../config/data_source';
import { Park, ParkStatus } from '../models/Park';
import { ParkZone, ParkZoneKind } from '../models/ParkZone';
import { StaffUser } from '../models/StaffUser';
import { StaffRoleAssignment } from '../models/StaffRoleAssignment';
import { ParkRepository, ParkCounts } from '../repositories/park_repository';
import { AuditService, AuditActor } from './audit_service';
import { AppError, ErrorCode } from '../utils/errors';
import { StaffRole } from '../config/staff_permissions';
import { AuthService } from './auth_service';
import { haversineMeters } from './ride_integrity_service';
import { IsNull } from 'typeorm';

/** Audit verbs for the park domain. */
export const ParkAuditAction = {
    PARK_CREATED: 'PARK_CREATED',
    PARK_UPDATED: 'PARK_UPDATED',
    PARK_ACTIVATED: 'PARK_ACTIVATED',
    PARK_DEACTIVATED: 'PARK_DEACTIVATED',
    PARK_SUSPENDED: 'PARK_SUSPENDED',
    PARK_SUPERVISOR_ASSIGNED: 'PARK_SUPERVISOR_ASSIGNED',
    PARK_ZONE_CREATED: 'PARK_ZONE_CREATED',
    PARK_ZONE_UPDATED: 'PARK_ZONE_UPDATED',
    PARK_ZONE_DEACTIVATED: 'PARK_ZONE_DEACTIVATED',
} as const;

export interface ParkDto {
    parkId: string;
    name: string;
    code: string;
    addressLine: string | null;
    city: string | null;
    state: string | null;
    lat: number;
    lng: number;
    operatingRadiusM: number;
    serviceRadiusKm: number;
    capacityDrivers: number;
    maxConcurrentAssignments: number;
    priority: number;
    status: ParkStatus;
    opensAt: string | null;
    closesAt: string | null;
    daysOfWeek: number[];
    timezone: string;
    supervisorStaffId: string | null;
    supervisorName: string | null;
    escalationContactName: string | null;
    escalationContactPhone: string | null;
    suspendedAt: Date | null;
    suspensionReason: string | null;
    createdAt: Date;
    updatedAt: Date;
    counts?: ParkCounts;
    /** True when the park is inside its configured operating window right now. */
    withinOperatingHours?: boolean;
}

const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

export class ParkService {
    static toDto(park: Park, extras: { counts?: ParkCounts; supervisorName?: string | null } = {}): ParkDto {
        return {
            parkId: park.parkId,
            name: park.name,
            code: park.code,
            addressLine: park.addressLine,
            city: park.city,
            state: park.state,
            lat: Number(park.lat),
            lng: Number(park.lng),
            operatingRadiusM: park.operatingRadiusM,
            serviceRadiusKm: Number(park.serviceRadiusKm),
            capacityDrivers: park.capacityDrivers,
            maxConcurrentAssignments: park.maxConcurrentAssignments,
            priority: park.priority,
            status: park.status,
            opensAt: park.opensAt,
            closesAt: park.closesAt,
            daysOfWeek: park.daysOfWeek ?? [1, 2, 3, 4, 5, 6, 7],
            timezone: park.timezone,
            supervisorStaffId: park.supervisorStaffId,
            supervisorName: extras.supervisorName ?? null,
            escalationContactName: park.escalationContactName,
            escalationContactPhone: park.escalationContactPhone,
            suspendedAt: park.suspendedAt,
            suspensionReason: park.suspensionReason,
            createdAt: park.createdAt,
            updatedAt: park.updatedAt,
            counts: extras.counts,
            withinOperatingHours: this.isWithinOperatingHours(park),
        };
    }

    /**
     * Whether the park is inside its operating window right now.
     *
     * Evaluated in the park's own timezone via Intl, not by adding a UTC
     * offset: a park opens at 6am local, and Nigeria having no DST today is
     * not a reason to hard-code that assumption into a comparison.
     *
     * A window whose close is before its open (22:00 → 04:00) is treated as
     * crossing midnight, which is what a night shift actually is.
     */
    static isWithinOperatingHours(park: Park, now: Date = new Date()): boolean {
        if (!park.opensAt || !park.closesAt) return true;
        let localHour: number;
        let localMinute: number;
        let isoDay: number;
        try {
            const parts = new Intl.DateTimeFormat('en-GB', {
                timeZone: park.timezone || 'Africa/Lagos',
                hour: '2-digit', minute: '2-digit', weekday: 'short', hour12: false,
            }).formatToParts(now);
            localHour = Number(parts.find((p) => p.type === 'hour')?.value ?? '0');
            localMinute = Number(parts.find((p) => p.type === 'minute')?.value ?? '0');
            const weekday = parts.find((p) => p.type === 'weekday')?.value ?? 'Mon';
            isoDay = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(weekday) + 1;
        } catch {
            // An unknown timezone must not make the park permanently closed.
            return true;
        }

        const days = park.daysOfWeek ?? [1, 2, 3, 4, 5, 6, 7];
        if (isoDay >= 1 && !days.includes(isoDay)) return false;

        const minutes = localHour * 60 + localMinute;
        const [oh, om] = park.opensAt.split(':').map(Number);
        const [ch, cm] = park.closesAt.split(':').map(Number);
        const open = oh * 60 + om;
        const close = ch * 60 + cm;

        return close >= open
            ? minutes >= open && minutes < close
            : minutes >= open || minutes < close;   // crosses midnight
    }

    private static async supervisorName(staffId: string | null): Promise<string | null> {
        if (!staffId) return null;
        const staff = await AppDataSource.getRepository(StaffUser).findOneBy({ id: staffId });
        return staff ? `${staff.firstName} ${staff.lastName}` : null;
    }

    // ── reads ───────────────────────────────────────────────────────────

    static async get(parkId: string, withCounts = true): Promise<ParkDto | null> {
        const park = await ParkRepository.findById(parkId);
        if (!park) return null;
        return this.toDto(park, {
            counts: withCounts ? await ParkRepository.counts(park) : undefined,
            supervisorName: await this.supervisorName(park.supervisorStaffId),
        });
    }

    static async list(query: Parameters<typeof ParkRepository.list>[0]) {
        const result = await ParkRepository.list(query);
        const counts = await ParkRepository.countsForMany(result.items);
        const supervisorIds = [...new Set(result.items.map((p) => p.supervisorStaffId).filter(Boolean))] as string[];
        const supervisors = supervisorIds.length
            ? await AppDataSource.getRepository(StaffUser).createQueryBuilder('s')
                .where('s.id IN (:...ids)', { ids: supervisorIds }).getMany()
            : [];
        const nameBy = new Map(supervisors.map((s) => [s.id, `${s.firstName} ${s.lastName}`]));

        return {
            ...result,
            items: result.items.map((p) => this.toDto(p, {
                counts: counts.get(p.parkId),
                supervisorName: p.supervisorStaffId ? nameBy.get(p.supervisorStaffId) ?? null : null,
            })),
        };
    }

    // ── mutations ───────────────────────────────────────────────────────

    static async create(
        actor: AuditActor,
        input: Record<string, any>,
        ctx: { ipAddress?: string | null; userAgent?: string | null; correlationId?: string | null } = {},
    ): Promise<ParkDto> {
        const name = String(input.name ?? '').trim();
        const code = String(input.code ?? '').trim().toUpperCase();
        if (!name) throw new AppError(400, ErrorCode.MISSING_FIELDS, 'A park name is required.');
        if (!/^[A-Z0-9][A-Z0-9-]{1,23}$/.test(code)) {
            throw new AppError(400, ErrorCode.VALIDATION_ERROR, 'Code must be 2–24 characters: upper-case letters, digits and hyphens.');
        }
        if (await ParkRepository.findByCode(code)) {
            throw new AppError(409, ErrorCode.VALIDATION_ERROR, `A park with code ${code} already exists.`);
        }

        const { lat, lng } = this.requireCoordinates(input);
        const park = ParkRepository.create({
            name,
            code,
            addressLine: input.addressLine?.trim() || null,
            city: input.city?.trim() || null,
            state: input.state?.trim() || null,
            lat, lng,
            operatingRadiusM: this.positiveInt(input.operatingRadiusM, 200, 'operatingRadiusM'),
            serviceRadiusKm: this.positiveNumber(input.serviceRadiusKm, 4, 'serviceRadiusKm'),
            capacityDrivers: this.positiveInt(input.capacityDrivers, 50, 'capacityDrivers'),
            maxConcurrentAssignments: this.positiveInt(input.maxConcurrentAssignments, 3, 'maxConcurrentAssignments'),
            priority: Number.isFinite(Number(input.priority)) ? Math.floor(Number(input.priority)) : 0,
            // Always DRAFT. A park is never born live, whatever the caller sends.
            status: ParkStatus.DRAFT,
            opensAt: this.optionalTime(input.opensAt, 'opensAt'),
            closesAt: this.optionalTime(input.closesAt, 'closesAt'),
            daysOfWeek: this.parseDays(input.daysOfWeek),
            timezone: input.timezone?.trim() || 'Africa/Lagos',
            escalationContactName: input.escalationContactName?.trim() || null,
            escalationContactPhone: input.escalationContactPhone
                ? AuthService.normalizePhone(String(input.escalationContactPhone))
                : null,
            createdByStaffId: actor.staffUserId,
        });

        const saved = await ParkRepository.save(park);
        await AuditService.recordCritical({
            actor,
            action: ParkAuditAction.PARK_CREATED,
            resourceType: 'PARK',
            resourceId: saved.parkId,
            parkId: saved.parkId,
            metadata: { code: saved.code, name: saved.name, status: saved.status },
            ...ctx,
        });
        return this.toDto(saved);
    }

    static async update(
        actor: AuditActor,
        parkId: string,
        input: Record<string, any>,
        ctx: { ipAddress?: string | null; userAgent?: string | null; correlationId?: string | null } = {},
    ): Promise<ParkDto> {
        const park = await this.requirePark(parkId);
        const changed: string[] = [];

        const setIf = (key: keyof Park, value: unknown) => {
            if (value === undefined) return;
            (park as any)[key] = value;
            changed.push(String(key));
        };

        if (input.name !== undefined) setIf('name', String(input.name).trim());
        if (input.addressLine !== undefined) setIf('addressLine', input.addressLine?.trim() || null);
        if (input.city !== undefined) setIf('city', input.city?.trim() || null);
        if (input.state !== undefined) setIf('state', input.state?.trim() || null);
        if (input.lat !== undefined || input.lng !== undefined) {
            const { lat, lng } = this.requireCoordinates({
                lat: input.lat ?? park.lat,
                lng: input.lng ?? park.lng,
            });
            setIf('lat', lat);
            setIf('lng', lng);
        }
        if (input.operatingRadiusM !== undefined) setIf('operatingRadiusM', this.positiveInt(input.operatingRadiusM, 200, 'operatingRadiusM'));
        if (input.serviceRadiusKm !== undefined) setIf('serviceRadiusKm', this.positiveNumber(input.serviceRadiusKm, 4, 'serviceRadiusKm'));
        if (input.capacityDrivers !== undefined) setIf('capacityDrivers', this.positiveInt(input.capacityDrivers, 50, 'capacityDrivers'));
        if (input.maxConcurrentAssignments !== undefined) setIf('maxConcurrentAssignments', this.positiveInt(input.maxConcurrentAssignments, 3, 'maxConcurrentAssignments'));
        if (input.priority !== undefined) setIf('priority', Math.floor(Number(input.priority) || 0));
        if (input.opensAt !== undefined) setIf('opensAt', this.optionalTime(input.opensAt, 'opensAt'));
        if (input.closesAt !== undefined) setIf('closesAt', this.optionalTime(input.closesAt, 'closesAt'));
        if (input.daysOfWeek !== undefined) setIf('daysOfWeek', this.parseDays(input.daysOfWeek));
        if (input.timezone !== undefined) setIf('timezone', String(input.timezone).trim() || 'Africa/Lagos');
        if (input.escalationContactName !== undefined) setIf('escalationContactName', input.escalationContactName?.trim() || null);
        if (input.escalationContactPhone !== undefined) {
            setIf('escalationContactPhone', input.escalationContactPhone
                ? AuthService.normalizePhone(String(input.escalationContactPhone)) : null);
        }

        const saved = await ParkRepository.save(park);
        await AuditService.record({
            actor,
            action: ParkAuditAction.PARK_UPDATED,
            resourceType: 'PARK',
            resourceId: parkId,
            parkId,
            metadata: { fieldsChanged: changed },
            ...ctx,
        });
        return this.toDto(saved, { supervisorName: await this.supervisorName(saved.supervisorStaffId) });
    }

    /**
     * Nominate the accountable supervisor.
     *
     * The nominee must actually hold PARK_SUPERVISOR scoped to this park. A
     * supervisor field pointing at somebody with no authority here is worse
     * than an empty one: it names a person for escalation who cannot act.
     */
    static async assignSupervisor(
        actor: AuditActor,
        parkId: string,
        staffUserId: string | null,
        ctx: { ipAddress?: string | null; userAgent?: string | null; correlationId?: string | null } = {},
    ): Promise<ParkDto> {
        const park = await this.requirePark(parkId);

        if (staffUserId) {
            const staff = await AppDataSource.getRepository(StaffUser).findOneBy({ id: staffUserId });
            if (!staff) throw new AppError(404, ErrorCode.NOT_FOUND, 'Staff member not found.');

            const grants = await AppDataSource.getRepository(StaffRoleAssignment).find({
                where: { staffUserId, role: StaffRole.PARK_SUPERVISOR, revokedAt: IsNull() },
            });
            const scoped = grants.some((g) => g.parkId === parkId || g.parkId == null);
            if (!scoped) {
                throw new AppError(400, ErrorCode.VALIDATION_ERROR,
                    'That staff member does not hold PARK_SUPERVISOR for this park. Grant the role first.');
            }
        }

        // Read before the overwrite: without it the trail records who took
        // over and loses every trace of who was displaced.
        const previousSupervisor = park.supervisorStaffId;

        park.supervisorStaffId = staffUserId;
        const saved = await ParkRepository.save(park);

        await AuditService.recordCritical({
            actor,
            action: ParkAuditAction.PARK_SUPERVISOR_ASSIGNED,
            resourceType: 'PARK',
            resourceId: parkId,
            parkId,
            metadata: { supervisorStaffId: staffUserId },
            previousValue: previousSupervisor,
            newValue: staffUserId,
            ...ctx,
        });
        return this.toDto(saved, { supervisorName: await this.supervisorName(staffUserId) });
    }

    /**
     * Bring a park live.
     *
     * Refuses unless the park is genuinely usable. Each precondition maps to a
     * real operational failure: no supervisor means nobody to escalate to; no
     * staging zone means dispatchers have nowhere to send drivers; a zero
     * service radius means the park can never match a pickup.
     */
    static async activate(
        actor: AuditActor,
        parkId: string,
        ctx: { ipAddress?: string | null; userAgent?: string | null; correlationId?: string | null } = {},
    ): Promise<ParkDto> {
        const park = await this.requirePark(parkId);
        const problems = await this.activationBlockers(park);
        if (problems.length > 0) {
            throw new AppError(400, ErrorCode.VALIDATION_ERROR,
                `This park is not ready to activate: ${problems.join('; ')}.`);
        }

        park.status = ParkStatus.ACTIVE;
        park.suspendedAt = null;
        park.suspendedByStaffId = null;
        park.suspensionReason = null;
        const saved = await ParkRepository.save(park);

        await AuditService.recordCritical({
            actor,
            action: ParkAuditAction.PARK_ACTIVATED,
            resourceType: 'PARK',
            resourceId: parkId,
            parkId,
            ...ctx,
        });
        return this.toDto(saved, { counts: await ParkRepository.counts(saved) });
    }

    /** Everything standing between this park and ACTIVE. Empty means ready. */
    static async activationBlockers(park: Park): Promise<string[]> {
        const problems: string[] = [];
        if (!park.supervisorStaffId) problems.push('no supervisor assigned');
        if (!Number.isFinite(Number(park.lat)) || !Number.isFinite(Number(park.lng))) problems.push('coordinates missing');
        if (Number(park.serviceRadiusKm) <= 0) problems.push('service radius must be greater than zero');

        const staging = await ParkRepository.listZones(park.parkId, { kind: ParkZoneKind.STAGING });
        if (staging.length === 0) problems.push('no staging zone defined');
        return problems;
    }

    static async deactivate(
        actor: AuditActor,
        parkId: string,
        reason: string,
        ctx: { ipAddress?: string | null; userAgent?: string | null; correlationId?: string | null } = {},
    ): Promise<ParkDto> {
        const park = await this.requirePark(parkId);
        park.status = ParkStatus.INACTIVE;
        const saved = await ParkRepository.save(park);
        await AuditService.record({
            actor,
            action: ParkAuditAction.PARK_DEACTIVATED,
            resourceType: 'PARK',
            resourceId: parkId,
            parkId,
            reason: reason?.trim() || null,
            ...ctx,
        });
        return this.toDto(saved);
    }

    static async suspend(
        actor: AuditActor,
        parkId: string,
        reason: string,
        ctx: { ipAddress?: string | null; userAgent?: string | null; correlationId?: string | null } = {},
    ): Promise<ParkDto> {
        if (!reason?.trim()) {
            throw new AppError(400, ErrorCode.VALIDATION_ERROR, 'A reason is required to suspend a park.');
        }
        const park = await this.requirePark(parkId);
        park.status = ParkStatus.SUSPENDED;
        park.suspendedAt = new Date();
        park.suspendedByStaffId = actor.staffUserId;
        park.suspensionReason = reason.trim().slice(0, 500);
        const saved = await ParkRepository.save(park);

        await AuditService.recordCritical({
            actor,
            action: ParkAuditAction.PARK_SUSPENDED,
            resourceType: 'PARK',
            resourceId: parkId,
            parkId,
            reason: reason.trim(),
            ...ctx,
        });
        return this.toDto(saved);
    }

    // ── zones ───────────────────────────────────────────────────────────

    static async listZones(parkId: string, includeInactive = false): Promise<ParkZone[]> {
        await this.requirePark(parkId);
        return ParkRepository.listZones(parkId, { includeInactive });
    }

    static async createZone(
        actor: AuditActor,
        parkId: string,
        input: Record<string, any>,
        ctx: { ipAddress?: string | null; userAgent?: string | null; correlationId?: string | null } = {},
    ): Promise<ParkZone> {
        const park = await this.requirePark(parkId);
        const name = String(input.name ?? '').trim();
        const code = String(input.code ?? '').trim().toUpperCase();
        if (!name) throw new AppError(400, ErrorCode.MISSING_FIELDS, 'A zone name is required.');
        if (!/^[A-Z0-9][A-Z0-9-]{1,23}$/.test(code)) {
            throw new AppError(400, ErrorCode.VALIDATION_ERROR, 'Zone code must be 2–24 characters: upper-case letters, digits and hyphens.');
        }
        if (await ParkRepository.findZoneByCode(parkId, code)) {
            throw new AppError(409, ErrorCode.VALIDATION_ERROR, `Zone code ${code} already exists at this park.`);
        }

        const kind = this.parseZoneKind(input.kind);
        const { lat, lng } = this.requireCoordinates(input);

        // A staging or boarding zone belongs INSIDE the park. One placed
        // kilometres away is a data-entry error, and catching it here is far
        // cheaper than a dispatcher sending drivers to the wrong street.
        if (kind !== ParkZoneKind.SERVICE) {
            const distance = haversineMeters(
                { lat, lng },
                { lat: Number(park.lat), lng: Number(park.lng) },
            );
            const limit = Math.max(park.operatingRadiusM * 5, 1000);
            if (distance > limit) {
                throw new AppError(400, ErrorCode.VALIDATION_ERROR,
                    `A ${kind} zone must be at the park — this point is ${Math.round(distance)}m away.`);
            }
        }

        const zone = ParkRepository.createZone({
            parkId,
            name,
            code,
            kind,
            lat, lng,
            radiusM: this.positiveInt(input.radiusM, 150, 'radiusM'),
            priority: Math.floor(Number(input.priority) || 0),
            capacityDrivers: input.capacityDrivers != null ? this.positiveInt(input.capacityDrivers, 10, 'capacityDrivers') : null,
            active: input.active !== false,
            notes: input.notes?.trim() || null,
            createdByStaffId: actor.staffUserId,
        });

        const saved = await ParkRepository.saveZone(zone);
        await AuditService.record({
            actor,
            action: ParkAuditAction.PARK_ZONE_CREATED,
            resourceType: 'PARK_ZONE',
            resourceId: saved.zoneId,
            parkId,
            metadata: { code: saved.code, kind: saved.kind },
            ...ctx,
        });
        return saved;
    }

    static async updateZone(
        actor: AuditActor,
        zoneId: string,
        input: Record<string, any>,
        ctx: { ipAddress?: string | null; userAgent?: string | null; correlationId?: string | null } = {},
    ): Promise<ParkZone> {
        const zone = await ParkRepository.findZone(zoneId);
        if (!zone) throw new AppError(404, ErrorCode.NOT_FOUND, 'Zone not found.');

        const changed: string[] = [];
        if (input.name !== undefined) { zone.name = String(input.name).trim(); changed.push('name'); }
        if (input.radiusM !== undefined) { zone.radiusM = this.positiveInt(input.radiusM, 150, 'radiusM'); changed.push('radiusM'); }
        if (input.priority !== undefined) { zone.priority = Math.floor(Number(input.priority) || 0); changed.push('priority'); }
        if (input.capacityDrivers !== undefined) {
            zone.capacityDrivers = input.capacityDrivers == null ? null : this.positiveInt(input.capacityDrivers, 10, 'capacityDrivers');
            changed.push('capacityDrivers');
        }
        if (input.active !== undefined) { zone.active = input.active === true; changed.push('active'); }
        if (input.notes !== undefined) { zone.notes = input.notes?.trim() || null; changed.push('notes'); }
        if (input.lat !== undefined && input.lng !== undefined) {
            const { lat, lng } = this.requireCoordinates(input);
            zone.lat = lat; zone.lng = lng; changed.push('lat', 'lng');
        }

        const saved = await ParkRepository.saveZone(zone);
        await AuditService.record({
            actor,
            action: input.active === false ? ParkAuditAction.PARK_ZONE_DEACTIVATED : ParkAuditAction.PARK_ZONE_UPDATED,
            resourceType: 'PARK_ZONE',
            resourceId: zoneId,
            parkId: zone.parkId,
            metadata: { fieldsChanged: changed },
            ...ctx,
        });
        return saved;
    }

    // ── helpers ─────────────────────────────────────────────────────────

    static async requirePark(parkId: string): Promise<Park> {
        const park = await ParkRepository.findById(parkId);
        if (!park) throw new AppError(404, ErrorCode.NOT_FOUND, 'Park not found.');
        return park;
    }

    /**
     * Coordinates, validated against the Nigeria bounding box the socket layer
     * already enforces (socket_handler.ts). A park at 0,0 is the classic
     * silent data-entry failure, and it would place every distance calculation
     * in the Gulf of Guinea.
     */
    private static requireCoordinates(input: Record<string, any>): { lat: number; lng: number } {
        const lat = Number(input.lat);
        const lng = Number(input.lng);
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
            throw new AppError(400, ErrorCode.VALIDATION_ERROR, 'Valid latitude and longitude are required.');
        }
        if (lat < 4 || lat > 14 || lng < 2 || lng > 15) {
            throw new AppError(400, ErrorCode.VALIDATION_ERROR,
                'Coordinates are outside the service area. Check latitude and longitude are not swapped.');
        }
        return { lat, lng };
    }

    private static positiveInt(value: unknown, fallback: number, field: string): number {
        if (value === undefined || value === null || value === '') return fallback;
        const n = Math.floor(Number(value));
        if (!Number.isFinite(n) || n <= 0) {
            throw new AppError(400, ErrorCode.VALIDATION_ERROR, `${field} must be a positive number.`);
        }
        return n;
    }

    private static positiveNumber(value: unknown, fallback: number, field: string): number {
        if (value === undefined || value === null || value === '') return fallback;
        const n = Number(value);
        if (!Number.isFinite(n) || n <= 0) {
            throw new AppError(400, ErrorCode.VALIDATION_ERROR, `${field} must be a positive number.`);
        }
        return n;
    }

    private static optionalTime(value: unknown, field: string): string | null {
        if (value === undefined || value === null || value === '') return null;
        const s = String(value).trim();
        if (!TIME_PATTERN.test(s)) {
            throw new AppError(400, ErrorCode.VALIDATION_ERROR, `${field} must be in HH:MM 24-hour format.`);
        }
        return s;
    }

    private static parseDays(value: unknown): number[] {
        if (value === undefined || value === null) return [1, 2, 3, 4, 5, 6, 7];
        const raw = Array.isArray(value) ? value : String(value).split(',');
        const days = [...new Set(raw.map((d) => Math.floor(Number(d))))].filter((d) => d >= 1 && d <= 7).sort();
        if (days.length === 0) {
            throw new AppError(400, ErrorCode.VALIDATION_ERROR, 'daysOfWeek must contain at least one day (1=Monday … 7=Sunday).');
        }
        return days;
    }

    private static parseZoneKind(value: unknown): ParkZoneKind {
        const kind = String(value ?? ParkZoneKind.SERVICE);
        if (!Object.values(ParkZoneKind).includes(kind as ParkZoneKind)) {
            throw new AppError(400, ErrorCode.VALIDATION_ERROR, `Unknown zone kind: ${kind}`);
        }
        return kind as ParkZoneKind;
    }
}
