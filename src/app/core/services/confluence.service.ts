import {Injectable} from '@angular/core';
import {invoke} from '@tauri-apps/api/core';

export interface ReleaseFile {
    name: string;
    url: string;
}

/** One row of a Confluence release page. */
export interface Release {
    version: string;
    /** The "Release day" cell as written, e.g. `2026-10-09`. */
    date: string;
    files: ReleaseFile[];
}

/** A kind of build a release page carries, told apart by its file name. */
export interface BuildKind {
    label: string;
    /** A debug build, tagged as one in the list. */
    debug?: boolean;
    match: RegExp;
}

/** The pages on confluence.redge.com (space KRS) the tool installs from. */
export const RELEASE_PAGES = {
    androidTv: 'Releases Android TV',
    smartTv: 'Releases Smart TV',
} as const;

/**
 * Redge's Confluence release pages. The Personal Access Token is kept by the Rust side in the OS
 * keychain; this side can save, check and forget it, never read it.
 */
@Injectable({providedIn: 'root'})
export class ConfluenceService {

    private releases = new Map<string, Promise<Release[]>>();

    tokenSaved(): Promise<boolean> {
        return invoke<boolean>('plugin:adb-manager|confluence_token_saved');
    }

    /** Checks the token with Confluence and keeps it in the keychain; returns the account's name. */
    saveToken(token: string): Promise<string> {
        return invoke<string>('plugin:adb-manager|confluence_save_token', {token});
    }

    forgetToken(): Promise<void> {
        this.releases.clear();
        return invoke<void>('plugin:adb-manager|confluence_forget_token');
    }

    /** Every release row of a page, newest first — read once per page per session unless `refresh`. */
    pageReleases(title: string, refresh = false): Promise<Release[]> {
        if (refresh || !this.releases.has(title)) {
            const request = invoke<Release[]>('plugin:adb-manager|confluence_releases', {title});
            request.catch(() => this.releases.delete(title));
            this.releases.set(title, request);
        }
        return this.releases.get(title)!;
    }

    /** Downloads a release file into the app cache and returns its path. */
    fetch(file: ReleaseFile): Promise<string> {
        return invoke<string>('plugin:adb-manager|confluence_fetch', {url: file.url, name: file.name});
    }
}
