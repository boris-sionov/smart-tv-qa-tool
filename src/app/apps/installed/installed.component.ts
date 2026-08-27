import {Component, Host, Input, NgZone, OnDestroy} from '@angular/core';
import {AppsComponent, AppsScope} from '../apps.component';
import {Device, PackageInfo, PackageSource} from "../../types";
import {Observable, Subscription} from "rxjs";
import {AppManagerService, AppsRepoService, RepositoryItem} from "../../core/services";
import {RemoteFileService} from "../../core/services/remote-file.service";
import {IconCacheService} from "../../core/services/icon-cache.service";
import {LgHostedAppVersionService} from "../../core/services/lg-hosted-app-version.service";
import {appEnvironment, isKnownApp, isPriorityApp} from "../../shared/known-apps";
import {Buffer} from "buffer";

@Component({
    selector: 'app-installed',
    templateUrl: './installed.component.html',
    styleUrls: ['./installed.component.scss']
})
export class InstalledComponent implements OnDestroy {

    @Input()
    device: Device | null = null;

    installedError?: Error;
    repoPackages?: Record<string, RepositoryItem>;
    htmlVersions = new Map<string, string | null>();
    packages: PackageInfo[] | null = null;
    search = '';
    private scoped: PackageInfo[] | null = null;

    private subscription?: Subscription;
    private installedField?: Observable<PackageInfo[] | null>;

    constructor(
        @Host() public parent: AppsComponent,
        private appsRepo: AppsRepoService,
        private fileService: RemoteFileService,
        public iconCache: IconCacheService,
        private ngZone: NgZone,
        private lgHostedVersion: LgHostedAppVersionService,
        private appManager: AppManagerService,
    ) {}

    @Input()
    set installed$(value: Observable<PackageInfo[] | null> | undefined) {
        this.subscription?.unsubscribe();
        this.subscription = value?.subscribe({
            next: (pkgs) => {
                this.installedError = undefined;
                this.htmlVersions.clear();
                this.packages = pkgs;
                this.applyScope();
                const strings: string[] = pkgs?.map((pkg) => pkg.id) ?? [];
                this.appsRepo.showApps(...strings).then(apps => this.repoPackages = apps);
                // Only the apps that end up on screen — the raw list holds the TV's whole inventory.
                const scoped = this.scoped ?? [];
                void this.loadIcons(scoped);
                scoped.forEach(pkg => this.resolveHtmlVersion(pkg));
            },
            error: (error) => {
                console.log('installed apps', error);
                this.packages = null;
                return this.installedError = error;
            }
        });
        this.installedField = value;
    }

    get installed$(): Observable<PackageInfo[] | null> | undefined {
        return this.installedField;
    }

    get scope(): AppsScope {
        return this.parent.appsScope;
    }

    /**
     * The scope filter runs once per list/scope change rather than per change-detection pass —
     * the template reads `visiblePackages` constantly and this sorts the whole TV inventory.
     */
    private applyScope(): void {
        const packages = this.packages;
        if (!packages) {
            this.scoped = null;
            return;
        }
        this.scoped = this.scope !== 'apps' ? packages
            // Sideloaded builds are the ones under test, so they stay in whatever they are named.
            : packages.filter(pkg => this.isDeveloperApp(pkg) || isKnownApp(pkg.id, pkg.title))
                .sort((a, b) => this.appsScopeRank(b) - this.appsScopeRank(a)
                    || (a.title || a.id).localeCompare(b.title || b.id));
    }

    /** Apps left after the scope filter and the search box. */
    get visiblePackages(): PackageInfo[] | null {
        const scoped = this.scoped;
        if (!scoped) return null;
        const needle = this.search.trim().toLowerCase();
        if (!needle) return scoped;
        return scoped.filter(pkg =>
            pkg.id.toLowerCase().includes(needle) || (pkg.title ?? '').toLowerCase().includes(needle));
    }

    ngOnDestroy(): void {
        this.subscription?.unsubscribe();
    }

    loadPackages(): void {
        this.installedError = undefined;
        this.parent.loadPackages();
    }

    setScope(scope: AppsScope): void {
        this.search = '';
        this.parent.setAppsScope(scope);
    }

    /** Sideloaded builds first, then FreeTV, then the rest of the tracked brands. */
    private appsScopeRank(pkg: PackageInfo): number {
        if (this.isDeveloperApp(pkg)) return 2;
        return isPriorityApp(pkg.id, pkg.title) ? 1 : 0;
    }

    /** Only apps sideloaded in dev mode can be uninstalled or debugged from here. */
    isDeveloperApp(pkg: PackageInfo): boolean {
        return (pkg.source ?? 'developer') === 'developer';
    }

    /** Which build this is — PreProd / UAT / Staging… — falling back to where it is installed. */
    badgeLabel(pkg: PackageInfo): string {
        return appEnvironment(pkg.id, pkg.title) ?? this.sourceLabel(pkg.source);
    }

    badgeClass(pkg: PackageInfo): string {
        return appEnvironment(pkg.id, pkg.title) ? 'env' : (pkg.source ?? 'developer');
    }

