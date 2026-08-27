import {Injectable} from '@angular/core';
import {BehaviorSubject, catchError, firstValueFrom, lastValueFrom, mergeMap, noop, Observable, Subject, timeout} from 'rxjs';
import {Device, PackageInfo, PackageSource, RawPackageInfo} from '../../types';
import {
    LunaResponse,
    LunaResponseError,
    LunaServiceNotFoundError,
    LunaUnknownMethodError,
    RemoteLunaService
} from "./remote-luna.service";
import {RemoteCommandService} from "./remote-command.service";
import {filter, map} from "rxjs/operators";
import {RemoteFileService, ServeInstance} from "./remote-file.service";
import {IncompatibleReason, PackageManifest, RepositoryItem} from "./apps-repo.service";
import {fromPromise} from "rxjs/internal/observable/innerFrom";
import {LocalFileService} from "./local-file.service";
import _ from "lodash-es";
import {APP_ID_HBCHANNEL} from "../../shared/constants";
import {DeviceManagerService} from "./device-manager.service";
import {HomebrewChannelConfiguration} from "../../types/luna-apis";
import {download} from "@tauri-apps/plugin-upload";
import {LgRemoteService, SsapApp} from "./lg-remote.service";
import {IconCacheService} from "./icon-cache.service";
import {environmentIcon, readBundledIcon} from "../../shared/app-environment-icons";
import {appEnvironment, isPriorityApp} from "../../shared/known-apps";
import {info as logInfo, warn as logWarn} from "@tauri-apps/plugin-log";

const APP_ROOTS: ReadonlyArray<[string, PackageSource]> = [
    ['/media/developer/apps/usr/palm/applications', 'developer'],
    ['/media/cryptofs/apps/usr/palm/applications', 'store'],
    ['/usr/palm/applications', 'system'],
];

const SCAN_MARKER = '@@stvqa-app@@';

const ICON_SCAN_MARKER = '@@stvqa-icons@@';

const IMAGE_NAME = /\.(png|jpe?g|webp|gif)$/i;

const SOURCE_ORDER: Record<PackageSource, number> = {developer: 0, store: 1, system: 2};

function sourceForFolder(folderPath: string): PackageSource {
    for (const [root, source] of APP_ROOTS) {
        if (folderPath.startsWith(`${root}/`)) return source;
    }
    return 'system';
}

function comparePackages(a: PackageInfo, b: PackageInfo): number {
    const rank = SOURCE_ORDER[a.source ?? 'system'] - SOURCE_ORDER[b.source ?? 'system'];
    if (rank !== 0) return rank;
    // Most of the system entries are hidden stubs — keep the ones the TV actually shows on top.
    const hidden = Number(a.visible === false) - Number(b.visible === false);
    if (hidden !== 0) return hidden;
    return (a.title || a.id).localeCompare(b.title || b.id);
}

@Injectable({
    providedIn: 'root'
})
export class AppManagerService {

    private packagesSubjects: Map<string, Subject<PackageInfo[] | null>>;
    private allPackagesSubjects: Map<string, Subject<PackageInfo[] | null>>;

    constructor(private luna: RemoteLunaService, private cmd: RemoteCommandService, private file: RemoteFileService,
                private localFile: LocalFileService, private deviceManager: DeviceManagerService,
                private lgRemote: LgRemoteService, private iconCache: IconCacheService) {
        this.packagesSubjects = new Map();
        this.allPackagesSubjects = new Map();
    }

    packages$(device: Device): Observable<PackageInfo[] | null> {
        return this.obtainSubject(device);
    }

    /**
     * Every app on the TV — developer, LG Content Store and preloaded system apps.
     */
    allPackages$(device: Device): Observable<PackageInfo[] | null> {
        return this.obtainSubject(device, true);
    }

    async load(device: Device): Promise<PackageInfo[]> {
        const subject = this.obtainSubject(device);
        return this.list(device)
            .then(pkgs => {
                subject.next(pkgs);
                return pkgs;
            })
            .catch((error: any) => {
                subject.error(error);
                this.packagesSubjects.delete(device.name);
                return [];
            });
    }

    async loadAll(device: Device): Promise<PackageInfo[]> {
        const subject = this.obtainSubject(device, true);
        return this.listAll(device)
            .then(pkgs => {
                subject.next(pkgs);
                return pkgs;
            })
            .catch((error: any) => {
                subject.error(error);
                this.allPackagesSubjects.delete(device.name);
                return [];
            });
    }

