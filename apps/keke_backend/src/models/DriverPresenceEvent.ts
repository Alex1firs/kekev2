import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, Index } from "typeorm";
import { DriverPresenceState, PresenceSource } from "./DriverPresence";

/**
 * Append-only log of every presence transition.
 *
 * DriverPresence holds "now" and is overwritten; this holds "how we got here"
 * and never is. Both are needed, and for different questions: a dispatcher
 * screen wants the current state in one indexed read, while a payroll dispute,
 * a fraud review or a queue-fairness argument needs the sequence.
 *
 * Written by DriverPresenceService on genuine transitions only. A repeated
 * report of the same state produces no row — otherwise a driver app pinging
 * every twelve seconds would bury the transitions that matter.
 */
@Entity()
@Index(["driverId", "occurredAt"])
@Index(["parkId", "occurredAt"])
export class DriverPresenceEvent {
    @PrimaryGeneratedColumn("uuid")
    id!: string;

    @Index()
    @Column()
    driverId!: string;

    @Column({ type: "enum", enum: DriverPresenceState, nullable: true })
    fromState!: DriverPresenceState | null;

    @Index()
    @Column({ type: "enum", enum: DriverPresenceState })
    toState!: DriverPresenceState;

    @Index()
    @Column({ type: "varchar", nullable: true })
    parkId!: string | null;

    @Column({ type: "enum", enum: PresenceSource })
    source!: PresenceSource;

    @Column({ type: "varchar", nullable: true })
    setByStaffId!: string | null;

    @Column({ type: "varchar", nullable: true })
    rideId!: string | null;

    @Column({ type: "varchar", length: 200, nullable: true })
    note!: string | null;

    /** How long the driver spent in the state they just left. */
    @Column({ type: "int", nullable: true })
    previousStateDurationSec!: number | null;

    @Column({ type: "timestamp" })
    occurredAt!: Date;

    @CreateDateColumn()
    createdAt!: Date;
}
