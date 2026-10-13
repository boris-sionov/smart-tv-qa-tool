import BuildInfoJson from '../../build-info.json';

export interface BuildInfo {
    /** Semver from package.json, e.g. `1.0.0`. */
    readonly version: string;
    /** Monotonic counter, bumped by `scripts/build-info.js --bump` on every new update. */
    readonly build: number;
    readonly commit: string;
    readonly branch: string;
    /** Built with uncommitted changes. Absent in files written before the field existed. */
    readonly dirty?: boolean;
    readonly builtAt: string;
}

export const BUILD_INFO: BuildInfo = BuildInfoJson;

/**
 * Human-readable banner, e.g. `1.0.0 (build 12)`.
 *
 * Only CI bumps the build number, on a merge to main, so a test build from a branch carries the
 * number of the last merge although it holds work main does not. Such a build says so:
 * `1.0.0 (build 12+ · feat/foo a1b2c3d)`, with `, modified` when it had uncommitted changes.
 * `HEAD` is a detached checkout, as CI's release build of a tag is, and counts as main.
 */
export const APP_VERSION: string = versionLabel(BUILD_INFO);

export function versionLabel(info: BuildInfo): string {
    const offMain = !!info.branch && info.branch !== 'main' && info.branch !== 'HEAD';
    if (!offMain && !info.dirty) {
        return info.build > 0 ? `${info.version} (build ${info.build})` : info.version;
    }
    const where = [offMain ? info.branch : '', info.commit].filter(Boolean).join(' ');
    return `${info.version} (build ${info.build}+ · ${where}${info.dirty ? ', modified' : ''})`;
}
