import "reflect-metadata";
import { DataSource } from "typeorm";
import { Wallet, LedgerEntry, Transaction, PayoutRecord, DriverProfile, Ride, AuditLog, User, DeviceToken } from "../models";
import dotenv from "dotenv";

dotenv.config();

const DATABASE_URL = process.env.DATABASE_URL || "postgres://localhost:5432/keke";
const IS_PROD = process.env.NODE_ENV === 'production';

export const AppDataSource = new DataSource({
    type: "postgres",
    url: DATABASE_URL,
    synchronize: false,
    logging: ["error", "warn", "migration"],
    entities: [Wallet, LedgerEntry, Transaction, PayoutRecord, DriverProfile, Ride, AuditLog, User, DeviceToken],
    migrations: ["dist/migrations/*.js"],
    subscribers: [],
    ssl: IS_PROD ? { rejectUnauthorized: false } : false,
    extra: {
        max: 20,
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 5000,
    },
});
