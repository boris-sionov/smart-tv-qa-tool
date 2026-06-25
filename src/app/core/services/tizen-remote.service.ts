import {Injectable} from '@angular/core';
import {invoke} from '@tauri-apps/api/core';
import {TizenDevice} from '../../tizen/tizen-state.service';

interface PressKeyResult {
    token: string | null;
}

@Injectable({providedIn: 'root'})
export class TizenRemoteService {

    private storageKey(ip: string): string {
        return `samsung-remote-token:${ip}`;
    }

    async pressKey(device: TizenDevice, key: string): Promise<void> {
        const token = localStorage.getItem(this.storageKey(device.ip)) ?? null;
        const result = await invoke<PressKeyResult>('plugin:adb-manager|tizen_press_key', {
            args: {ip: device.ip, key, token},
        });
        if (result.token && result.token !== token) {
            localStorage.setItem(this.storageKey(device.ip), result.token);
        }
    }
}
