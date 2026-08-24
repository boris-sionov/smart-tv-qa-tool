import BuildInfoJson from '../../build-info.json';

export interface BuildInfo {
    /** Semver from package.json, e.g. `1.0.0`. */
    readonly version: string;
    /** Monotonic counter, bumped by `scripts/build-info.js --bump` on every new update. */
    readonly build: number;
    readonly commit: string;
    readonly branch: string;
    readonly builtAt: string;
}

export const BUILD_INFO: BuildInfo = BuildInfoJson;

/** Human-readable banner, e.g. `1.0.0 (build 12)`. */
export const APP_VERSION: string = BUILD_INFO.build > 0
    ? `${BUILD_INFO.version} (build ${BUILD_INFO.build})`
    : BUILD_INFO.version;
