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
import {lgEnvironmentIcon, readBundledIcon} from "../../shared/lg-app-icons";

const APP_ROOTS: ReadonlyArray<[string, PackageSource]> = [
    ['/media/developer/apps/usr/palm/applications', 'developer'],
    ['/media/cryptofs/apps/usr/palm/applications', 'store'],
    ['/usr/palm/applications', 'system'],
];

const SCAN_MARKER = '@@stvqa-app@@';

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

    async installByPath(device: Device, localPath: string, progress?: InstallProgressHandler): Promise<void> {
        const hasHbChannel = await this.deviceManager.getHbChannelConfig(device).then(() => true)
            .catch(() => false);
        let installedId: string | null;
        if (hasHbChannel) {
            const before = await this.snapshotDevApps(device);
            const sha256 = await this.localFile.checksum(localPath, 'sha256');
            const serve: ServeInstance = await this.file.serveLocal(device, localPath);
            console.log('Installing', serve.host);
            try {
                await this.hbChannelInstall(device, new URL(serve.host).toString(), sha256, progress);
            } finally {
                await serve.interrupt();
            }
            installedId = await this.detectInstalledApp(device, before);
        } else {
            const ipkPath = await this.tempDownloadIpk(device, localPath, progress);
            try {
                installedId = await this.devInstall(device, ipkPath, progress);
            } finally {
                await this.file.rm(device, ipkPath, false);
            }
        }
        await this.applyEnvironmentIcon(device, installedId, progress);
        this.refresh(device).catch(noop);
    }

    async installByManifest(device: Device, manifest: PackageManifest, progress?: InstallProgressHandler): Promise<void> {
        const hasHbChannel = await this.deviceManager.getHbChannelConfig(device).then(() => true)
            .catch(() => false);
        if (hasHbChannel) {
            try {
                const before = await this.snapshotDevApps(device);
                await this.hbChannelInstall(device, manifest.ipkUrl, manifest.ipkHash?.sha256, progress);
                await this.applyEnvironmentIcon(device, manifest.id || await this.detectInstalledApp(device, before), progress);
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
            .then((installedId) => this.applyEnvironmentIcon(device, installedId || manifest.id, progress))
            .then(() => this.refresh(device).catch(noop))
            .finally(() => this.file.rm(device, path, false));
    }

    /**
     * Replaces a freshly installed app's icon with the bundled one for its environment.
     *
     * Every FreeTV build ships the same green icon, so a TV holding PreProd and UAT side by side
     * shows two identical tiles on the home screen. QA used to fix that by hand through Apps →
     * Change icon after every install — and it *is* every install, because installing the IPK puts
     * the packaged icon back.
     *
     * Best-effort by design: an app we ship no icon for, or a write that fails, keeps whatever the
     * IPK came with rather than failing the install that already succeeded.
     */
    async applyEnvironmentIcon(device: Device, appId: string | null, progress?: InstallProgressHandler): Promise<boolean> {
        if (!appId) return false;
        try {
            // `list`, not `load`: pushing the app list now would race the icon cache we clear below.
            const pkg = (await this.list(device)).find(p => p.id === appId);
            if (!pkg) return false;
            const icon = lgEnvironmentIcon(pkg.id, pkg.title);
            if (!icon) return false;
            // Only what dev mode owns — store and system apps live on read-only partitions.
            const targets = this.environmentIconTargets(pkg)
                .filter(path => path.startsWith('/media/developer/'));
            if (!targets.length) return false;

            progress?.(undefined, `Applying ${icon.environment} icon...`);
            const content = await readBundledIcon(icon.asset);
            for (const path of targets) {
                await this.file.write(device, path, content);
            }
            // The list only re-reads icons it has no copy of.
            this.iconCache.delete(appId);
            console.log(`[Install] Stamped ${icon.environment} icon on ${appId}`);
            return true;
        } catch (e) {
            console.warn(`[Install] Could not stamp the environment icon on ${appId}`, e);
            return false;
        }
    }

    /**
     * Where the icon files of an app live. `icon`/`largeIcon` come back either as a bare file name
     * or as an absolute path, and an app that declares neither still gets the `icon.png` every
     * webOS app folder has.
     */
    private environmentIconTargets(pkg: PackageInfo): string[] {
        const declared = [pkg.icon, pkg.largeIcon]
            .filter((v): v is string => !!v && !/^https?:\/\//i.test(v))
            .map(v => v.startsWith('/') ? v : `${pkg.folderPath}/${v}`);
        const paths = declared.length ? declared : [`${pkg.folderPath}/icon.png`];
        return [...new Set(paths.filter(path => path.startsWith('/')))];
    }

    /** id → version of every dev-installed app, to spot what an install changed. */
    private async snapshotDevApps(device: Device): Promise<Map<string, string>> {
        return this.list(device)
            .then(pkgs => new Map(pkgs.map(pkg => [pkg.id, pkg.version] as const)))
            .catch(() => new Map<string, string>());
    }

    /**
     * Which app an install added or updated, for the Homebrew Channel path — its service, unlike
     * appinstalld, doesn't report the package id. Reinstalling the very same version looks like
     * nothing happened, so this can come back empty.
     */
    private async detectInstalledApp(device: Device, before: Map<string, string>): Promise<string | null> {
        const changed = (await this.list(device).catch(() => [] as PackageInfo[]))
            .filter(pkg => before.get(pkg.id) !== pkg.version);
        return changed.length === 1 ? changed[0].id : null;
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

    /** Returns the id appinstalld reports for the installed app, when it reports one. */
    private async devInstall(device: Device, path: string, progress?: InstallProgressHandler): Promise<string | null> {
        console.log(`[Install] Starting dev install on ${device.name}: ${path}`);
        const INSTALL_TIMEOUT = 300000; // 5 minutes timeout
        let installedId: string | null = null;

        const luna = await this.luna.subscribe(device, 'luna://com.webos.appInstallService/dev/install', {
            id: 'com.ares.defaultName',
            ipkUrl: path,
            subscribe: true,
        });

        try {
            await lastValueFrom(luna.asObservable().pipe(
                map(v => {
                    console.log(`[Install] Response: `, v);
                    installedId = appinstalldPackageId(v) ?? installedId;
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
            return installedId;
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
 * appinstalld names the app it is working on in its progress events. `com.ares.defaultName` is the
 * placeholder id we send in, not an answer.
 */
function appinstalldPackageId(v: LunaResponse): string | null {
    const id: string = _.get(v, ['details', 'packageId']) || _.get(v, ['details', 'id']) || '';
    return id && id !== 'com.ares.defaultName' ? id : null;
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
