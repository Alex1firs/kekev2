import { AppDataSource } from "../config/data_source";
import { Ride, RideStatus } from "../models/Ride";
import { LessThan, In } from "typeorm";

async function cleanup() {
    console.log("--- Starting Stale Ride Cleanup ---");
    
    if (!AppDataSource.isInitialized) {
        await AppDataSource.initialize();
    }

    const rideRepo = AppDataSource.getRepository(Ride);
    
    // Define "stale" as older than 2 hours
    const staleThreshold = new Date(Date.now() - 2 * 60 * 60 * 1000);

    const activeStatuses = [
        RideStatus.SEARCHING,
        RideStatus.ACCEPTED,
        RideStatus.ARRIVED,
        RideStatus.IN_PROGRESS,
        RideStatus.STARTED
    ];

    const staleRides = await rideRepo.find({
        where: {
            status: In(activeStatuses),
            updatedAt: LessThan(staleThreshold)
        }
    });

    console.log(`Found ${staleRides.length} stagnant rides updated before ${staleThreshold.toISOString()}`);

    if (staleRides.length > 0) {
        for (const ride of staleRides) {
            console.log(`Cleaning up ride ${ride.rideId} (status: ${ride.status}, last update: ${ride.updatedAt.toISOString()})`);
            ride.status = RideStatus.FAILED;
            ride.completedAt = new Date();
        }

        await rideRepo.save(staleRides);
        console.log(`Successfully failed ${staleRides.length} stagnant rides.`);
    }

    console.log("--- Cleanup Complete ---");
    process.exit(0);
}

cleanup().catch(err => {
    console.error("Cleanup failed:", err);
    process.exit(1);
});
