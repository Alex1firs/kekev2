import { AppDataSource } from "./src/config/data_source";
import { LedgerEntry, BalanceType } from "./src/models/LedgerEntry";
import { Not, In } from "typeorm";

async function main() {
    await AppDataSource.initialize();
    try {
        const history = await AppDataSource.getRepository(LedgerEntry).find({
            where: {
                walletId: "pax1",
                balanceType: Not(In([BalanceType.DRIVER_COMMISSION_DEBT, BalanceType.PLATFORM_REVENUE])),
            },
            order: { createdAt: "DESC" },
            take: 20
        });
        console.log("HISTORY:", history);
    } catch(err) {
        console.error("ERROR:", err);
    }
    process.exit(0);
}
main();
