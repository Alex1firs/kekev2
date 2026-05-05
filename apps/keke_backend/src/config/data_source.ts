import "reflect-metadata";
import { DataSource } from "typeorm";
import { Wallet, LedgerEntry, Transaction, PayoutRecord, DriverProfile, Ride, AuditLog, User, DeviceToken } from "../models";
import dotenv from "dotenv";

dotenv.config();

const DATABASE_URL = process.env.DATABASE_URL || "postgres://localhost:5432/keke";
// Set DATABASE_SSL=true only when connecting to a managed/external Postgres
// that has SSL configured (e.g. DigitalOcean Managed DB). Leave unset for
// Docker-internal Postgres — the containerised DB has no SSL by default.
const USE_SSL = process.env.DATABASE_SSL === 'true';

export const AppDataSource = new DataSource({
    type: "postgres",
    url: DATABASE_URL,
    synchronize: false,
    logging: ["error", "warn", "migration"],
    entities: [Wallet, LedgerEntry, Transaction, PayoutRecord, DriverProfile, Ride, AuditLog, User, DeviceToken],
    migrations: ["dist/migrations/*.js"],
    subscribers: [],
    ssl: USE_SSL ? { rejectUnauthorized: false } : false,
    extra: {
        max: 20,
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 5000,
    },
});
