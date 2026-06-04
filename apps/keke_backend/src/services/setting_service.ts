import { AppDataSource } from "../config/data_source";
import { Setting } from "../models/Setting";

export class SettingService {
    static async getSetting(key: string, defaultValue: string): Promise<string> {
        try {
            const repo = AppDataSource.getRepository(Setting);
            const setting = await repo.findOneBy({ key });
            return setting ? setting.value : defaultValue;
        } catch (e: any) {
            console.error(`[SETTINGS] Failed to get setting key ${key}:`, e?.message);
            return defaultValue;
        }
    }

    static async getPricingConfig(): Promise<{ baseFare: number; perKmRate: number; platformFeePercent: number }> {
        const baseFare = Number(await this.getSetting("baseFare", "1300"));
        const perKmRate = Number(await this.getSetting("perKmRate", "300"));
        const platformFeePercent = Number(await this.getSetting("platformFeePercent", "10"));
        return { baseFare, perKmRate, platformFeePercent };
    }

    static async setSetting(key: string, value: string): Promise<void> {
        const repo = AppDataSource.getRepository(Setting);
        let setting = await repo.findOneBy({ key });
        if (setting) {
            setting.value = value;
        } else {
            setting = repo.create({ key, value });
        }
        await repo.save(setting);
    }
}
