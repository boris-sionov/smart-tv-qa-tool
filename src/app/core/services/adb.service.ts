import {Injectable} from '@angular/core';
import {Command} from '@tauri-apps/plugin-shell';
import {open as showOpenDialog} from '@tauri-apps/plugin-dialog';

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
    'il.co.stingtv.staging': 'StingTV Staging',
    'com.stingtv.androidtv': 'StingTV',
    'com.stingtv.androidtv.staging': 'StingTV Staging',
    'com.yes.yestv': 'Yes+',
    'tv.yes.androidtv': 'Yes+',
    'il.co.partnertv.atv': 'PartnerTV',
    'il.co.partnertv.atv.staging': 'PartnerTV Staging',
    'tv.partner.androidtv': 'PartnerTV',
    'tv.partner.androidtv.staging': 'PartnerTV Staging',
    'com.cellcom.cellcom_tv': 'CellcomTV',
    'tv.cellcom.androidtv': 'CellcomTV',
    'tv.cellcom.androidtv.stg': 'CellcomTV STG',
};

function friendlyName(packageId: string): string {
    return APP_NAME_MAP[packageId] ?? packageId;
}

const BRAND_ORDER = ['FreeTV', 'Yes', 'Sting', 'Partner', 'Cellcom'];

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
export class AdbService {

    private async exec(shellCmd: string): Promise<string> {
        const cmd = Command.create('zsh', ['-lc', shellCmd]);
        const out = await cmd.execute();
        if (out.code !== 0) {
            throw new Error(out.stderr?.trim() || `adb exited with code ${out.code}`);
        }
        return out.stdout;
    }

    async listConnectedDevices(): Promise<AdbDevice[]> {
        const out = await this.exec('adb devices');
        return out.split('\n')
            .slice(1)
            .map(line => line.trim())
            .filter(line => line.length > 0)
            .map(line => {
                const [serial, state] = line.split(/\s+/);
                return {serial, state: state ?? 'device'} as AdbDevice;
            })
            .filter(d => !!d.serial);
    }

    async connect(host: string): Promise<string> {
        const target = host.includes(':') ? host : `${host}:5555`;
        return this.exec(`adb connect ${target}`);
    }

    async disconnect(serial: string): Promise<void> {
        await this.exec(`adb disconnect ${serial}`);
    }

    async listPackages(serial: string): Promise<AdbPackageInfo[]> {
        // Step 1: get raw package list, parse in TypeScript to avoid shell piping issues
        const listOut = await this.exec(`adb -s ${serial} shell pm list packages -3 -i`);
        const ids = listOut.split('\n')
            .map(l => l.trim())
            .filter(l => l.includes('installer=null'))
            .map(l => {
                const m = l.match(/^package:(\S+)/);
                return m ? m[1] : null;
            })
            .filter((id): id is string => id !== null && !id.startsWith('io.appium'));

        // Step 2: get versionName for each package in parallel, parse in TypeScript
        const results = await Promise.all(ids.map(async id => {
            const vn = await this.exec(`adb -s ${serial} shell pm dump ${id}`)
                .then(s => {
                    const m = s.match(/\bversionName=(\S+)/);
                    return m ? m[1] : '';
                })
                .catch(() => '');
            return {id, name: friendlyName(id), versionName: vn} as AdbPackageInfo;
        }));

        return results.sort((a, b) => appSortKey(a.name) - appSortKey(b.name));
    }

