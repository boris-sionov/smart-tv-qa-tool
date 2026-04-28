import {Injectable} from '@angular/core';
import {BehaviorSubject} from 'rxjs';

export interface SavedDevice {
    name: string;
    ip: string;
    port: number;
}

export function deviceSerial(d: SavedDevice): string {
    return `${d.ip}:${d.port}`;
}

const STORAGE_KEY = 'freetv-android-tv-devices';
const SELECTED_STORAGE_KEY = 'freetv-android-tv-selected-device';

@Injectable({providedIn: 'root'})
export class AdbStateService {

    selected$ = new BehaviorSubject<SavedDevice | null>(this.getLastSelectedDevice());

    constructor() {
        const isInitialized = localStorage.getItem('adb-state-initialized');
        if (!isInitialized) {
            localStorage.removeItem(STORAGE_KEY);
            localStorage.removeItem(SELECTED_STORAGE_KEY);
            localStorage.setItem('adb-state-initialized', 'true');
            this.selected$.next(null);
        }
    }

    getSavedDevices(): SavedDevice[] {
        try {
            return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]');
        } catch {
            return [];
        }
    }

    saveDevice(device: SavedDevice): void {
        const list = this.getSavedDevices();
        const idx = list.findIndex(d => d.ip === device.ip && d.port === device.port);
        if (idx >= 0) {
            list[idx] = device;
        } else {
            list.push(device);
        }
        localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
    }

    removeDevice(device: SavedDevice): void {
        const list = this.getSavedDevices().filter(
            d => !(d.ip === device.ip && d.port === device.port)
        );
        localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
        if (this.selected$.value?.ip === device.ip && this.selected$.value?.port === device.port) {
            this.select(list[0] ?? null);
        }
    }

    select(device: SavedDevice | null): void {
        if (device) {
            localStorage.setItem(SELECTED_STORAGE_KEY, deviceSerial(device));
        } else {
            localStorage.removeItem(SELECTED_STORAGE_KEY);
        }
        this.selected$.next(device);
    }

    private getLastSelectedDevice(): SavedDevice | null {
        const serial = localStorage.getItem(SELECTED_STORAGE_KEY);
        const devices = this.getSavedDevices();
        if (serial) {
            const match = devices.find(d => deviceSerial(d) === serial);
            if (match) return match;
        }
        return devices[0] ?? null;
    }
}
