import {appEnvironment, isPriorityApp} from './known-apps';

/**
 * The FreeTV icons bundled with the app, keyed by the environment label `appEnvironment` reports.
 *
 * Every sideloaded FreeTV build ships the same green icon, so once two of them are on a TV the
 * home screen gives QA no way to tell PreProd from UAT. These are the badged variants QA used to
 * push by hand through Apps → Change icon.
 *
 * `preprodtest` gets the PROD TEST badge — the only "test" icon we ship — and an environment with
 * no icon of its own (Staging, QA, Debug…) keeps whatever the IPK came with.
 */
const LG_ENVIRONMENT_ICONS: ReadonlyMap<string, string> = new Map([
    ['PreProd', 'assets/lg-icons/freetv-lg-preprod-icon.png'],
    ['PreProd Test', 'assets/lg-icons/freetv-lg-prod-test-icon.png'],
    ['Test', 'assets/lg-icons/freetv-lg-prod-test-icon.png'],
    ['UAT', 'assets/lg-icons/freetv-lg-uat-icon.png'],
    ['Prod on UAT', 'assets/lg-icons/freetv-lg-uat-icon.png'],
    ['Prod', 'assets/lg-icons/freetv-lg-store-icon.png'],
]);

export interface LgEnvironmentIcon {
    /** Environment label, as shown on the app's badge in the list — `UAT`, `PreProd`, … */
    environment: string;
    /** Path of the bundled icon, relative to the web root. */
    asset: string;
}

/**
 * Which bundled icon belongs to an app, read off its id and title, or `null` when we ship none.
 *
 * Only FreeTV builds match: every bundled LG icon is a FreeTV one, so stamping a Netflix or Sting
 * app with one would be worse than leaving it alone.
 */
export function lgEnvironmentIcon(...fields: (string | null | undefined)[]): LgEnvironmentIcon | null {
    if (!isPriorityApp(...fields)) return null;
    const environment = appEnvironment(...fields);
    const asset = environment && LG_ENVIRONMENT_ICONS.get(environment);
    return asset ? {environment: environment!, asset} : null;
}

/** Reads a bundled icon out of the app's own assets. */
export async function readBundledIcon(asset: string): Promise<Uint8Array> {
    const response = await fetch(new URL(asset, document.baseURI));
    if (!response.ok) {
        throw new Error(`Cannot read bundled icon ${asset}: HTTP ${response.status}`);
    }
    return new Uint8Array(await response.arrayBuffer());
}