    async getAppIcon(serial: string, packageId: string): Promise<string | null> {
        const cacheDir = `/tmp/freetv-qa-icons`;
        const imgFile = `${cacheDir}/${packageId}.img`;
        const mimeFile = `${cacheDir}/${packageId}.mime`;
        const tmpApk = `${cacheDir}/${packageId}.apk`;
        try {
            const exists = await this.exec(`test -f "${imgFile}" && echo yes || echo no`);
            if (exists.trim() === 'yes') {
                const mime = await this.exec(`cat "${mimeFile}" 2>/dev/null || echo image/png`);
                const b64 = await this.exec(`base64 "${imgFile}" | tr -d '\\n'`);
                return `data:${mime.trim()};base64,${b64.trim()}`;
            }
            await this.exec(`mkdir -p "${cacheDir}"`);
            const pathOut = await this.exec(`adb -s ${serial} shell pm path ${packageId}`);
            const apkPath = pathOut.trim().replace('package:', '').trim();
            if (!apkPath) return null;
            await this.exec(`adb -s ${serial} pull "${apkPath}" "${tmpApk}"`);

            // Paths passed as argv to avoid shell quoting issues
            // For Android TV: prefer banners (wide landscape) over launcher icons (square)
            // Falls back to launcher icon if no banner found
            const py = [
                `import zipfile,sys,re`,
                `z=zipfile.ZipFile(sys.argv[1])`,
                `f=z.namelist()`,
                `d=lambda n:next((v for x,v in [('xxxhdpi',4),('xxhdpi',3),('xhdpi',2),('hdpi',1),('mdpi',0)] if x in n),-1)`,
                `b=[n for n in f if any(x in n.lower() for x in ['banner','ic_banner']) and (n.endswith('.png') or n.endswith('.webp')) and 'nodpi' not in n]`,
                `i=[n for n in f if re.search(r'mipmap-[^/]+/',n) and (n.endswith('.png') or n.endswith('.webp')) and 'nodpi' not in n and '_foreground' not in n.lower() and '_background' not in n.lower()]`,
                `p=([n for n in i if re.search(r'/ic_launcher\\.(png|webp)$',n)] or i)`,
                `c=(sorted(b,key=d,reverse=True) or sorted(p,key=d,reverse=True))`,
                `best=c[0] if c else None`,
                `sys.exit(1) if not best else None`,
                `open(sys.argv[2],'wb').write(z.read(best))`,
                `open(sys.argv[3],'w').write('image/webp' if best.endswith('.webp') else 'image/png')`,
            ].join(';');
            await this.exec(`python3 -c "${py}" "${tmpApk}" "${imgFile}" "${mimeFile}"`);
            await this.exec(`rm -f "${tmpApk}"`).catch(() => {});
            const mime = await this.exec(`cat "${mimeFile}" 2>/dev/null || echo image/png`);
            const b64 = await this.exec(`base64 "${imgFile}" | tr -d '\\n'`);
            return `data:${mime.trim()};base64,${b64.trim()}`;
        } catch {
            await this.exec(`rm -f "${tmpApk}"`).catch(() => {});
            return null;
        }
    }

    async getProp(serial: string, prop: string): Promise<string> {
        const out = await this.exec(`adb -s ${serial} shell getprop ${prop}`);
        return out.trim();
    }

    async launch(serial: string, packageId: string): Promise<void> {
        await this.exec(`adb -s ${serial} shell am start -a android.intent.action.MAIN -p ${packageId}`);
    }

    async forceStop(serial: string, packageId: string): Promise<void> {
        await this.exec(`adb -s ${serial} shell am force-stop ${packageId}`);
    }

    async uninstall(serial: string, packageId: string): Promise<void> {
        await this.exec(`adb -s ${serial} uninstall ${packageId}`);
    }

    async install(serial: string, apkPath: string): Promise<void> {
        await this.exec(`adb -s ${serial} install -r '${apkPath}'`);
        // Extract icons after installation
        await this.extractIconsAfterInstall();
    }

    private async extractIconsAfterInstall(): Promise<void> {
        try {
            await this.exec('cd /Users/borissionov/Privet/Projects/FreeTV-QA-Tool && npx tsx extract-icons.ts');
        } catch (e) {
            console.warn('Failed to extract icons:', (e as Error).message);
        }
    }

    async openApkChooser(): Promise<string | null> {
        return showOpenDialog({
            filters: [{name: 'APK package', extensions: ['apk']}],
            multiple: false,
        });
    }
}