    /**
     * Reloads the developer list, plus the full list when it has been requested at least once.
     */
    async refresh(device: Device): Promise<void> {
        await this.load(device);
        if (this.allPackagesSubjects.has(device.name)) {
            await this.loadAll(device);
        }
    }

    async list(device: Device): Promise<PackageInfo[]> {
        return this.luna.call(device, 'luna://com.webos.applicationManager/dev/listApps')
            .catch((e) => {
                if (e instanceof LunaUnknownMethodError) {
                    return this.luna.call(device, 'luna://com.webos.applicationManager/listApps', undefined, false);
                }
                throw e;
            })
            .then(resp => resp['apps'] as RawPackageInfo[])
            .then((result) => result.map(info => this.toPackageInfo(info, 'developer')));
    }

    /**
     * Lists every app installed on the TV, not only the ones sideloaded in dev mode.
     *
     * The full list comes from SSAP (`ssap://com.webos.applicationManager/listApps` on the remote
     * socket) — the same call the TV's own launcher makes, so it returns system and Content Store
     * apps too. `dev/listApps` over SSH is scoped to /media/developer, and the unrestricted Luna
     * `listApps` is root-only. If SSAP is unreachable (TV not paired, port closed) we fall back to
     * reading the `appinfo.json` of every app folder over SSH.
     */
    async listAll(device: Device): Promise<PackageInfo[]> {
        const errors: any[] = [];
        const [developer, ssapApps] = await Promise.all([
            this.list(device).catch((e) => {
                console.warn('listAll: dev/listApps failed', e);
                errors.push(e);
                return [] as PackageInfo[];
            }),
            this.lgRemote.listApps(device).catch((e) => {
                console.warn('listAll: SSAP listApps failed, falling back to folder scan', e);
                errors.push(e);
                return [] as SsapApp[];
            }),
        ]);
        let everything = ssapApps.map(app => this.fromSsapApp(app));
        if (!everything.length) {
            everything = await this.scanAppFolders(device, errors);
        }
        const byId = new Map<string, PackageInfo>();
        for (const pkg of everything) {
            byId.set(pkg.id, pkg);
        }
        for (const pkg of developer) {
            // The full list knows where the app actually lives, so its source wins — `list()` can
            // fall back to the unrestricted listApps on rooted TVs, which also reports store apps.
            const known = byId.get(pkg.id);
            byId.set(pkg.id, {...known, ...pkg, source: known?.source ?? 'developer'});
        }
        if (byId.size === 0 && errors.length) {
            throw errors[0];
        }
        return Array.from(byId.values()).sort(comparePackages);
    }

    async info(device: Device, id: string): Promise<PackageInfo | null> {
        return firstValueFrom(this.obtainSubject(device))
            .then(l => l ?? this.load(device))
            .then(l => l.find(p => p.id === id) ?? null);
    }

    async installByPath(device: Device, localPath: string, progress?: InstallProgressHandler): Promise<IconStampResult> {
        const hasHbChannel = await this.deviceManager.getHbChannelConfig(device).then(() => true)
            .catch(() => false);
        if (hasHbChannel) {
            const sha256 = await this.localFile.checksum(localPath, 'sha256');
            const serve: ServeInstance = await this.file.serveLocal(device, localPath);
            console.log('Installing', serve.host);
            try {
                await this.hbChannelInstall(device, new URL(serve.host).toString(), sha256, progress);
            } finally {
                await serve.interrupt();
            }
        } else {
            const ipkPath = await this.tempDownloadIpk(device, localPath, progress);
            try {
                await this.devInstall(device, ipkPath, progress);
            } finally {
                await this.file.rm(device, ipkPath, false);
            }
        }
        const icons = await this.applyEnvironmentIcons(device, progress);
        this.refresh(device).catch(noop);
        return icons;
    }

