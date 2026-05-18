import {Injectable} from '@angular/core';
import {Command} from '@tauri-apps/plugin-shell';
import {open as showOpenDialog} from '@tauri-apps/plugin-dialog';
import {invoke} from '@tauri-apps/api/core';
import {DeviceProvider, DeviceInfo, Platform, PlatformApp, PlatformDevice} from '../models/device-provider.interface';

export interface AdbDevice {
    serial: string;
    state: 'device' | 'offline' | 'unauthorized' | string;
}

export interface AdbPackageInfo {
    id: string;
    name: string;
    versionName: string;
}

// Friendly names keyed by package ID
const APP_NAME_MAP: Record<string, string> = {
    'tv.freetv.androidtv': 'FreeTV',
    'tv.freetv.androidtv.uat': 'FreeTV UAT',
    'tv.freetv.portal.preprod': 'FreeTV UAT',
    'il.co.stingtv.atv': 'StingTV',
    'il.co.stingtv.staging': 'StingTV Staging',
    'com.stingtv.androidtv': 'StingTV',
    'com.stingtv.androidtv.staging': 'StingTV Staging',
    'il.co.yes.yesplus': 'Yes+',
    'com.yes.yestv': 'Yes+',
    'tv.yes.androidtv': 'Yes+',
    'il.co.partnertv.atv': 'PartnerTV',
    'il.co.partnertv.atv.staging': 'PartnerTV Staging',
    'tv.partner.androidtv': 'PartnerTV',
    'tv.partner.androidtv.staging': 'PartnerTV Staging',
    'com.cellcom.cellcom_tv': 'CellcomTV',
    'tv.cellcom.androidtv': 'CellcomTV',
    'tv.cellcom.androidtv.stg': 'CellcomTV STG',
    'com.hot.stb': 'Hot',
    'il.co.hotnet.stb': 'Hot',
    'com.hot.nexttv': 'NextTV',
    'il.co.hot.nexttv': 'NextTV',
    'com.disney.disneyplus': 'Disney+',
    'com.warnermedia.max': 'HBO',
    'com.hbo.hbomax': 'HBO',
    'com.netflix.mediaclient': 'Netflix',
    'com.amazon.venezia': 'Amazon',
    'com.apple.appletv': 'Apple TV+',
};

function friendlyName(packageId: string): string {
    return APP_NAME_MAP[packageId] ?? packageId;
}

const WHITELISTED_APPS = [
    'FreeTV', 'FreeTV UAT',
    'StingTV', 'StingTV Staging',
    'Yes+',
    'PartnerTV', 'PartnerTV Staging',
    'CellcomTV', 'CellcomTV STG',
    'Hot', 'NextTV',
    'Disney+', 'HBO', 'Netflix', 'Amazon', 'Apple TV+',
];

// Fallback Google Play Store icon URLs for apps that don't extract properly
const FALLBACK_ICONS: Record<string, string> = {
    'il.co.yes.yesplus': 'https://play-lh.googleusercontent.com/T8x5oXCfaad12xaKT3SAFIkcWg999cVY78dUUxeVs6CLDZJiQzneIP_u_EYBG2i7pckQ=w240-h480',
    'com.yes.yestv': 'https://play-lh.googleusercontent.com/T8x5oXCfaad12xaKT3SAFIkcWg999cVY78dUUxeVs6CLDZJiQzneIP_u_EYBG2i7pckQ=w240-h480',
    'tv.yes.androidtv': 'https://play-lh.googleusercontent.com/T8x5oXCfaad12xaKT3SAFIkcWg999cVY78dUUxeVs6CLDZJiQzneIP_u_EYBG2i7pckQ=w240-h480',
    'il.co.stingtv.atv': 'https://play-lh.googleusercontent.com/e8wq32-bz0sN-pp0i3ny033dVhHGLPNmV-s1g3oc_dsnm-1rANniI_gjGhQdp6HVrJE=w240-h480',
    'com.stingtv.androidtv': 'https://play-lh.googleusercontent.com/e8wq32-bz0sN-pp0i3ny033dVhHGLPNmV-s1g3oc_dsnm-1rANniI_gjGhQdp6HVrJE=w240-h480',
    'il.co.stingtv.staging': 'https://play-lh.googleusercontent.com/e8wq32-bz0sN-pp0i3ny033dVhHGLPNmV-s1g3oc_dsnm-1rANniI_gjGhQdp6HVrJE=w240-h480',
};

