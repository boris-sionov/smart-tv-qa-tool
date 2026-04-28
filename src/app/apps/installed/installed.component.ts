import {Component, Host, Input, NgZone, OnDestroy} from '@angular/core';
import {AppsComponent} from '../apps.component';
import {Device, PackageInfo} from "../../types";
import {Observable, Subscription} from "rxjs";
import {AppsRepoService, RepositoryItem} from "../../core/services";
import {RemoteFileService} from "../../core/services/remote-file.service";
import {IconCacheService} from "../../core/services/icon-cache.service";

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

    private subscription?: Subscription;
    private installedField?: Observable<PackageInfo[] | null>;

    constructor(
        @Host() public parent: AppsComponent,
        private appsRepo: AppsRepoService,
        private fileService: RemoteFileService,
        public iconCache: IconCacheService,
        private ngZone: NgZone,
    ) {}

    @Input()
    set installed$(value: Observable<PackageInfo[] | null> | undefined) {
        this.subscription?.unsubscribe();
        this.subscription = value?.subscribe({
            next: (pkgs) => {
                this.installedError = undefined;
                const strings: string[] = pkgs?.map((pkg) => pkg.id) ?? [];
                this.appsRepo.showApps(...strings).then(apps => this.repoPackages = apps);
                pkgs?.forEach(pkg => this.loadIconOnce(pkg));
            },
            error: (error) => {
                console.log('installed apps', error);
                return this.installedError = error;
            }
        });
        this.installedField = value;
    }

    get installed$(): Observable<PackageInfo[] | null> | undefined {
        return this.installedField;
    }

    ngOnDestroy(): void {
        this.subscription?.unsubscribe();
    }

    loadPackages(): void {
        this.installedError = undefined;
        this.parent.loadPackages();
    }

    forceReloadIcon(pkgId: string): void {
        this.iconCache.delete(pkgId);
        const installed = (this.installedField as any)?.getValue?.() as PackageInfo[] | null;
        const pkg = installed?.find(p => p.id === pkgId);
        if (pkg && this.parent.device) {
            this.loadIconOnce(pkg);
        }
    }

    private loadIconOnce(pkg: PackageInfo): void {
        if (this.iconCache.has(pkg.id)) return;
        if (!this.parent.device) return;

        const iconPath = `${pkg.folderPath}/${pkg.icon}`;
        this.fileService.read(this.parent.device, iconPath, undefined, 'buffer')
            .then((buffer: any) => {
                const blob = new Blob([buffer], {type: 'image/png'});
                const reader = new FileReader();
                reader.onloadend = () => {
                    this.ngZone.run(() => {
                        this.iconCache.set(pkg.id, reader.result as string);
                    });
                };
                reader.readAsDataURL(blob);
            })
            .catch(() => {
                // fall back to original URI on error — don't set cache so icon uses fallback
            });
    }
}
