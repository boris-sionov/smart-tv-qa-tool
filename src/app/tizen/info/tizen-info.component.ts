import {Component, OnDestroy, OnInit} from '@angular/core';
import {Subscription} from 'rxjs';
import {SdbService, TizenInfoEntry} from '../../core/services/sdb.service';
import {tizenSerial, TizenDevice, TizenStateService} from '../tizen-state.service';

interface InfoRow {
    label: string;
    value: string;
    icon: string;
    highlight?: boolean;
}

@Component({
    selector: 'app-tizen-info',
    templateUrl: './tizen-info.component.html',
    styleUrls: ['./tizen-info.component.scss'],
})
export class TizenInfoComponent implements OnInit, OnDestroy {

    device: TizenDevice | null = null;
    devices: TizenDevice[] = [];
    info: InfoRow[] = [];
    loading = false;
    error?: Error;
    copySuccess = false;
    private sub?: Subscription;

    constructor(private sdb: SdbService, private state: TizenStateService) {}

    ngOnInit(): void {
        this.devices = this.state.getSavedDevices();
        this.sub = this.state.selected$.subscribe(dev => {
            this.device = dev;
            this.info = [];
            this.error = undefined;
            if (dev) this.loadInfo(dev);
        });
    }

    ngOnDestroy(): void {
        this.sub?.unsubscribe();
    }

    async loadInfo(dev: TizenDevice): Promise<void> {
        this.loading = true;
        this.error = undefined;
        const serial = tizenSerial(dev);
        try {
            let systemInfo: TizenInfoEntry[] = [];

            // Primary: full key-value info via sdb capability + /etc/info.ini
            const details = await this.sdb.getTizenBrewDeviceDetails(serial);
            systemInfo = details.systemInfo;

            // Fallback: basic device info if nothing came back
            if (systemInfo.length === 0) {
                const basic = await this.sdb.getDeviceInfo(serial).catch(() => null);
                if (basic) {
                    if (basic.model)      systemInfo.push({key: 'MODEL_NAME',    value: basic.model});
                    if (basic.osVersion)  systemInfo.push({key: 'TIZEN_VERSION', value: basic.osVersion});
                }
            }

            const get = (...keys: string[]): string => this.findValue(systemInfo, keys);

            const modelName    = get('model_name', 'MODEL_NAME', 'Model Name', 'Model', 'PRODUCT_CODE');
            const tizenVersion = get('TIZEN_VERSION', 'platform_version', 'Platform Version', 'Tizen Version', 'PRODUCT_VERSION', 'SW_VERSION');
            const platform     = get('PROFILE', 'profile_name', 'Platform', 'platform', 'PLATFORM', 'device_type', 'DEVICE_TYPE');

            this.info = [
                {label: 'Model Name',     value: modelName,     icon: 'bi-tag-fill',   highlight: true},
                {label: 'Tizen Version',  value: tizenVersion,  icon: 'bi-display',    highlight: true},
                {label: 'Platform',       value: platform,      icon: 'bi-layers-fill', highlight: true},
            ].filter(row => row.value !== '');

        } catch (e) {
            this.error = e as Error;
        } finally {
            this.loading = false;
        }
    }

    selectDevice(serial: string): void {
        const device = this.devices.find(dev => tizenSerial(dev) === serial) ?? null;
        this.state.select(device);
    }

    private findValue(entries: TizenInfoEntry[], keys: string[]): string {
        const normalized = new Map(entries.map(entry => [this.normalizeKey(entry.key), entry.value]));
        for (const key of keys) {
            const value = normalized.get(this.normalizeKey(key));
            if (value) return value;
        }
        return '';
    }

    private normalizeKey(key: string): string {
        return key.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
    }

    async copyDeviceInfo(): Promise<void> {
        const model    = this.info.find(i => i.label === 'Model Name')?.value ?? '';
        const tizen    = this.info.find(i => i.label === 'Tizen Version')?.value ?? '';
        const platform = this.info.find(i => i.label === 'Platform')?.value ?? '';
        const text = [
            model    && `Model: ${model}`,
            tizen    && `Tizen: ${tizen}`,
            platform && `Platform: ${platform}`,
        ].filter(Boolean).join('\n') || (this.device?.name ?? '');
        try {
            await navigator.clipboard.writeText(text);
            this.copySuccess = true;
            setTimeout(() => this.copySuccess = false, 2000);
        } catch {}
    }
}
