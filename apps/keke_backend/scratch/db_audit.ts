import { AppDataSource } from "../src/config/data_source";
import { DriverProfile } from "../src/models/DriverProfile";

async function audit() {
    try {
        await AppDataSource.initialize();
        console.log("Database initialized");

        const repo = AppDataSource.getRepository(DriverProfile);
        const drivers = await repo.find();

        console.log("Total drivers:", drivers.length);
        console.table(drivers.map(d => ({
            id: d.id,
            userId: d.userId,
            name: `${d.firstName} ${d.lastName}`,
            status: d.status,
            createdAt: d.createdAt
        })));

    } catch (error) {
        console.error("Audit failed:", error);
    } finally {
        await AppDataSource.destroy();
    }
}

audit();
