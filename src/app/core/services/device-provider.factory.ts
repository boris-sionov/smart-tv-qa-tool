import {Injectable} from '@angular/core';
import {DeviceProvider, Platform} from '../models/device-provider.interface';
import {AdbService} from './adb.service';
import {SdbService} from './sdb.service';

@Injectable({providedIn: 'root'})
export class DeviceProviderFactory {
    private readonly providers: Partial<Record<Platform, DeviceProvider>>;

    constructor(adb: AdbService, sdb: SdbService) {
        this.providers = {
            'android-tv': adb,
            'tizen': sdb,
        };
    }

    get(platform: Platform): DeviceProvider {
        const provider = this.providers[platform];
        if (!provider) throw new Error(`No provider registered for platform: ${platform}`);
        return provider;
    }

    supports(platform: Platform): boolean {
        return platform in this.providers;
    }
}
