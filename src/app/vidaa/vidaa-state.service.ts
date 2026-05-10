import {Injectable} from '@angular/core';
import {BehaviorSubject} from 'rxjs';

export interface VidaaSavedDevice {
    name: string;
    ip: string;
}

const STORAGE_KEY = 'freetv-vidaa-devices';

@Injectable({providedIn: 'root'})
export class VidaaStateService {

    selected$ = new BehaviorSubject<VidaaSavedDevice | null>(null);

    getSavedDevices(): VidaaSavedDevice[] {
        try {
            return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]');
        } catch {
            return [];
        }
    }

    saveDevice(device: VidaaSavedDevice): void {
        const list = this.getSavedDevices();
        const idx = list.findIndex(d => d.ip === device.ip);
        if (idx >= 0) {
            list[idx] = device;
        } else {
            list.push(device);
        }
        localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
    }

    removeDevice(device: VidaaSavedDevice): void {
        const list = this.getSavedDevices().filter(d => d.ip !== device.ip);
        localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
        if (this.selected$.value?.ip === device.ip) {
            this.selected$.next(list[0] ?? null);
        }
    }

    select(device: VidaaSavedDevice | null): void {
        this.selected$.next(device);
    }
}
