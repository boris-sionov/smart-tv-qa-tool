import {Component, OnInit} from '@angular/core';
import {NgbActiveModal, NgbModal} from '@ng-bootstrap/ng-bootstrap';
import {open as showOpenDialog} from '@tauri-apps/plugin-dialog';
import {AdbService, LibraryApk, PlayListing} from '../../core/services/adb.service';
import {AdbStateService} from '../adb-state.service';
import {MessageDialogComponent} from '../../shared/components/message-dialog/message-dialog.component';
import {extractMessage} from '../../core/utils/error.utils';
import {BuildKind, RELEASE_PAGES} from '../../core/services/confluence.service';
import {PickedBuild} from '../../shared/components/confluence-builds/confluence-builds.component';

export type Tab = 'store' | 'uat' | 'prodDebug';

/** The store app — the only package the freetv-server library holds. */
const STORE_PACKAGE = 'tv.freetv.androidtv';

/**
 * The builds on "Releases Android TV" the dialog offers, told apart by file name. PROD itself is
 * the store tab; Confluence supplies UAT and the PROD debug build. `.aab` bundles are not installable.
 */
const ANDROID_KINDS: Record<'uat' | 'prodDebug', BuildKind[]> = {
    uat: [
        {label: 'UAT', match: /-nodebugTesting-FreeTVUat-.*\.apk$/},
        {label: 'UAT', debug: true, match: /-debug(?:Testing|Developer)-FreeTVUat-.*\.apk$/},
    ],
    prodDebug: [
        {label: 'PROD', debug: true, match: /-debug(?:Testing|Developer)-FreeTVProd-.*\.apk$/},
    ],
};

/**
 * The version out of a library file name, `<package>-<versionName>.apk` — its leading dotted
 * number only: `1.1.50-(26010150)` reads `1.1.50`.
 */
function storeVersion(name: string): string | null {
    if (!name.startsWith(`${STORE_PACKAGE}-`)) return null;
    return name.slice(STORE_PACKAGE.length + 1).match(/^\d+(?:\.\d+)*/)?.[0] ?? null;
}

/** What the dialog closes with: a store build still on the server, or a Confluence build already downloaded. */
export type LibraryPick = {kind: 'store'; apk: LibraryApk; version: string} | {kind: 'confluence'; build: PickedBuild};

export interface LibraryRow {
    apk: LibraryApk;
    version: string;
    added: Date | null;
    /** The version Google Play serves now. */
    onPlayNow: boolean;
}

/**
 * FreeTV builds to install, in three tabs. Store / PROD is every Google-signed store build in the
 * team's library on freetv-server, the live one marked. UAT (debug included) and PROD Debug are
 * the newest builds from the "Releases Android TV" Confluence page. Closes with
 * a {@link LibraryPick}; the caller installs it.
 */
@Component({
    selector: 'app-apk-library',
    templateUrl: './apk-library.component.html',
    styleUrls: ['./apk-library.component.scss'],
})
export class ApkLibraryComponent implements OnInit {

    source = '';
    editingSource = false;
    tab: Tab = 'store';
    readonly androidPage = RELEASE_PAGES.androidTv;
    readonly kinds = ANDROID_KINDS;
    playNow: PlayListing | null = null;
    loading = false;
    uploading: string | null = null;
    error: string | null = null;
    /** Why a server library did not answer, when it is Tailscale rather than the server. */
    tailscale: 'stopped' | 'needs-login' | 'missing' | 'waiting' | null = null;
    /** The library did not answer although Tailscale is up (or it is a folder). */
    unreachable: string | null = null;
    private all: LibraryRow[] = [];

    constructor(public modal: NgbActiveModal, private modalService: NgbModal,
                private adb: AdbService, private state: AdbStateService) {}

    ngOnInit(): void {
        this.source = this.state.apkLibrary;
        this.load();
    }

    get rows(): LibraryRow[] {
        return this.all;
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
        this.tailscale = null;
        this.unreachable = null;
        const listing = this.adb.playListing(STORE_PACKAGE).catch(e => {
            console.warn('[APK library] Could not read the Play listing', e);
            return null;
        });
        try {
            const apks = await this.adb.listLibrary(this.source);
            this.playNow = await listing;
            this.all = apks
                .flatMap(apk => {
                    const version = storeVersion(apk.name);
                    if (!version) return [];
                    return [{apk, version, added: this.dateOf(apk), onPlayNow: version === this.playNow?.version}];
                })
                // Newest version first: a numeric-aware compare puts 1.10.3 above 1.9.0.
                .sort((a, b) => b.version.localeCompare(a.version, undefined, {numeric: true}));
        } catch (e) {
            this.all = [];
            this.unreachable = extractMessage(e, 'Could not read the library');
            if (/^https?:/.test(this.source.trim())) {
                const state = await this.adb.tailscaleState().catch(() => 'running' as const);
                if (state !== 'running') this.tailscale = state;
            }
        } finally {
            this.loading = false;
        }
    }

    /** Runs `tailscale up`, then loads the list. */
    async tailscaleUp(): Promise<void> {
        this.tailscale = 'waiting';
        this.error = null;
        try {
            await this.adb.tailscaleUp();
            await this.load();
        } catch (e) {
            this.tailscale = 'stopped';
            this.error = extractMessage(e, 'tailscale up failed');
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
     * Adds a store APK from this Mac, named `<package>-<version>.apk` from its own manifest so it
     * sorts by version and the live one is found, whatever the file was called.
     */
    async addVersion(): Promise<void> {
        const path = await showOpenDialog({filters: [{name: 'APK package', extensions: ['apk']}], multiple: false});
        if (!path) return;
        this.error = null;
        try {
            const manifest = await this.adb.apkManifest(path);
            if (manifest.packageId !== STORE_PACKAGE) {
                throw new Error(`${manifest.packageId} is not the FreeTV store app (${STORE_PACKAGE}) — `
                    + 'the library holds store builds only; UAT and PROD come from Confluence.');
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
        this.modal.close({kind: 'store', apk: row.apk, version: row.version} satisfies LibraryPick);
    }

    installBuild(build: PickedBuild): void {
        this.modal.close({kind: 'confluence', build} satisfies LibraryPick);
    }
}
