import {Component, OnInit} from '@angular/core';
import {NgbActiveModal, NgbModal} from '@ng-bootstrap/ng-bootstrap';
import {open as showOpenDialog} from '@tauri-apps/plugin-dialog';
import {AdbService, LibraryApk, PlayListing} from '../../core/services/adb.service';
import {AdbStateService} from '../adb-state.service';
import {MessageDialogComponent} from '../../shared/components/message-dialog/message-dialog.component';
import {extractMessage} from '../../core/utils/error.utils';

/** The app whose live Google Play version the list marks. */
const PLAY_PACKAGE = 'tv.freetv.androidtv';

/** The version in a library file name: `tv.freetv.androidtv-1.10.3.apk` → `1.10.3`. */
function versionOf(name: string): string | null {
    return name.match(/(\d+(?:\.\d+)+)(?=[^\d]*\.apk$)/i)?.[1] ?? null;
}

export interface LibraryRow {
    apk: LibraryApk;
    version: string | null;
    /** The version Google Play serves now. */
    onPlayNow: boolean;
}

/**
 * Picks an APK from the shared library — by default the team's on freetv-server — and closes
 * with the chosen {@link LibraryApk}; the caller installs it.
 *
 * The public Play listing says which version is live; that row is marked "On Google Play".
 */
@Component({
    selector: 'app-apk-library',
    templateUrl: './apk-library.component.html',
    styleUrls: ['./apk-library.component.scss'],
})
export class ApkLibraryComponent implements OnInit {

    source = '';
    editingSource = false;
    rows: LibraryRow[] | null = null;
    playNow: PlayListing | null = null;
    loading = false;
    uploading: string | null = null;
    error: string | null = null;
    selected: LibraryApk | null = null;
    constructor(public modal: NgbActiveModal, private modalService: NgbModal,
                private adb: AdbService, private state: AdbStateService) {}

    ngOnInit(): void {
        this.source = this.state.apkLibrary;
        this.load();
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
        this.selected = null;
        const listing = this.adb.playListing(PLAY_PACKAGE).catch(e => {
            console.warn('[APK library] Could not read the Play listing', e);
            return null;
        });
        try {
            const apks = await this.adb.listLibrary(this.source);
            this.playNow = await listing;
            this.setRows(apks);
        } catch (e) {
            this.rows = null;
            this.error = extractMessage(e, 'Could not read the library');
        } finally {
            this.loading = false;
        }
    }

    private setRows(apks: LibraryApk[]): void {
        this.rows = apks
            .map(apk => {
                const version = versionOf(apk.name);
                return {apk, version, onPlayNow: !!version && version === this.playNow?.version};
            })
            // Newest version first: a numeric-aware compare puts 1.10.3 above 1.9.0.
            .sort((a, b) => b.apk.name.localeCompare(a.apk.name, undefined, {numeric: true}));
    }

    get playNowDate(): Date | null {
        return this.playNow?.updated ? new Date(this.playNow.updated * 1000) : null;
    }

    /**
     * Adds an APK from this Mac, named `<package>-<version>.apk` from its own manifest so the
     * library sorts by version and the live one is found, whatever the file was called.
     */
    async addVersion(): Promise<void> {
        const path = await showOpenDialog({filters: [{name: 'APK package', extensions: ['apk']}], multiple: false});
        if (!path) return;
        this.error = null;
        try {
            const manifest = await this.adb.apkManifest(path);
            const name = manifest.versionName
                ? `${manifest.packageId}-${manifest.versionName}.apk`
                : path.split(/[\\/]/).pop()!;
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
            await this.load();
        } catch (e) {
            this.error = extractMessage(e, 'Upload failed');
        } finally {
            this.uploading = null;
        }
    }

    size(apk: LibraryApk): string {
        return apk.size === null ? '' : `${(apk.size / 1024 / 1024).toFixed(1)} MB`;
    }

    install(): void {
        if (this.selected) this.modal.close(this.selected);
    }
}
