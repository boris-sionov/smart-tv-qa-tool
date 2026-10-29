import {Injectable} from '@angular/core';
import {invoke} from '@tauri-apps/api/core';

/** An Android app in a Firebase project the signed-in account can see. */
export interface FirebaseApp {
    appId: string;
    packageName: string;
    displayName: string;
}

/** One Firebase App Distribution release. */
export interface FirebaseRelease {
    /** `projects/<number>/apps/<appId>/releases/<id>` — what {@link FirebaseService.fetch} takes. */
    name: string;
    version: string;
    build: string;
    /** ISO time the release was uploaded. */
    created: string;
    notes: string;
}

/**
 * Firebase App Distribution, signed in with a Google account through the system browser. The
 * Rust side keeps the refresh token in the OS keychain; this side can sign in, check and sign
 * out, never read it.
 */
@Injectable({providedIn: 'root'})
export class FirebaseService {

    private apps: Promise<FirebaseApp[]> | null = null;
    private releases = new Map<string, Promise<FirebaseRelease[]>>();

    /** The signed-in account's email, or null. */
    account(): Promise<string | null> {
        return invoke<string | null>('plugin:adb-manager|firebase_account');
    }

    /** Opens Google's sign-in page in the browser and resolves with the email once it is done. */
    signIn(): Promise<string> {
        this.clear();
        return invoke<string>('plugin:adb-manager|firebase_sign_in');
    }

    signOut(): Promise<void> {
        this.clear();
        return invoke<void>('plugin:adb-manager|firebase_sign_out');
    }

    /** Android apps across the account's projects — read once per session unless `refresh`. */
    listApps(refresh = false): Promise<FirebaseApp[]> {
        if (refresh || !this.apps) {
            const request = invoke<FirebaseApp[]>('plugin:adb-manager|firebase_apps');
            request.catch(() => this.apps = null);
            this.apps = request;
        }
        return this.apps;
    }

    /** An app's newest releases, newest first — read once per app per session unless `refresh`. */
    listReleases(appId: string, refresh = false): Promise<FirebaseRelease[]> {
        if (refresh || !this.releases.has(appId)) {
            const request = invoke<FirebaseRelease[]>('plugin:adb-manager|firebase_releases', {appId});
            request.catch(() => this.releases.delete(appId));
            this.releases.set(appId, request);
        }
        return this.releases.get(appId)!;
    }

    /** Downloads a release's APK into the app cache and returns its path. */
    fetch(release: FirebaseRelease): Promise<string> {
        return invoke<string>('plugin:adb-manager|firebase_fetch', {releaseName: release.name});
    }

    private clear(): void {
        this.apps = null;
        this.releases.clear();
    }
}
