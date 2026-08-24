import {Injectable} from '@angular/core';
import {invoke} from '@tauri-apps/api/core';
import {Device} from '../../types';

interface PressButtonResult {
    client_key: string | null;
}

interface ListAppsResult {
    client_key: string | null;
    apps: SsapApp[];
}

/**
 * An entry of `ssap://com.webos.applicationManager/listApps` — the same list the TV's own
 * launcher shows, so system and Content Store apps are included.
 */
export interface SsapApp {
    id: string;
    title: string;
    icon?: string;
    largeIcon?: string;
    folderPath?: string;
    type?: string;
    version?: string;
    vendor?: string;
    systemApp?: boolean;
    removable?: boolean;
    visible?: boolean;

    [key: string]: unknown;
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
        this.rememberClientKey(host, clientKey, result.client_key);
    }

    /**
     * Lists every app on the TV over SSAP. The first call on an unpaired TV puts a prompt on
     * screen that has to be accepted with the remote.
     */
    async listApps(device: Device): Promise<SsapApp[]> {
        const host = device.host;
        const clientKey = localStorage.getItem(this.storageKey(host)) ?? null;
        const result = await invoke<ListAppsResult>('plugin:lg-remote|list_apps', {
            args: {host, client_key: clientKey},
        });
        this.rememberClientKey(host, clientKey, result.client_key);
        return result.apps ?? [];
    }

    private rememberClientKey(host: string, previous: string | null, current: string | null): void {
        if (current && current !== previous) {
            localStorage.setItem(this.storageKey(host), current);
        }
    }
}
