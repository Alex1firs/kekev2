import "reflect-metadata";
import { DataSource } from "typeorm";
import { Wallet, LedgerEntry, Transaction, PayoutRecord, DriverProfile, Ride, AuditLog, User, DeviceToken, SavedLocation, Setting, SosAlert, RideReview, DispatchEvent, StaffUser, StaffRoleAssignment, StaffSession, StaffAuditEvent, ContactRevealEvent, Park, ParkZone, DispatcherShift, DriverPresence, DriverPresenceEvent, ParkDriverRoster, DriverBadge, ParkDispatchJob, StaffDeviceToken, StaffPushDelivery } from "../models";
import dotenv from "dotenv";
import { PassengerCommunicationPreference } from "../models/PassengerCommunicationPreference";
import { EmailSuppression } from "../models/EmailSuppression";
import { EmailCampaign } from "../models/EmailCampaign";
import { EmailCampaignRecipient } from "../models/EmailCampaignRecipient";
import { EmailDeliveryEvent } from "../models/EmailDeliveryEvent";
import { EmailAudienceSegment } from "../models/EmailAudienceSegment";
import { CommunicationCampaign, CommunicationCampaignChannel } from "../models/CommunicationCampaign";
import { MarketingPushJob } from "../models/MarketingPushJob";

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
    entities: [Wallet, LedgerEntry, Transaction, PayoutRecord, DriverProfile, Ride, AuditLog, User, DeviceToken, SavedLocation, Setting, SosAlert, RideReview, DispatchEvent, StaffUser, StaffRoleAssignment, StaffSession, StaffAuditEvent, ContactRevealEvent, Park, ParkZone, DispatcherShift, DriverPresence, DriverPresenceEvent, ParkDriverRoster, DriverBadge, ParkDispatchJob, StaffDeviceToken, StaffPushDelivery,
    PassengerCommunicationPreference, EmailSuppression, EmailCampaign, EmailCampaignRecipient, EmailDeliveryEvent, EmailAudienceSegment,
    CommunicationCampaign, CommunicationCampaignChannel,
    MarketingPushJob,
],

    migrations: ["dist/migrations/*.js"],
    migrationsTransactionMode: "each",
    subscribers: [],
    ssl: USE_SSL ? { rejectUnauthorized: false } : false,
    extra: {
        max: 20,
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 5000,
    },
});