    async installByManifest(device: Device, manifest: PackageManifest, progress?: InstallProgressHandler): Promise<void> {
        const hasHbChannel = await this.deviceManager.getHbChannelConfig(device).then(() => true)
            .catch(() => false);
        if (hasHbChannel) {
            try {
                await this.hbChannelInstall(device, manifest.ipkUrl, manifest.ipkHash?.sha256, progress);
                await this.applyEnvironmentIcons(device, progress);
                await this.refresh(device).catch(noop);
                return;
            } catch (e) {
                // Never attempt to do default install, if we are reinstalling hbchannel
                if (e instanceof InstallError || manifest.id === APP_ID_HBCHANNEL) {
                    throw e;
                }
            }
        }
        const path = await this.tempDownloadIpk(device, new URL(manifest.ipkUrl), progress);
        await this.devInstall(device, path, progress)
            .then(() => this.applyEnvironmentIcons(device, progress))
            .then(() => this.refresh(device).catch(noop))
            .finally(() => this.file.rm(device, path, false));
    }

    /**
     * Puts the badged environment icon on every sideloaded FreeTV build that has one.
     *
     * Every FreeTV build ships the same green icon, so a TV holding PreProd and UAT side by side
     * shows two identical tiles on the home screen. QA used to fix that by hand through Apps →
     * Change icon after every install — and it *is* every install, because installing the IPK puts
     * the packaged icon back.
     *
     * It walks the whole developer list rather than just the app that was installed, because
     * neither install path reliably says which app that was: appinstalld's `packageId` is not
     * guaranteed, and reinstalling the same version is invisible to a before/after diff. Walking
     * the list also repairs an app whose earlier stamp failed. The one thing it does not respect is
     * an icon set by hand through Change icon on an app we ship a badge for.
     *
     * Best-effort by design: a write that fails leaves whatever the IPK came with rather than
     * failing an install that already succeeded.
     */
    async applyEnvironmentIcons(device: Device, progress?: InstallProgressHandler): Promise<IconStampResult> {
        const result: IconStampResult = {stamped: [], problems: []};
        const bundled = new Map<string, Uint8Array>();
        try {
            // `list`, not `load`: pushing the app list now would race the icon cache we clear below.
            const packages = await this.list(device);
            installLog(`Looking for environment icons among ${packages.map(p => p.id).join(', ') || '(no apps)'}`);
            for (const pkg of packages) {
                const icon = environmentIcon('webos', pkg.id, pkg.title);
                if (!icon) {
                    // A FreeTV build we can't place is worth saying out loud. Anything else is
                    // simply not ours to touch.
                    if (isPriorityApp(pkg.id, pkg.title)) {
                        result.problems.push(`${pkg.id}: no bundled icon for environment "${appEnvironment(pkg.id, pkg.title) ?? 'unknown'}"`);
                    }
                    continue;
                }
                // Only what dev mode owns — store and system apps live on read-only partitions.
                const targets = (await this.findIconPaths(device, pkg))
                    .filter(path => path.startsWith('/media/developer/'));
                if (!targets.length) {
                    result.problems.push(`${pkg.id}: found no icon file in ${pkg.folderPath} (it reports icon="${pkg.icon}", largeIcon="${pkg.largeIcon}")`);
                    continue;
                }
                installLog(`${pkg.id}: icon files ${targets.join(', ')}`);
                let content = bundled.get(icon.asset);
                if (!content) {
                    content = await readBundledIcon(icon.asset);
                    // Truncate-then-write: a bad payload here would leave the app with no icon.
                    if (!isPng(content)) {
                        throw new Error(`${icon.asset} is not a PNG (${content.length} bytes)`);
                    }
                    bundled.set(icon.asset, content);
                }
                progress?.(undefined, `Applying the ${icon.environment} icon...`);
                try {
                    for (const path of targets) {
                        await this.replaceIcon(device, path, content);
                    }
                } catch (e) {
                    result.problems.push(`${pkg.id}: ${e instanceof Error ? e.message : String(e)}`);
                    continue;
                }
                // The list only re-reads icons it has no copy of.
                this.iconCache.delete(pkg.id);
                result.stamped.push(`${pkg.id} → ${icon.environment}`);
            }
            installLog(result.stamped.length
                ? `Stamped environment icons: ${result.stamped.join('; ')}`
                : result.problems.length
                    ? `Stamped nothing, ${result.problems.length} app(s) in the way`
                    : 'No installed app matches a bundled environment icon');
            result.problems.forEach(problem => installLog(problem));
        } catch (e) {
            installLog('Could not stamp the environment icons', e);
            result.problems.push(e instanceof Error ? e.message : String(e));
        }
        return result;
    }

