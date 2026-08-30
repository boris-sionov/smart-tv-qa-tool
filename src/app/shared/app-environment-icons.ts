import {appEnvironment, isPriorityApp} from './known-apps';

/** The platforms we ship a badged FreeTV icon family for. */
export type IconPlatform = 'webos' | 'android-tv';

interface IconFamily {
    /** Bundled icon per environment label, as `appEnvironment` reports it. */
    environments: ReadonlyMap<string, string>;
    /** The 2.0 rewrite's own icon — different artwork, not just a badge over the 1.x one. */
    version2: string | null;
    /** What a FreeTV build with no environment marker at all gets, or `null` to leave it alone. */
    unmarked: string | null;
}

/**
 * The 2.0 rewrite, which ships under a new id (`com.freetv.smarttv` on webOS and Android TV,
 * `Plusdrie00.FreeTV` on Tizen) and carries no environment marker, so `appEnvironment` sees
 * nothing on it. Its artwork is a different design entirely — dark ground, gradient logo — so it
 * gets its own badged icon rather than a badge over the 1.x one.
 */
const VERSION_2_APP = /^com\.freetv\.smarttv|^Plusdrie00\.FreeTV/i;

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
 *
 * Only the icons drawn in the current style are referenced — logo large in the middle, one wide
 * badge with a white outline below it. `freetv-atv-prod-icon.png` and the two files under
 * `lg-icons/previews/` are the older style, with a small badge tucked into a corner, and are
 * deliberately unused.
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
        version2: 'assets/lg-icons/freetv-lg-2.0-icon.png',
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
            // Not `freetv-atv-prod-icon.png`: that one is from the older style, with a small badge
            // in the corner instead of the centred one every other icon here uses.
            ['Prod', 'assets/android-tv-icons/freetv-atv-store-icon.png'],
        ]),
        version2: 'assets/android-tv-icons/freetv-atv-2.0-icon.png',
        // What QA installs on an Android TV is prod or uat, and only uat carries a marker — so a
        // FreeTV APK with no marker is the prod build, `tv.freetv.androidtv` included.
        unmarked: 'assets/android-tv-icons/freetv-atv-store-icon.png',
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
        // An environment marker still wins when there is one, so a future `…smarttv.uat` reads as
        // UAT rather than losing which environment it is.
        if (family.version2 && fields.some(field => !!field && VERSION_2_APP.test(field))) {
            return {environment: '2.0', asset: family.version2};
        }
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
