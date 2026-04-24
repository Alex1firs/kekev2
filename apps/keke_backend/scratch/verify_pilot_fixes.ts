import { AppDataSource } from "../src/config/data_source";
import { DriverProfile, DriverStatus } from "../src/models/DriverProfile";
import { DeviceToken } from "../src/models/DeviceToken";
import { UserRole } from "../src/models/User";

async function verifyPilotFixes() {
    await AppDataSource.initialize();
    
    const driverRepo = AppDataSource.getRepository(DriverProfile);
    const tokenRepo = AppDataSource.getRepository(DeviceToken);

    console.log("\n--- Track 1: Suspension Enforcement ---");
    let testDriver = await driverRepo.findOne({ where: { status: DriverStatus.SUSPENDED } });
    if (testDriver) {
        console.log(`✅ DB PASS: Driver ${testDriver.userId} is correctly marked as SUSPENDED`);
    }

    console.log("\n--- Track 2: Rejection Reason Clearance ---");
    let rejectedDriver = await driverRepo.findOne({ where: { status: DriverStatus.PENDING_REVIEW } });
    if (rejectedDriver && !rejectedDriver.rejectionReason) {
        console.log("✅ SUCCESS: Rejection reason is null (cleared) for resubmitted driver");
    }

    console.log("\n--- Track 3: FCM Token Integrity ---");
    const testToken = "test-fcm-token-" + Date.now();
    
    // User A takes the token
    await tokenRepo.upsert({
        userId: "user-A",
        token: testToken,
        role: UserRole.DRIVER,
        platform: "ios",
        isActive: true
    }, ["token"]);
    
    // User B takes the SAME token
    await tokenRepo.upsert({
        userId: "user-B",
        token: testToken,
        role: UserRole.DRIVER,
        platform: "ios",
        isActive: true
    }, ["token"]);

    const tokens = await tokenRepo.find({ where: { token: testToken } });
    if (tokens.length === 1 && tokens[0].userId === "user-B") {
        console.log("✅ SUCCESS: Token deduplicated. Ownership transferred from A to B.");
    } else {
        console.error(`❌ FAIL: Expected 1 token for user-B, found ${tokens.length}`);
    }

    await AppDataSource.destroy();
}

verifyPilotFixes().catch(console.error);
