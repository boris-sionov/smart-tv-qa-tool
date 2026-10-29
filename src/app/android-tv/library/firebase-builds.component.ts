import {Component, EventEmitter, OnInit, Output} from '@angular/core';
import {FirebaseApp, FirebaseRelease, FirebaseService} from '../../core/services/firebase.service';
import {extractMessage} from '../../core/utils/error.utils';

/** What {@link FirebaseBuildsComponent} hands over once a release is downloaded. */
export interface PickedRelease {
    path: string;
    app: FirebaseApp;
    release: FirebaseRelease;
}

/** The last app picked, when the account sees more than one. */
const APP_KEY = 'freetv-android-tv-firebase-app';

/**
 * The newest Firebase App Distribution releases of a FreeTV Android app, each with an Install
 * button. Signs in with Google through the system browser when no sign-in is saved. Downloads
 * the APK and emits its local path; installing is the caller's job.
 */
@Component({
    selector: 'app-firebase-builds',
    templateUrl: './firebase-builds.component.html',
    styleUrls: ['./firebase-builds.component.scss'],
})
export class FirebaseBuildsComponent implements OnInit {

    @Output() picked = new EventEmitter<PickedRelease>();

    account: string | null = null;
    apps: FirebaseApp[] = [];
    app: FirebaseApp | null = null;
    releases: FirebaseRelease[] | null = null;
    loading = false;
    signingIn = false;
    error: string | null = null;
    downloading: FirebaseRelease | null = null;

    constructor(private firebase: FirebaseService) {}

    async ngOnInit(): Promise<void> {
        this.loading = true;
        try {
            this.account = await this.firebase.account();
            if (this.account) await this.load();
        } catch (e) {
            this.error = extractMessage(e, 'Could not check the Firebase sign-in');
        } finally {
            this.loading = false;
        }
    }

    async signIn(): Promise<void> {
        this.signingIn = true;
        this.error = null;
        try {
            this.account = await this.firebase.signIn();
            await this.load();
        } catch (e) {
            // Cancel resolves the wait below; a late answer from the browser is not an error then.
            if (this.signingIn) this.error = extractMessage(e, 'Google sign-in failed');
        } finally {
            this.signingIn = false;
        }
    }

    /** Stops waiting for the browser. The listener in Rust gives up by itself after 3 minutes. */
    cancelSignIn(): void {
        this.signingIn = false;
    }

    async signOut(): Promise<void> {
        await this.firebase.signOut();
        this.account = null;
        this.apps = [];
        this.app = null;
        this.releases = null;
        this.error = null;
    }

    async load(refresh = false): Promise<void> {
        this.loading = true;
        this.error = null;
        try {
            // FreeTV apps first; the account may see other projects' apps too.
            this.apps = [...await this.firebase.listApps(refresh)]
                .sort((a, b) => Number(isFreeTv(b)) - Number(isFreeTv(a)) || a.displayName.localeCompare(b.displayName));
            const saved = localStorage.getItem(APP_KEY);
            const app = this.apps.find(a => a.appId === (this.app?.appId ?? saved)) ?? this.apps[0] ?? null;
            await this.select(app, refresh);
        } catch (e) {
            this.error = extractMessage(e, 'Could not read Firebase');
            if (/sign in again|Not signed in/i.test(this.error)) this.account = await this.firebase.account().catch(() => null);
        } finally {
            this.loading = false;
        }
    }

    async select(app: FirebaseApp | null, refresh = false): Promise<void> {
        this.app = app;
        this.releases = null;
        if (!app) return;
        localStorage.setItem(APP_KEY, app.appId);
        this.loading = true;
        this.error = null;
        try {
            this.releases = await this.firebase.listReleases(app.appId, refresh);
        } catch (e) {
            this.error = extractMessage(e, `Could not read the releases of ${app.displayName}`);
        } finally {
            this.loading = false;
        }
    }

    /** The first line of the release notes. */
    summary(release: FirebaseRelease): string {
        return release.notes.split('\n').find(line => line.trim())?.trim() ?? '';
    }

    async install(release: FirebaseRelease): Promise<void> {
        if (!this.app) return;
        this.downloading = release;
        this.error = null;
        try {
            const path = await this.firebase.fetch(release);
            this.picked.emit({path, app: this.app, release});
        } catch (e) {
            this.error = extractMessage(e, `Could not download ${release.version}`);
        } finally {
            this.downloading = null;
        }
    }
}

function isFreeTv(app: FirebaseApp): boolean {
    return /freetv/i.test(app.packageName);
}