    /**
     * Overwrites one icon file, and puts the old one back if the new one did not land.
     *
     * The old file is unlinked rather than overwritten in place, which is the only way `prisoner`
     * gets to replace a root-owned icon. That makes a failed write destructive, so the original is
     * read first and put back when the new one does not land. Two extra round trips on an
     * operation that just spent seconds installing an IPK.
     */
    private async replaceIcon(device: Device, path: string, content: Uint8Array): Promise<void> {
        const original = await this.file.read(device, path, undefined, 'buffer').catch(() => null);
        // appinstalld unpacks the IPK as root, so the icon it leaves behind cannot be opened for
        // writing by `prisoner` — SFTP answers "permission denied". Unlinking it and creating a
        // fresh one is what dev mode does have rights for, and what Change icon has always done.
        await this.file.rm(device, path, false).catch(() => undefined);
        try {
            await this.file.write(device, path, content);
        } catch (e) {
            if (original?.length) {
                await this.file.write(device, path, new Uint8Array(original)).catch(noop);
            }
            throw e;
        }
        const written = await this.file.read(device, path, undefined, 'buffer').catch(() => null);
        if (written?.length === content.length && written.every((byte, i) => byte === content[i])) {
            return;
        }
        const landed = `wrote ${content.length} bytes, read back ${written?.length ?? 'nothing'}`;
        if (original?.length) {
            await this.file.write(device, path, new Uint8Array(original))
                .then(() => installLog(`${path}: ${landed} — put the old icon back`))
                .catch(e => installLog(`${path}: ${landed}, and restoring it failed`, e));
        }
        throw new Error(`Icon ${path} did not survive the write: ${landed}`);
    }

