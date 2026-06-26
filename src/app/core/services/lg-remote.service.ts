import {Injectable} from '@angular/core';
import {invoke} from '@tauri-apps/api/core';
import {Device} from '../../types';

interface PressButtonResult {
    client_key: string | null;
}

@Injectable({providedIn: 'root'})
export class LgRemoteService {

    private storageKey(host: string): string {
        return `lg-ssap-client-key:${host}`;
    }

    async pressButton(device: Device, button: string): Promise<void> {
        const host = device.host;
        const clientKey = localStorage.getItem(this.storageKey(host)) ?? null;
        const result = await invoke<PressButtonResult>('plugin:lg-remote|press_button', {
            args: {host, button, client_key: clientKey},
        });
        if (result.client_key && result.client_key !== clientKey) {
            localStorage.setItem(this.storageKey(host), result.client_key);
        }
    }
}
