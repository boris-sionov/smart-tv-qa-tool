import {Injectable} from '@angular/core';
import {invoke} from '@tauri-apps/api/core';
import {open} from '@tauri-apps/plugin-shell';

export interface VidaaDeviceInfo {
    Browser: string;
    'Protocol-Version': string;
    'User-Agent': string;
    'WebKit-Version': string;
}

export interface VidaaCdpPage {
    id: string;
    title: string;
    url: string;
    page_type: string;
    ws_debugger_url: string;
}

export interface VidaaApp {
    Id: string;
    AppName: string;
    URL: string;
    IconURL: string;
    InstallTime: string;
}

function toAppId(url: string): string {
    return 'freetv_' + url.replace(/[^a-zA-Z0-9]/g, '_').substring(0, 50);
}

@Injectable({providedIn: 'root'})
export class VidaaService {

    private call<T>(method: string, args?: Record<string, unknown>): Promise<T> {
        return invoke<T>(`plugin:vidaa|${method}`, args);
    }

    getDeviceInfo(ip: string): Promise<VidaaDeviceInfo> {
        return this.call('get_device_info', {ip});
    }

    getPages(ip: string): Promise<VidaaCdpPage[]> {
        return this.call('get_pages', {ip});
    }

    listApps(ip: string): Promise<VidaaApp[]> {
        return this.call('list_apps', {ip});
    }

    installApp(ip: string, appUrl: string, name: string): Promise<void> {
        const appId = toAppId(appUrl);
        return this.call('install_app', {ip, appUrl, name, appId});
    }

    uninstallApp(ip: string, appId: string): Promise<void> {
        return this.call('uninstall_app', {ip, appId});
    }

    inspect(ip: string): Promise<void> {
        return open(`http://${ip}:9226`);
    }
}