    /**
     * Where an app's icon files actually are, asked of the TV rather than guessed.
     *
     * `icon` arrives in three shapes depending on who reported the app — a bare file name, an
     * absolute path, or an https URL on the TV's own port 3001 — and `dev/listApps` is happy to
     * report a name that is not what is on disk. Guessing `<folder>/icon.png` when it is unusable
     * is how an app ends up with no icon in the list and a stamp written to a file nothing reads.
     *
     * So this reads the app's own `appinfo.json` and lists its folder in one command, and returns
     * only paths that are really there, best first.
     */
    async findIconPaths(device: Device, pkg: PackageInfo): Promise<string[]> {
        const folder = pkg.folderPath?.replace(/\/+$/, '');
        if (!folder) return [];
        const quoted = `'${folder.replace(/'/g, `'\\''`)}'`;
        const output = await this.cmd.exec(device,
            `cat ${quoted}/appinfo.json 2>/dev/null; echo; echo '${ICON_SCAN_MARKER}'; ls -1 ${quoted} 2>/dev/null; true`,
            'utf-8').catch((e) => {
            installLog(`${pkg.id}: could not inspect ${folder}`, e);
            return '';
        });

        const [rawInfo = '', rawList = ''] = output.split(ICON_SCAN_MARKER);
        let declared: RawPackageInfo | undefined;
        try {
            declared = JSON.parse(rawInfo.trim());
        } catch {
            // An app without a readable appinfo.json still has its folder listing.
        }
        const present = new Set(rawList.split('\n').map(name => name.trim()).filter(Boolean));

        const named = [declared?.icon, declared?.largeIcon, pkg.icon, pkg.largeIcon]
            .filter((v): v is string => !!v && !/^https?:\/\//i.test(v))
            .map(v => v.replace(/^\.\//, ''));
        // Whatever the folder holds, icon-looking names first, as a last resort.
        const scanned = [...present]
            .filter(name => IMAGE_NAME.test(name))
            .sort((a, b) => Number(/icon/i.test(b)) - Number(/icon/i.test(a)));

        const paths = [...named, ...scanned].map(name =>
            name.startsWith('/') ? name : `${folder}/${name}`);
        return [...new Set(paths)].filter(path =>
            // A name from appinfo.json is only real if the listing agrees, unless it points
            // somewhere else entirely, which we cannot check from here.
            !path.startsWith(`${folder}/`) || present.has(path.slice(folder.length + 1)));
    }

    async remove(device: Device, id: string): Promise<void> {
        const luna = await this.luna.subscribe(device, 'luna://com.webos.appInstallService/dev/remove', {
            id, subscribe: true,
        });
        await lastValueFrom(luna.asObservable().pipe(
            map(v => mapAppinstalldResponse(v, /removed/i)),
            filter(v => v)/* Only pick finish event */,
            mergeMap(() => luna.unsubscribe()) /* Unsubscribe when done */,
            catchError((e) => fromPromise(luna.unsubscribe().then(() => {
                throw e;
            })))/* Unsubscribe when failed, and throw the error */)
        );
        await this.refresh(device);
    }

    async launch(device: Device, appId: string, params?: Record<string, any>): Promise<void> {
        await this.luna.call(device, 'luna://com.webos.applicationManager/launch', {
            id: appId, subscribe: false, params
        }, true);
    }

    async close(device: Device, appId: string): Promise<void> {
        await this.luna.call(device, 'luna://com.webos.applicationManager/dev/closeByAppId', {id: appId}, true)
            .catch(e => {
                if (e instanceof LunaUnknownMethodError) {
                    return this.luna.call(device, 'luna://com.webos.service.applicationManager/closeByAppId', {id: appId}, true);
                }
                throw e;
            });
    }

    async checkIncompatibility(device: Device, item: RepositoryItem): Promise<IncompatibleReason[] | null> {
        return Promise.all([
            this.deviceManager.getDeviceInfo(device).catch(() => undefined),
            this.deviceManager.getHbChannelConfig(device).catch((e): Partial<HomebrewChannelConfiguration> | undefined => {
                if (e instanceof LunaServiceNotFoundError) {
                    return {root: false};
                }
                return undefined;
            })
        ]).then(([info, hbConfig]) => item.checkIncompatibility(info, hbConfig));
    }

    async findInstallLocation(device: Device, id: string): Promise<'developer' | 'cryptofs' | 'system' | null> {
        if (device.username === 'root') {
            type AppInfo = { appInfo: { folderPath: string; systemApp?: boolean; } };
            return this.luna.call<AppInfo>(device, 'luna://com.webos.service.applicationManager/getAppInfo',
                {id}, false, true).then(info => {
                if (info.appInfo.systemApp) {
                    return 'system';
                } else if (info.appInfo.folderPath.startsWith('/media/developer/')) {
                    return 'developer';
                } else {
                    return 'cryptofs';
                }
            }).catch(() => null);
        } else {
            const appInfo = await this.info(device, id);
            // App can be found in developer mode partition
            if (appInfo) {
                return 'developer';
            }
            // App exists, so it must be in cryptofs
            type AppLoadStatus = { exist: boolean };
            const status = await this.luna.call<AppLoadStatus>(device,
                'luna://com.webos.service.applicationManager/getAppLoadStatus', {appId: id}, true, true)
                .catch(async (e): Promise<AppLoadStatus> => {
                    if (e instanceof LunaUnknownMethodError) {
                        // We have no way but to try launching the app
                        return this.launch(device, id).then(() => ({exist: true}))
                            .catch(() => ({exist: false}));
                    }
                    return ({exist: false});
                });
            if (status.exist) {
                return 'cryptofs';
            }
            return null;
        }
    }

    private obtainSubject(device: Device, all: boolean = false): Subject<PackageInfo[] | null> {
        const subjects = all ? this.allPackagesSubjects : this.packagesSubjects;
        let subject = subjects.get(device.name);
        if (!subject) {
            subject = new BehaviorSubject<PackageInfo[] | null>(null);
            subjects.set(device.name, subject);
        }
        return subject;
    }

    /**
     * Icons are not addressed by URL: the `remote-file://` scheme puts the device name in the URL
     * authority, and most device names ("Home - 2024") don't survive that. The list view reads the
     * icon files over SFTP instead.
     */
    private toPackageInfo(info: RawPackageInfo, source: PackageSource): PackageInfo {
        return {...info, source};
    }

    private fromSsapApp(app: SsapApp): PackageInfo {
        const folderPath = app.folderPath ?? '';
        // `icon` is an https URL on the TV's own port 3001, served with a self-signed certificate
        // the webview refuses; `largeIcon` keeps the plain file name we can read back over SFTP.
        const localIcon = [app.largeIcon, app.icon].find(v => !!v && !/^https?:\/\//i.test(v)) ?? '';
        return {
            id: app.id,
            title: app.title || app.id,
            type: app.type ?? '',
            vendor: app.vendor ?? '',
            version: app.version ?? '',
            icon: localIcon,
            folderPath,
            source: sourceForFolder(folderPath),
            visible: app.visible,
        };
    }

    /**
     * Reads the `appinfo.json` of every app folder on the TV. A folder that can't be listed (for
     * example /media/cryptofs on a locked-down build) is skipped, with its error pushed to `errors`.
     */
    private async scanAppFolders(device: Device, errors: any[]): Promise<PackageInfo[]> {
        const results: PackageInfo[] = [];
        for (const [root, source] of APP_ROOTS) {
            const command = `for d in ${root}/*/; do if [ -f "$d/appinfo.json" ]; then echo "${SCAN_MARKER}$d"; cat "$d/appinfo.json"; echo ""; fi; done; true`;
            const output = await this.cmd.exec(device, command, 'utf-8').catch((e) => {
                console.warn(`listAll: failed to scan ${root}`, e);
                errors.push(e);
                return '';
            });
            for (const chunk of output.split(SCAN_MARKER).slice(1)) {
                const breakAt = chunk.indexOf('\n');
                if (breakAt < 0) continue;
                const folderPath = chunk.substring(0, breakAt).trim().replace(/\/+$/, '');
                let info: RawPackageInfo;
                try {
                    info = JSON.parse(chunk.substring(breakAt + 1));
                } catch (e) {
                    console.warn(`listAll: unreadable appinfo.json in ${folderPath}`, e);
                    continue;
                }
                if (!info?.id) continue;
                // The folder we found it in wins: appinfo.json rarely carries folderPath, and when
                // it does it's the path from the build machine.
                results.push(this.toPackageInfo({...info, folderPath}, source));
            }
        }
        return results;
    }

    private async tempDownloadIpk(device: Device, location: string | URL, progress?: InstallProgressHandler): Promise<string> {
        // Stage in the developer home, not /tmp: newer webOS builds ship /tmp as
        // d--x--x--x root:root, so the `prisoner` user cannot create files there.
        const targetPath = `/media/developer/temp/devman_dl_${Date.now()}.ipk`
        let localPath: string;
        let deleteLocal = false;
        switch (typeof location) {
            case 'string': {
                localPath = location;
                break;
            }
            default: {
                localPath = await this.localFile.tempPath('.ipk');
                deleteLocal = true;
                progress?.(undefined, 'Downloading IPK to computer...');
                let downloaded: number = 0;
                await download(location.toString(), localPath, prog => {
                    downloaded += prog.progress;
                    progress?.(prog.total ? (100 * downloaded / prog.total) : undefined, 'Downloading IPK to computer...');
                });
                break;
            }
        }
        progress?.(undefined, 'Sending IPK to device...');
        await this.file.put(device, targetPath, localPath, (copied, total) => {
            progress?.(total ? copied / total * 100 : undefined, 'Sending IPK to device...');
        }).finally(() =>
            deleteLocal && this.localFile.remove(localPath).catch(noop));
        return targetPath;
    }

    private async devInstall(device: Device, path: string, progress?: InstallProgressHandler): Promise<void> {
        console.log(`[Install] Starting dev install on ${device.name}: ${path}`);
        const INSTALL_TIMEOUT = 300000; // 5 minutes timeout

        const luna = await this.luna.subscribe(device, 'luna://com.webos.appInstallService/dev/install', {
            id: 'com.ares.defaultName',
            ipkUrl: path,
            subscribe: true,
        });

        try {
            await lastValueFrom(luna.asObservable().pipe(
                map(v => {
                    console.log(`[Install] Response: `, v);
                    return mapAppinstalldResponse(v, /installed/i);
                }),
                timeout(INSTALL_TIMEOUT),
                filter(v => v)/* Only pick finish event */,
                mergeMap(() => luna.unsubscribe()) /* Unsubscribe when done */,
                catchError((e) => fromPromise(luna.unsubscribe().then(() => {
                    throw e;
                })))/* Unsubscribe when failed, and throw the error */)
            );
            console.log(`[Install] Installation completed successfully on ${device.name}`);
        } catch (error) {
            console.error(`[Install] Installation failed on ${device.name}:`, error);
            throw error;
        }
    }

    private async hbChannelInstall(device: Device, url: string, sha256sum?: string, progress?: InstallProgressHandler) {
        console.log(`[Install] Starting Homebrew Channel install on ${device.name}: ${url}`);
        const INSTALL_TIMEOUT = 300000; // 5 minutes timeout

        const luna = await this.luna.subscribe(device, 'luna://org.webosbrew.hbchannel.service/install', {
            ipkUrl: url,
            ipkHash: sha256sum,
            subscribe: true,
        });

        try {
            await lastValueFrom(luna.asObservable().pipe(
                map((v: LunaResponse): boolean => {
                    console.log(`[Install] Progress:`, v['progress'], `Status:`, v['statusText']);
                    if (v.returnValue === false) {
                        // If returnValue is false, then it must be a failure.
                        throw new LunaResponseError(v);
                    } else if (v['finished']) {
                        console.log(`[Install] Installation finished`);
                        return true;
                    } else if (v.subscribed === false && v.returnValue) {
                        // We didn't get any positive result, but there was no error either. Treat it as success.
                        console.log(`[Install] Installation succeeded (no finish event)`);
                        return true;
                    }
                    progress?.(v['progress'], v['statusText']);
                    console.debug('install output', v);
                    return false;
                }),
                timeout(INSTALL_TIMEOUT),
                filter(v => v)/* Only pick finish event */,
                mergeMap(() => luna.unsubscribe()) /* Unsubscribe when done */,
                catchError((e) => fromPromise(luna.unsubscribe().then(() => {
                    const match = e instanceof LunaResponseError && e.details?.match(/(-?\d+): +(\w+)/);
                    if (!match) {
                        throw e;
                    }
                    if (match[2] === 'FAILED_IPKG_INSTALL') {
                        if (match[1] === '-5') {
                            throw InstallError.insufficientSpace(e.details);
                        }
                    }
                    throw e;
                })))/* Unsubscribe when failed, and throw the error */)
            );
            console.log(`[Install] Installation completed successfully on ${device.name}`);
        } catch (error) {
            console.error(`[Install] Installation failed on ${device.name}:`, error);
            throw error;
        }
    }

}

/**
 * Reports an install step to the devtools console *and* to the app's own log.
 *
 * Stamping an icon is best-effort and swallows its own failures, which makes it invisible unless
 * someone happens to have devtools open on a dev build. Everything it decides goes to the Tauri
 * log too, where `npm run start` prints it and a packaged build keeps it in the log file.
 */
function installLog(message: string, error?: unknown): void {
    if (error === undefined) {
        console.log(`[Install] ${message}`);
        logInfo(`[Install] ${message}`).catch(noop);
        return;
    }
    console.warn(`[Install] ${message}`, error);
    logWarn(`[Install] ${message}: ${error instanceof Error ? error.message : String(error)}`).catch(noop);
}

/** The 8-byte PNG signature — every bundled icon is a PNG. */
function isPng(content: Uint8Array): boolean {
    const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    return content.length > signature.length && signature.every((byte, i) => content[i] === byte);
}

function mapAppinstalldResponse(v: LunaResponse, expectResult: string | RegExp): boolean {
    const resultValue: string = _.get(v, ['details', 'state']) || '';
    if (resultValue.match(/FAILED/i)) {
        let details = v['details'];
        if (details && details.reason) {
            if (details.reason === 'FAILED_IPKG_INSTALL') {
                if (details.errorCode === -5) {
                    throw InstallError.insufficientSpace(details.reason);
                }
            }
            throw new Error(`${details.errorCode}: ${details.reason}`);
        }
        throw new Error(resultValue);
    } else if (resultValue.match(/^SUCCESS/i) || resultValue.match(expectResult)) {
        return true;
    }
    console.debug('appinstalld output', v);
    return false;
}

/** What `applyEnvironmentIcons` did, so the caller can tell the user rather than only the log. */
export interface IconStampResult {
    /** `"tv.freetv.portal.preprod → PreProd"` for each app that got its icon replaced. */
    stamped: string[];
    /** Why a FreeTV build did not get one, in words a person can act on. */
    problems: string[];
}

export interface InstallProgressHandler {
    (progress?: number, statusText?: string): void;
}

export class InstallError extends Error {
    constructor(message: string, public details: string) {
        super(message);
    }

    static insufficientSpace(details: string): InstallError {
        return new InstallError('Can\'t install because of insufficient space', details);
    }
}
