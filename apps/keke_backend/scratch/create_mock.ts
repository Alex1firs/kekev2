import { AppDataSource } from "../src/config/data_source";
import { DriverProfile, DriverStatus } from "../src/models/DriverProfile";

async function createMockDriver() {
    try {
        await AppDataSource.initialize();
        console.log("Database initialized");

        const repo = AppDataSource.getRepository(DriverProfile);
        
        // Create a mock driver in PENDING_REVIEW state
        const driver = repo.create({
            userId: "mock-uuid-12345",
            firstName: "Test",
            lastName: "Driver",
            vehiclePlate: "TEST-001",
            vehicleModel: "Keke Prototype",
            status: DriverStatus.PENDING_REVIEW,
            licenseUrl: "mock_license.jpg",
            idCardUrl: "mock_id.jpg",
            vehiclePaperUrl: "mock_paper.jpg"
        });

        await repo.save(driver);
        console.log("Mock driver created successfully");

    } catch (error) {
        console.error("Failed to create mock driver:", error);
    } finally {
        await AppDataSource.destroy();
    }
}

createMockDriver();
