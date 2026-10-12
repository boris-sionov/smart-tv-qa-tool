import {Component, OnInit} from '@angular/core';
import {NgbActiveModal} from '@ng-bootstrap/ng-bootstrap';
import {AdbService, LibraryApk} from '../../core/services/adb.service';
import {AdbStateService} from '../adb-state.service';
import {extractMessage} from '../../core/utils/error.utils';

/**
 * Picks an APK from the shared library. Closes with the chosen {@link LibraryApk}; the caller
 * installs it.
 */
@Component({
    selector: 'app-apk-library',
    templateUrl: './apk-library.component.html',
    styleUrls: ['./apk-library.component.scss'],
})
export class ApkLibraryComponent implements OnInit {

    source = '';
    apks: LibraryApk[] | null = null;
    loading = false;
    error: string | null = null;
    selected: LibraryApk | null = null;

    constructor(public modal: NgbActiveModal, private adb: AdbService, private state: AdbStateService) {}

    ngOnInit(): void {
        this.source = this.state.apkLibrary;
        if (this.source) this.load();
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
        this.loading = true;
        this.error = null;
        this.selected = null;
        try {
            const apks = await this.adb.listLibrary(this.source);
            // Newest version first: names carry the version, and a numeric-aware compare puts
            // 1.10.3 above 1.9.0.
            this.apks = apks.sort((a, b) => b.name.localeCompare(a.name, undefined, {numeric: true}));
        } catch (e) {
            this.apks = null;
            this.error = extractMessage(e, 'Could not read the library');
        } finally {
            this.loading = false;
        }
    }

    size(apk: LibraryApk): string {
        return apk.size === null ? '' : `${(apk.size / 1024 / 1024).toFixed(1)} MB`;
    }

    modified(apk: LibraryApk): string {
        if (!apk.modified) return '';
        return /^\d+$/.test(apk.modified)
            ? new Date(Number(apk.modified)).toLocaleString(undefined, {dateStyle: 'medium', timeStyle: 'short'})
            : apk.modified;
    }

    install(): void {
        if (this.selected) this.modal.close(this.selected);
    }
}
