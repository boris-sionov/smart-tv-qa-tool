import {Component, OnInit} from '@angular/core';
import {NgbActiveModal, NgbModal} from '@ng-bootstrap/ng-bootstrap';
import {open as showOpenDialog} from '@tauri-apps/plugin-dialog';
import {AdbService, LibraryApk, PlayListing} from '../../core/services/adb.service';
import {AdbStateService} from '../adb-state.service';
import {MessageDialogComponent} from '../../shared/components/message-dialog/message-dialog.component';
import {extractMessage} from '../../core/utils/error.utils';

export type Flavor = 'store' | 'uat';

/** The FreeTV packages each tab holds. The library takes these and nothing else. */
const FLAVORS: Record<Flavor, string[]> = {
    store: ['tv.freetv.androidtv'],
    uat: ['tv.freetv.androidtv.uat', 'tv.freetv.portal.preprod'],
};

/** The app whose live Google Play version the Store tab marks. */
const PLAY_PACKAGE = 'tv.freetv.androidtv';

/** Longest first, so `tv.freetv.androidtv.uat-…` is not read as the store package. */
const PACKAGES = Object.values(FLAVORS).flat().sort((a, b) => b.length - a.length);

function flavorOf(packageId: string): Flavor | null {
    return (Object.keys(FLAVORS) as Flavor[]).find(f => FLAVORS[f].includes(packageId)) ?? null;
}

/**
 * Package and version out of a library file name, `<package>-<versionName>.apk`. The version is
 * its leading dotted number only: `1.1.50-(26010150)` reads `1.1.50`.
 */
function parseName(name: string): {packageId: string; version: string | null} | null {
    const packageId = PACKAGES.find(p => name.startsWith(`${p}-`));
    if (!packageId) return null;
    const version = name.slice(packageId.length + 1).match(/^\d+(?:\.\d+)*/)?.[0] ?? null;
    return {packageId, version};
}

export interface LibraryRow {
    apk: LibraryApk;
    version: string;
    added: Date | null;
    /** The version Google Play serves now. */
    onPlayNow: boolean;
}

/**
 * The FreeTV builds in the shared library — by default the team's on freetv-server — in a Store
 * and a UAT tab. Closes with the {@link LibraryApk} to install; the caller installs it.
 *
 * The public Play listing says which store version is live; that row is marked "On Google Play".
 */
@Component({
    selector: 'app-apk-library',
    templateUrl: './apk-library.component.html',
    styleUrls: ['./apk-library.component.scss'],
})
export class ApkLibraryComponent implements OnInit {

    source = '';
    editingSource = false;
    flavor: Flavor = 'store';
    playNow: PlayListing | null = null;
    loading = false;
    uploading: string | null = null;
    error: string | null = null;
    private all: (LibraryRow & {flavor: Flavor})[] = [];

    constructor(public modal: NgbActiveModal, private modalService: NgbModal,
                private adb: AdbService, private state: AdbStateService) {}

    ngOnInit(): void {
        this.source = this.state.apkLibrary;
        this.load();
    }

    get rows(): LibraryRow[] {
        return this.all.filter(r => r.flavor === this.flavor);
    }

    count(flavor: Flavor): number {
        return this.all.filter(r => r.flavor === flavor).length;
    }

    async browse(): Promise<void> {
        const folder = await this.adb.openLibraryFolderChooser();
        if (!folder) return;
        this.source = folder;
        await this.load();
    }

    async load(): Promise<void> {
        if (!this.source.trim()) return;
        this.state.apkLibrary = this.source;
        this.editingSource = false;
        this.loading = true;
        this.error = null;
        const listing = this.adb.playListing(PLAY_PACKAGE).catch(e => {
            console.warn('[APK library] Could not read the Play listing', e);
            return null;
        });
        try {
            const apks = await this.adb.listLibrary(this.source);
            this.playNow = await listing;
            this.all = apks
                .flatMap(apk => {
                    const parsed = parseName(apk.name);
                    const flavor = parsed && flavorOf(parsed.packageId);
                    if (!parsed?.version || !flavor) return [];
                    return [{
                        apk, flavor,
                        version: parsed.version,
                        added: this.dateOf(apk),
                        onPlayNow: parsed.packageId === PLAY_PACKAGE && parsed.version === this.playNow?.version,
                    }];
                })
                // Newest version first: a numeric-aware compare puts 1.10.3 above 1.9.0.
                .sort((a, b) => b.version.localeCompare(a.version, undefined, {numeric: true}));
        } catch (e) {
            this.all = [];
            this.error = extractMessage(e, 'Could not read the library');
        } finally {
            this.loading = false;
        }
    }

    /** A folder library gives ms since the epoch; a server gives an HTTP date. */
    private dateOf(apk: LibraryApk): Date | null {
        if (!apk.modified) return null;
        const date = /^\d+$/.test(apk.modified) ? new Date(Number(apk.modified)) : new Date(apk.modified);
        return isNaN(date.getTime()) ? null : date;
    }

    get playNowDate(): Date | null {
        return this.playNow?.updated ? new Date(this.playNow.updated * 1000) : null;
    }

    /**
     * Adds a FreeTV APK from this Mac, named `<package>-<version>.apk` from its own manifest so it
     * lands in the right tab and sorts by version, whatever the file was called.
     */
    async addVersion(): Promise<void> {
        const path = await showOpenDialog({filters: [{name: 'APK package', extensions: ['apk']}], multiple: false});
        if (!path) return;
        this.error = null;
        try {
            const manifest = await this.adb.apkManifest(path);
            const flavor = flavorOf(manifest.packageId);
            if (!flavor) {
                throw new Error(`${manifest.packageId} is not a FreeTV Store or UAT build — the library holds only those.`);
            }
            if (!manifest.versionName) throw new Error('The APK does not state its version.');
            const name = `${manifest.packageId}-${manifest.versionName}.apk`;
            this.uploading = name;
            try {
                await this.adb.uploadToLibrary(this.source, path, name, false);
            } catch (e) {
                if (!extractMessage(e, '').includes('already in the library')) throw e;
                const confirm = MessageDialogComponent.open(this.modalService, {
                    title: 'Replace it?',
                    message: `${name} is already in the library. Replace it with the file you picked?\n\n`
                        + 'A store build and a CI build of the same version are different packages — '
                        + 'replace only when you mean to.',
                    positive: 'Replace', positiveStyle: 'danger', negative: 'Cancel', autofocus: 'negative',
                });
                if (!await confirm.result.catch(() => false)) return;
                await this.adb.uploadToLibrary(this.source, path, name, true);
            }
            this.flavor = flavor;
            await this.load();
        } catch (e) {
            this.error = extractMessage(e, 'Could not add the version');
        } finally {
            this.uploading = null;
        }
    }

    size(apk: LibraryApk): string {
        return apk.size === null ? '' : `${(apk.size / 1024 / 1024).toFixed(1)} MB`;
    }

    install(row: LibraryRow): void {
        this.modal.close(row.apk);
    }
}
