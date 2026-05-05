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
    info: InfoRow[] = [];
    loading = false;
    error?: Error;
    copySuccess = false;
    private sub?: Subscription;

    constructor(private sdb: SdbService, private state: TizenStateService) {}

    ngOnInit(): void {
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
            // Read device info from /etc/info.ini
            const infoIni = await (this.sdb as any).exec(
                `SDB=""; for _try in "$HOME/.tizen-studio/tools/sdb" "$HOME/tizen-studio/tools/sdb"; do [ -x "$_try" ] && { SDB="$_try"; break; }; done; [ -z "$SDB" ] && SDB="$(command -v sdb 2>/dev/null)"; [ -z "$SDB" ] && exit 1; "$SDB" -s '${serial}' shell 0 cat /etc/info.ini 2>/dev/null`
            ).catch(() => '');

            const get = (key: string): string => {
                const m = infoIni.match(new RegExp(`^${key}\\s*=\\s*(.+)$`, 'im'));
                return m ? m[1].trim() : '';
            };

            this.info = [
                {label: 'Device Name', value: dev.name, icon: 'bi-tv', highlight: false},
                {label: 'Model Name', value: get('MODEL_NAME') || get('PRODUCT_CODE') || '', icon: 'bi-tag-fill', highlight: true},
                {label: 'Tizen Version', value: get('TIZEN_VERSION') || get('PRODUCT_VERSION') || '', icon: 'bi-display', highlight: true},
                {label: 'Firmware', value: get('FIRMWARE_VERSION') || get('FIRMWARE') || '', icon: 'bi-gear-fill'},
                {label: 'Resolution', value: get('SCREEN_SIZE') || get('RESOLUTION') || '', icon: 'bi-aspect-ratio-fill'},
                {label: 'IP Address', value: dev.ip, icon: 'bi-router-fill'},
            ].filter(row => row.value !== '');

            if (this.info.length === 0) {
                this.info = [
                    {label: 'Device Name', value: dev.name, icon: 'bi-tv'},
                    {label: 'IP Address', value: dev.ip, icon: 'bi-router-fill'},
                ];
            }
        } catch (e) {
            this.error = e as Error;
        } finally {
            this.loading = false;
        }
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