const BRAND_ORDER = ['FreeTV', 'Yes', 'Sting', 'Partner', 'Cellcom', 'Hot', 'NextTV', 'Disney+', 'HBO', 'Netflix', 'Amazon', 'Apple TV+'];

function appSortKey(name: string): number {
    for (let i = 0; i < BRAND_ORDER.length; i++) {
        if (name.toLowerCase().includes(BRAND_ORDER[i].toLowerCase())) {
            const isVariant = name.includes('UAT') || name.includes('Staging') || name.includes('STG');
            return i * 10 + (isVariant ? 1 : 0);
        }
    }
    return 999;
}

@Injectable({providedIn: 'root'})
export class AdbService implements DeviceProvider {

    readonly platform: Platform = 'android-tv';

    /**
     * Run the bundled ADB sidecar directly — used only by getAppIcon
     * (pm path + pull). All other ADB calls go through the Rust plugin.
     */
    private async adb(...args: string[]): Promise<string> {
        const cmd = Command.sidecar('binaries/adb', args);
        const out = await cmd.execute();
        if (out.code !== 0) {
            throw new Error(out.stderr?.trim() || `adb exited with code ${out.code}`);
        }
        return out.stdout;
    }

    /**
     * Run a shell command via zsh for non-ADB system utilities
     * (base64, python3, etc. used during icon extraction).
     */
    private async shell(cmd: string): Promise<string> {
        const out = await Command.create('zsh', ['-lc', cmd]).execute();
        if (out.code !== 0) {
            throw new Error(out.stderr?.trim() || `shell exited with code ${out.code}`);
        }
        return out.stdout;
    }

    async listConnectedDevices(): Promise<PlatformDevice[]> {
        return invoke<AdbDevice[]>('plugin:adb-manager|adb_list_devices');
    }

    async connect(host: string): Promise<string> {
        return invoke<string>('plugin:adb-manager|adb_connect', {host});
    }

    async disconnect(serial: string): Promise<void> {
        return invoke<void>('plugin:adb-manager|adb_disconnect', {serial});
    }

    async listPackages(serial: string): Promise<AdbPackageInfo[]> {
        return invoke<AdbPackageInfo[]>('plugin:adb-manager|adb_list_packages', {serial});
    }

    // DeviceProvider bridge: listApps delegates to listPackages
    async listApps(serial: string): Promise<PlatformApp[]> {
        return this.listPackages(serial);
    }

