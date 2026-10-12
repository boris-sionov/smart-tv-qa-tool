import {Component, EventEmitter, Input, OnChanges, Output} from '@angular/core';
import {BuildKind, ConfluenceService, Release, ReleaseFile} from '../../../core/services/confluence.service';
import {extractMessage} from '../../../core/utils/error.utils';

interface BuildRow {
    kind: BuildKind;
    release: Release;
    file: ReleaseFile;
}

/** What {@link ConfluenceBuildsComponent} hands over once a build is downloaded. */
export interface PickedBuild {
    path: string;
    label: string;
    version: string;
    file: string;
}

/**
 * The newest build of each kind on a Confluence release page, each with an Install button.
 * "Newest" is per kind, not the top row: a release does not always carry a build for every TV.
 * Downloads the file and emits its local path; installing is the caller's job.
 *
 * Asks for the Confluence Personal Access Token when none is saved.
 */
@Component({
    selector: 'app-confluence-builds',
    templateUrl: './confluence-builds.component.html',
    styleUrls: ['./confluence-builds.component.scss'],
})
export class ConfluenceBuildsComponent implements OnChanges {

    @Input({required: true}) page!: string;
    @Input({required: true}) kinds!: BuildKind[];
    @Output() picked = new EventEmitter<PickedBuild>();

    rows: BuildRow[] | null = null;
    missing: BuildKind[] = [];
    loading = false;
    error: string | null = null;
    needsToken = false;
    token = '';
    savingToken = false;
    downloading: BuildRow | null = null;

    constructor(private confluence: ConfluenceService) {}

    ngOnChanges(): void {
        this.load();
    }

    async load(refresh = false): Promise<void> {
        this.loading = true;
        this.error = null;
        try {
            this.needsToken = !await this.confluence.tokenSaved();
            if (this.needsToken) return;
            const releases = await this.confluence.pageReleases(this.page, refresh);
            this.rows = [];
            this.missing = [];
            for (const kind of this.kinds) {
                const release = releases.find(r => r.files.some(f => kind.match.test(f.name)));
                const file = release?.files.find(f => kind.match.test(f.name));
                if (release && file) this.rows.push({kind, release, file});
                else this.missing.push(kind);
            }
        } catch (e) {
            this.rows = null;
            this.error = extractMessage(e, 'Could not read Confluence');
            // A refused token is worth replacing right here rather than in a settings page.
            if (/refused the token|No Confluence token/.test(this.error)) this.needsToken = true;
        } finally {
            this.loading = false;
        }
    }

    async saveToken(): Promise<void> {
        this.savingToken = true;
        this.error = null;
        try {
            await this.confluence.saveToken(this.token);
            this.token = '';
            await this.load(true);
        } catch (e) {
            this.error = extractMessage(e, 'Could not save the token');
        } finally {
            this.savingToken = false;
        }
    }

    async forgetToken(): Promise<void> {
        await this.confluence.forgetToken();
        this.rows = null;
        this.needsToken = true;
    }

    /** The release day as `9 Oct 2026` when it is an ISO date, else as the page writes it. */
    day(release: Release): string {
        const date = /^\d{4}-\d{2}-\d{2}$/.test(release.date) ? new Date(`${release.date}T12:00:00`) : null;
        return date && !isNaN(date.getTime())
            ? date.toLocaleDateString('en-GB', {day: 'numeric', month: 'short', year: 'numeric'})
            : release.date;
    }

    async install(row: BuildRow): Promise<void> {
        this.downloading = row;
        this.error = null;
        try {
            const path = await this.confluence.fetch(row.file);
            this.picked.emit({path, label: row.kind.label, version: row.release.version, file: row.file.name});
        } catch (e) {
            this.error = extractMessage(e, `Could not download ${row.file.name}`);
        } finally {
            this.downloading = null;
        }
    }
}
