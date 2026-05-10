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
            const details = await this.sdb.getTizenBrewDeviceDetails(serial);
            const systemInfo = details.systemInfo;
            if (systemInfo.length === 0 && details.daemonError) {
                throw new Error(`Could not load TizenBrew sysinfo.\n\n${details.daemonError}`);
            }
            const get = (...keys: string[]): string => this.findValue(systemInfo, keys);

            this.info = [
                {
                    label: 'Model Name',
                    value: get('MODEL_NAME', 'Model', 'model', 'PRODUCT_CODE', 'Product Code'),
                    icon: 'bi-tag-fill',
                    highlight: true,
                },
                {
                    label: 'Tizen Version',
                    value: get('TIZEN_VERSION', 'Tizen Version', 'tizen_version', 'PRODUCT_VERSION', 'Platform Version', 'OS Version'),
                    icon: 'bi-display',
                    highlight: true,
                },
                {
                    label: 'Platform',
                    value: get('Platform'),
                    icon: 'bi-layers-fill',
                    highlight: true,
                },
                {
                    label: 'Firmware',
                    value: get('FIRMWARE_VERSION', 'Firmware', 'FIRMWARE', 'SW_VERSION', 'Build'),
                    icon: 'bi-gear-fill',
                },
                {
                    label: 'Resolution',
                    value: get('SCREEN_SIZE', 'RESOLUTION', 'Resolution', 'screen_size'),
                    icon: 'bi-aspect-ratio-fill',
                },
                ...this.additionalSystemRows(systemInfo),
            ].filter(row => row.value !== '');

            if (this.info.length === 0) {
                this.info = [{label: 'Model Name', value: dev.name, icon: 'bi-tag-fill'}];
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
