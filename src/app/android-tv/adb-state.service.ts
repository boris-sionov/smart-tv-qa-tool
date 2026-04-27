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

@Injectable({providedIn: 'root'})
export class AdbStateService {

    selected$ = new BehaviorSubject<SavedDevice | null>(null);

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
        if (this.selected$.value?.ip === device.ip) {
            this.selected$.next(list[0] ?? null);
        }
    }

    select(device: SavedDevice | null): void {
        this.selected$.next(device);
    }
}
