import "reflect-metadata";
import { DataSource } from "typeorm";
import { Wallet, LedgerEntry, Transaction, PayoutRecord, DriverProfile, Ride, AuditLog } from "../models";
import dotenv from "dotenv";

dotenv.config();

const DATABASE_URL = process.env.DATABASE_URL || "postgres://localhost:5432/keke";

export const AppDataSource = new DataSource({
    type: "postgres",
    url: DATABASE_URL,
    synchronize: true, // Only for development
    logging: false,
    entities: [Wallet, LedgerEntry, Transaction, PayoutRecord, DriverProfile, Ride, AuditLog],
    migrations: [],
    subscribers: [],
});
