import {Injectable} from '@angular/core';
import {BehaviorSubject} from 'rxjs';

export interface TizenDevice {
    name: string;
    ip: string;
    port: number;
}

export function tizenSerial(device: TizenDevice): string {
    return `${device.ip}:${device.port}`;
}

const STORAGE_KEY = 'smart-tv-qa-tizen-devices';
const SELECTED_STORAGE_KEY = 'smart-tv-qa-tizen-selected-device';
const STUDIO_PATH_KEY = 'smart-tv-qa-tizen-studio-path';
const CERT_PROFILE_KEY = 'smart-tv-qa-tizen-cert-profile';

@Injectable({providedIn: 'root'})
export class TizenStateService {
    selected$ = new BehaviorSubject<TizenDevice | null>(this.getLastSelectedDevice());

    getSavedDevices(): TizenDevice[] {
        try {
            return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]');
        } catch {
            return [];
        }
    }

    saveDevice(device: TizenDevice): void {
        const list = this.getSavedDevices();
        const idx = list.findIndex(d => d.ip === device.ip && d.port === device.port);
        if (idx >= 0) {
            list[idx] = device;
        } else {
            list.push(device);
        }
        localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
    }

    removeDevice(device: TizenDevice): void {
        const list = this.getSavedDevices().filter(d => !(d.ip === device.ip && d.port === device.port));
        localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
        if (this.selected$.value?.ip === device.ip && this.selected$.value?.port === device.port) {
            this.select(list[0] ?? null);
        }
    }

    select(device: TizenDevice | null): void {
        if (device) {
            localStorage.setItem(SELECTED_STORAGE_KEY, tizenSerial(device));
        } else {
            localStorage.removeItem(SELECTED_STORAGE_KEY);
        }
        this.selected$.next(device);
    }

    // ── Certificate profile ────────────────────────────────────────────────────

    getCertProfile(): string | null {
        return localStorage.getItem(CERT_PROFILE_KEY);
    }

    setCertProfile(name: string | null): void {
        name
            ? localStorage.setItem(CERT_PROFILE_KEY, name)
            : localStorage.removeItem(CERT_PROFILE_KEY);
    }

    getStudioPath(): string | null {
        return localStorage.getItem(STUDIO_PATH_KEY);
    }

    setStudioPath(path: string | null): void {
        path
            ? localStorage.setItem(STUDIO_PATH_KEY, path)
            : localStorage.removeItem(STUDIO_PATH_KEY);
    }

    private getLastSelectedDevice(): TizenDevice | null {
        const serial = localStorage.getItem(SELECTED_STORAGE_KEY);
        const devices = this.getSavedDevices();
        if (serial) {
            const match = devices.find(d => tizenSerial(d) === serial);
            if (match) return match;
        }
        return devices[0] ?? null;
    }
}
