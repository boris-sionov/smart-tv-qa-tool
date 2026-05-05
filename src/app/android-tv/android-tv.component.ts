import {Component, OnInit} from '@angular/core';
import {Router} from '@angular/router';
import {AdbService} from '../core/services/adb.service';
import {AdbStateService, deviceSerial, SavedDevice} from './adb-state.service';

@Component({
    selector: 'app-android-tv',
    templateUrl: './android-tv.component.html',
    styleUrls: ['./android-tv.component.scss']
})
export class AndroidTvComponent implements OnInit {

    devices: SavedDevice[] = [];
    selected: SavedDevice | null = null;

    constructor(
        public state: AdbStateService,
        private adb: AdbService,
        private router: Router,
    ) {}

    ngOnInit(): void {
        this.devices = this.state.getSavedDevices();
        this.selected = this.state.selected$.value ?? this.devices[0] ?? null;
        if (this.selected) this.state.select(this.selected);
    }

    selectDevice(serial: string): void {
        const dev = this.devices.find(d => deviceSerial(d) === serial) ?? null;
        this.selected = dev;
        this.state.select(dev);
        if (dev) {
            this.adb.connect(deviceSerial(dev)).catch(() => {});
        }
    }

    onDevicesChanged(): void {
        this.devices = this.state.getSavedDevices();
        if (!this.devices.find(d => deviceSerial(d) === deviceSerial(this.selected!))) {
            this.selected = this.devices[0] ?? null;
            this.state.select(this.selected);
        }
    }

    goBack(): void {
        this.router.navigate(['/']);
    }

    openLg(): void {
        this.router.navigate(['/lg']);
    }

    openAndroid(): void {
        this.router.navigate(['/android-tv']);
    }

    openTizen(): void {
        this.router.navigate(['/tizen']);
    }
}
