import {appEnvironment, isPriorityApp} from './known-apps';

/** The platforms we ship a badged FreeTV icon family for. */
export type IconPlatform = 'webos' | 'android-tv';

interface IconFamily {
    /** Bundled icon per environment label, as `appEnvironment` reports it. */
    environments: ReadonlyMap<string, string>;
    /** What a FreeTV build with no environment marker at all gets, or `null` to leave it alone. */
    unmarked: string | null;
}

/**
 * The badged FreeTV icons bundled with the app, keyed by the environment label `appEnvironment`
 * reports.
 *
 * Every FreeTV build ships the same green icon, so once two of them are around — on a TV's home
 * screen, or in our own app list — there is nothing to tell PreProd from UAT. These are the badged
 * variants QA made for exactly that.
 *
 * `preprodtest` gets the PROD TEST badge, the only "test" icon we ship. An environment with no icon
 * of its own (Staging, QA, Debug…) is left alone.
 */
const FREETV_ICONS: Readonly<Record<IconPlatform, IconFamily>> = {
    'webos': {
        environments: new Map([
            ['PreProd', 'assets/lg-icons/freetv-lg-preprod-icon.png'],
            ['PreProd Test', 'assets/lg-icons/freetv-lg-prod-test-icon.png'],
            ['Test', 'assets/lg-icons/freetv-lg-prod-test-icon.png'],
            ['UAT', 'assets/lg-icons/freetv-lg-uat-icon.png'],
            ['Prod on UAT', 'assets/lg-icons/freetv-lg-uat-icon.png'],
            // webOS ships no PROD badge of its own.
            ['Prod', 'assets/lg-icons/freetv-lg-store-icon.png'],
        ]),
        // Nothing: on webOS the icon is written to the TV, and an unmarked build there is the
        // Content Store one — badging it would be writing a guess onto a real app.
        unmarked: null,
    },
    'android-tv': {
        environments: new Map([
            ['PreProd', 'assets/android-tv-icons/freetv-atv-preprod-icon.png'],
            ['PreProd Test', 'assets/android-tv-icons/freetv-atv-prod-test-icon.png'],
            ['Test', 'assets/android-tv-icons/freetv-atv-prod-test-icon.png'],
            ['UAT', 'assets/android-tv-icons/freetv-atv-uat-icon.png'],
            ['Prod on UAT', 'assets/android-tv-icons/freetv-atv-uat-icon.png'],
            ['Prod', 'assets/android-tv-icons/freetv-atv-prod-icon.png'],
        ]),
        // What QA installs on an Android TV is prod or uat, and only uat carries a marker — so a
        // FreeTV APK with no marker is the prod build, `tv.freetv.androidtv` included.
        unmarked: 'assets/android-tv-icons/freetv-atv-prod-icon.png',
    },
};

export interface EnvironmentIcon {
    /** Environment label, as shown on the app's badge in the list — `UAT`, `PreProd`, … */
    environment: string;
    /** Path of the bundled icon, relative to the web root. */
    asset: string;
}

/**
 * Which bundled icon belongs to an app, read off its id and title, or `null` when we ship none.
 *
 * Only FreeTV builds match: every bundled icon is a FreeTV one, so putting one on a Netflix or
 * Sting app would be worse than leaving it alone.
 */
export function environmentIcon(platform: IconPlatform, ...fields: (string | null | undefined)[]): EnvironmentIcon | null {
    if (!isPriorityApp(...fields)) return null;
    const family = FREETV_ICONS[platform];
    const environment = appEnvironment(...fields);
    if (!environment) {
        return family.unmarked ? {environment: 'Prod', asset: family.unmarked} : null;
    }
    const asset = family.environments.get(environment);
    return asset ? {environment, asset} : null;
}

/** Reads a bundled icon out of the app's own assets. */
export async function readBundledIcon(asset: string): Promise<Uint8Array> {
    const response = await fetch(new URL(asset, document.baseURI));
    if (!response.ok) {
        throw new Error(`Cannot read bundled icon ${asset}: HTTP ${response.status}`);
    }
    return new Uint8Array(await response.arrayBuffer());
}
