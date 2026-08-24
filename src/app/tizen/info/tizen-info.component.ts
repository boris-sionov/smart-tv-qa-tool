import {Component, OnDestroy, OnInit} from '@angular/core';
import {Subscription} from 'rxjs';
import {SdbService} from '../../core/services/sdb.service';
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
            const basic = await this.sdb.getDeviceInfo(serial).catch(() => null);

            const modelName    = basic?.model      ?? '';
            const tizenVersion = basic?.osVersion  ?? '';
            const platform     = 'tv';

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