    async getAppIcon(serial: string, packageId: string): Promise<string | null> {
        const cacheDir = `/tmp/freetv-qa-icons`;
        const imgFile = `${cacheDir}/${packageId}.img`;
        const mimeFile = `${cacheDir}/${packageId}.mime`;
        const tmpApk = `${cacheDir}/${packageId}.apk`;
        try {
            const exists = await this.shell(`test -f "${imgFile}" && echo yes || echo no`);
            if (exists.trim() === 'yes') {
                const mime = await this.shell(`cat "${mimeFile}" 2>/dev/null || echo image/png`);
                const b64 = await this.shell(`base64 "${imgFile}" | tr -d '\\n'`);
                return `data:${mime.trim()};base64,${b64.trim()}`;
            }
            await this.shell(`mkdir -p "${cacheDir}"`);

            // Get APK path
            const pathOut = await this.adb('-s', serial, 'shell', 'pm', 'path', packageId);
            const apkPath = pathOut.trim().replace('package:', '').trim();
            if (!apkPath) return null;

            // Pull APK using sidecar
            await this.adb('-s', serial, 'pull', apkPath, tmpApk);

            // Extract icon using python3 (macOS system tool)
            const py = [
                `import zipfile,sys,re`,
                `z=zipfile.ZipFile(sys.argv[1])`,
                `f=z.namelist()`,
                `d=lambda n:next((v for x,v in [('xxxhdpi',4),('xxhdpi',3),('xhdpi',2),('hdpi',1),('mdpi',0)] if x in n),-1)`,
                `b=[n for n in f if any(x in n.lower() for x in ['banner','ic_banner']) and (n.endswith('.png') or n.endswith('.webp')) and 'nodpi' not in n]`,
                `i=[n for n in f if re.search(r'(mipmap|drawable)-[^/]+/',n) and (n.endswith('.png') or n.endswith('.webp')) and 'nodpi' not in n and '_foreground' not in n.lower() and '_background' not in n.lower()]`,
                `p=([n for n in i if re.search(r'/(ic_launcher|icon)\\.(png|webp)$',n)] or [n for n in i if 'ic_' in n.lower()] or i)`,
                `c=(sorted(b,key=d,reverse=True) or sorted(p,key=d,reverse=True))`,
                `best=c[0] if c else None`,
                `sys.exit(1) if not best else None`,
                `open(sys.argv[2],'wb').write(z.read(best))`,
                `open(sys.argv[3],'w').write('image/webp' if best.endswith('.webp') else 'image/png')`,
            ].join(';');
            await this.shell(`python3 -c "${py}" "${tmpApk}" "${imgFile}" "${mimeFile}"`);
            await this.shell(`rm -f "${tmpApk}"`).catch(() => {});
            const mime = await this.shell(`cat "${mimeFile}" 2>/dev/null || echo image/png`);
            const b64 = await this.shell(`base64 "${imgFile}" | tr -d '\\n'`);
            return `data:${mime.trim()};base64,${b64.trim()}`;
        } catch {
            await this.shell(`rm -f "${tmpApk}"`).catch(() => {});
            // Return fallback Google Play Store icon if available
            return FALLBACK_ICONS[packageId] || null;
        }
    }

    async getProp(serial: string, prop: string): Promise<string> {
        return invoke<string>('plugin:adb-manager|adb_get_prop', {serial, prop});
    }

    async launch(serial: string, packageId: string): Promise<void> {
        return invoke<void>('plugin:adb-manager|adb_launch', {serial, packageId});
    }

    async forceStop(serial: string, packageId: string): Promise<void> {
        return invoke<void>('plugin:adb-manager|adb_force_stop', {serial, packageId});
    }

    async uninstall(serial: string, packageId: string): Promise<void> {
        return invoke<void>('plugin:adb-manager|adb_uninstall', {serial, packageId});
    }

    async install(serial: string, apkPath: string): Promise<void> {
        return invoke<void>('plugin:adb-manager|adb_install', {serial, apkPath});
    }

    // DeviceProvider bridge methods
    async launchApp(serial: string, appId: string): Promise<void> {
        return this.launch(serial, appId);
    }

    async killApp(serial: string, appId: string): Promise<void> {
        return this.forceStop(serial, appId);
    }

    async installApp(serial: string, filePath: string): Promise<void> {
        return this.install(serial, filePath);
    }

    async uninstallApp(serial: string, appId: string): Promise<void> {
        return this.uninstall(serial, appId);
    }

    async openPackageChooser(): Promise<string | null> {
        return this.openApkChooser();
    }

    async getDeviceInfo(serial: string): Promise<DeviceInfo> {
        const [model, manufacturer, osVersion] = await Promise.all([
            this.getProp(serial, 'ro.product.model').catch(() => ''),
            this.getProp(serial, 'ro.product.manufacturer').catch(() => ''),
            this.getProp(serial, 'ro.build.version.release').catch(() => ''),
        ]);
        return {model, manufacturer, osVersion};
    }

    async openApkChooser(): Promise<string | null> {
        return showOpenDialog({
            filters: [{name: 'APK package', extensions: ['apk']}],
            multiple: false,
        });
    }
}
