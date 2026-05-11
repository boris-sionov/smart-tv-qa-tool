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

            // Primary: try to get full key-value info from the TV
            const details = await this.sdb.getTizenBrewDeviceDetails(serial);
            systemInfo = details.systemInfo;

            // Fallback: if nothing came back, use getDeviceInfo (model/firmware/osVersion)
            if (systemInfo.length === 0) {
                const basic = await this.sdb.getDeviceInfo(serial).catch(() => null);
                if (basic) {
                    if (basic.model)        systemInfo.push({key: 'Model Name',    value: basic.model});
                    if (basic.manufacturer) systemInfo.push({key: 'Manufacturer', value: basic.manufacturer});
                    if (basic.osVersion)    systemInfo.push({key: 'Tizen Version', value: basic.osVersion});
                }
            }

            const get = (...keys: string[]): string => this.findValue(systemInfo, keys);

            this.info = [
                {
                    label: 'Model Name',
                    value: get('MODEL_NAME', 'Model Name', 'Model', 'model', 'PRODUCT_CODE', 'Product Code'),
                    icon: 'bi-tag-fill',
                    highlight: true,
                },
                {
                    label: 'Tizen Version',
                    value: get('TIZEN_VERSION', 'Tizen Version', 'tizen', 'tizen_version', 'PRODUCT_VERSION', 'Platform Version', 'OS Version'),
                    icon: 'bi-display',
                    highlight: true,
                },
                {
                    label: 'Manufacturer',
                    value: get('MANUFACTURER', 'Manufacturer', 'manufacturer'),
                    icon: 'bi-building',
                },
                {
                    label: 'Firmware',
                    value: get('FIRMWARE_VERSION', 'firmware', 'Firmware', 'FIRMWARE', 'SW_VERSION', 'Build'),
                    icon: 'bi-gear-fill',
                },
                {
                    label: 'Resolution',
                    value: get('SCREEN_SIZE', 'resolution', 'RESOLUTION', 'Resolution', 'screen_size'),
                    icon: 'bi-aspect-ratio-fill',
                },
                ...this.additionalSystemRows(systemInfo),
            ].filter(row => row.value !== '');

            if (this.info.length === 0) {
                this.info = [{label: 'Device Name', value: dev.name, icon: 'bi-tag-fill'}];
            }
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

    private additionalSystemRows(entries: TizenInfoEntry[]): InfoRow[] {
        const used = new Set([
            'model_name', 'model', 'product_code',
            'tizen_version', 'product_version', 'platform_version', 'os_version',
            'platform', 'device_type',
            'firmware_version', 'firmware', 'sw_version', 'build',
            'screen_size', 'resolution',
            'sdb_version',
        ]);

        return entries
            .filter(entry => !used.has(this.normalizeKey(entry.key)))
            .slice(0, 12)
            .map(entry => ({
                label: this.prettyLabel(entry.key),
                value: entry.value,
                icon: 'bi-info-square',
            }));
    }

    private normalizeKey(key: string): string {
        return key.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
    }

    private prettyLabel(key: string): string {
        return key
            .replace(/[_-]+/g, ' ')
            .replace(/\s+/g, ' ')
            .trim()
            .replace(/\b\w/g, chr => chr.toUpperCase());
    }

    async copyDeviceInfo(): Promise<void> {
        const model = this.info.find(i => i.label === 'Model Name')?.value ?? '';
        const tizen = this.info.find(i => i.label === 'Tizen Version')?.value ?? '';
        const text = [
            model && `Model: ${model}`,
            tizen && `Tizen: ${tizen}`,
        ].filter(Boolean).join('\n') || (this.device?.name ?? '');
        try {
            await navigator.clipboard.writeText(text);
            this.copySuccess = true;
            setTimeout(() => this.copySuccess = false, 2000);
        } catch {}
    }
}