    sourceLabel(source: PackageSource | undefined): string {
        switch (source) {
            case 'store':
                return 'Store';
            case 'system':
                return 'System';
            default:
                return 'Dev';
        }
    }

    forceReloadIcon(pkgId: string): void {
        this.iconCache.delete(pkgId);
        const pkg = this.packages?.find(p => p.id === pkgId);
        if (pkg && this.parent.device) {
            void this.loadIconOnce(pkg);
        }
    }

    private resolveHtmlVersion(pkg: PackageInfo): void {
        const device = this.device ?? this.parent.device;
        if (!device) return;
        const sync = this.lgHostedVersion.getVersionSync(device, pkg);
        if (sync !== undefined) {
            this.htmlVersions.set(pkg.id, sync);
            return;
        }
        if (this.htmlVersions.has(pkg.id)) return;
        this.lgHostedVersion.getVersion(device, pkg).then(version => {
            this.ngZone.run(() => this.htmlVersions.set(pkg.id, version));
        });
    }

    /**
     * Where the icon file may live. `icon` comes back in three different shapes depending on who
     * reported the app — a bare file name, an absolute path, or an https URL on the TV itself —
     * and webOS apps consistently ship an `icon.png` in the app folder as a last resort.
     */
    private iconCandidates(pkg: PackageInfo): string[] {
        const candidates: string[] = [];
        const icon = pkg.icon ?? '';
        if (icon && !/^https?:\/\//i.test(icon)) {
            candidates.push(icon.startsWith('/') ? icon : `${pkg.folderPath}/${icon}`);
        }
        if (pkg.folderPath) {
            candidates.push(`${pkg.folderPath}/icon.png`);
        }
        return [...new Set(candidates)];
    }

    /**
     * Fetches every missing icon in one SSH command.
     *
     * Reading them one at a time is an SFTP round trip per row, which is what made opening the
     * list feel slow — a list of twenty apps spent seconds waiting on latency for a few hundred
     * kilobytes. Anything the batch cannot produce falls back to the per-file read.
     */
    private async loadIcons(packages: PackageInfo[]): Promise<void> {
        const device = this.parent.device;
        if (!device) return;
        const pending = packages.filter(pkg => !this.iconCache.has(pkg.id));
        if (!pending.length) return;

        const candidates = new Map(pending.map(pkg => [pkg.id, this.iconCandidates(pkg)] as const));
        const files = await this.fileService
            .readMany(device, Array.from(candidates.values()).flat())
            .catch((e) => {
                console.warn('installed: batch icon read failed, falling back to per-file reads', e);
                return new Map<string, Buffer>();
            });

        const missed: PackageInfo[] = [];
        for (const pkg of pending) {
            const path = candidates.get(pkg.id)?.find(candidate => files.get(candidate)?.length);
            const buffer = path && files.get(path);
            if (!path || !buffer) {
                missed.push(pkg);
                continue;
            }
            await this.storeIcon(pkg.id, path, buffer);
        }
        await Promise.all(missed.map(pkg => this.loadIconOnce(pkg)));
    }

    /**
     * Asks the TV where the icon really is, for an app the guesses could not place.
     *
     * `iconCandidates` works off what the app list reported, which is a bare name, an absolute
     * path, or an https URL we cannot read — and then guesses `icon.png`. When that comes up
     * empty the app's own `appinfo.json` and folder listing have the answer, at the cost of one
     * command per app that needs it.
     */
    private async loadIconFromFolder(pkg: PackageInfo): Promise<void> {
        const device = this.parent.device;
        if (!device || this.iconCache.has(pkg.id)) return;
        const paths = await this.appManager.findIconPaths(device, pkg)
            .then(found => found.candidates).catch(() => [] as string[]);
        for (const path of paths) {
            const buffer = await this.fileService.read(device, path, undefined, 'buffer')
                .catch(() => null);
            if (!buffer?.length) continue;
            await this.storeIcon(pkg.id, path, buffer);
            return;
        }
        console.warn(`installed: no readable icon for ${pkg.id} in ${pkg.folderPath}`, paths);
    }

    private async loadIconOnce(pkg: PackageInfo): Promise<void> {
        if (this.iconCache.has(pkg.id)) return;
        const device = this.parent.device;
        if (!device) return;

        for (const path of this.iconCandidates(pkg)) {
            const buffer = await this.fileService.read(device, path, undefined, 'buffer')
                .catch(() => null);
            if (!buffer?.length) continue;
            await this.storeIcon(pkg.id, path, buffer);
            return;
        }
        await this.loadIconFromFolder(pkg);
    }

    private async storeIcon(pkgId: string, path: string, buffer: Buffer): Promise<void> {
        const type = /\.jpe?g$/i.test(path) ? 'image/jpeg'
            : /\.gif$/i.test(path) ? 'image/gif'
                : /\.webp$/i.test(path) ? 'image/webp' : 'image/png';
        const dataUri = await new Promise<string>((resolve) => {
            const reader = new FileReader();
            reader.onloadend = () => resolve(reader.result as string);
            reader.readAsDataURL(new Blob([buffer], {type}));
        });
        this.ngZone.run(() => this.iconCache.set(pkgId, dataUri));
    }
}
