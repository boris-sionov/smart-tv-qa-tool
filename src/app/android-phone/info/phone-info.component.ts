import {Component, OnDestroy, OnInit} from '@angular/core';
import {Subscription} from 'rxjs';
import {AdbService} from '../../core/services/adb.service';
import {extractMessage} from '../../core/utils/error.utils';
import {phoneName, PhoneStateService} from '../phone-state.service';

interface InfoRow {
    label: string;
    value: string;
    icon: string;
    highlight?: boolean;
}

/** The current phone's model, Android version and build, laid out like Android TV's Info page. */
@Component({
    selector: 'app-phone-info',
    templateUrl: './phone-info.component.html',
    styleUrls: ['../../android-tv/info/android-tv-info.component.scss'],
})
export class PhoneInfoComponent implements OnInit, OnDestroy {
    serial = '';
    info: InfoRow[] = [];
    loading = false;
    error?: Error;
    copySuccess = false;
    private sub?: Subscription;

    constructor(public state: PhoneStateService, private adb: AdbService) {}

    get name(): string {
        return phoneName(this.state.current);
    }

    ngOnInit(): void {
        this.sub = this.state.changed$.subscribe(() => this.follow());
        this.follow();
    }

    ngOnDestroy(): void {
        this.sub?.unsubscribe();
    }

    private follow(): void {
        const serial = this.state.ready ? this.state.current!.serial : '';
        if (serial === this.serial) return;
        this.serial = serial;
        this.info = [];
        if (serial) void this.load();
    }

    async load(): Promise<void> {
        const serial = this.serial;
        this.loading = true;
        this.error = undefined;
        try {
            const props = [
                'ro.product.model', 'ro.product.manufacturer', 'ro.build.version.release',
                'ro.build.version.sdk', 'ro.product.name', 'ro.build.display.id', 'ro.product.cpu.abi',
            ];
            const v = await Promise.all(props.map(p => this.adb.getProp(serial, p)));
            if (serial !== this.serial) return;
            this.info = [
                {label: 'Model', value: v[0], icon: 'bi-phone', highlight: true},
                {label: 'Android Version', value: v[2], icon: 'bi-android2', highlight: true},
                {label: 'Manufacturer', value: v[1], icon: 'bi-building'},
                {label: 'API Level', value: v[3], icon: 'bi-code-slash'},
                {label: 'Product Name', value: v[4], icon: 'bi-tag-fill'},
                {label: 'Build', value: v[5], icon: 'bi-gear-fill'},
                {label: 'CPU', value: v[6], icon: 'bi-cpu'},
                {label: 'Serial', value: serial, icon: 'bi-usb-symbol'},
            ];
        } catch (e) {
            this.error = new Error(extractMessage(e, 'Failed to load phone info'));
        } finally {
            this.loading = false;
        }
    }

    async copyInfo(): Promise<void> {
        const get = (label: string) => this.info.find(i => i.label === label)?.value ?? '';
        await navigator.clipboard.writeText(`${get('Manufacturer')} ${get('Model')}, Android ${get('Android Version')}`);
        this.copySuccess = true;
        setTimeout(() => this.copySuccess = false, 1500);
    }
}
