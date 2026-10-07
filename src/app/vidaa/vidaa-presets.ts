/**
 * The FreeTV builds QA installs on a Hisense TV — app URL plus the badged webOS icon served from
 * this repo's `main`. Same table as AGENTS.md → "Devkit Install — App And Icon URLs"; keep both in
 * step, and do not move the icon files (every install points at them).
 */
export interface VidaaPreset {
    environment: string;
    /** Becomes the TV's app id, `debug-<name>`: letters, digits, spaces and underscores only. */
    name: string;
    url: string;
    iconUrl: string;
}

const ICONS = 'https://raw.githubusercontent.com/boris-sionov/smart-tv-qa-tool/main/src/assets/lg-icons';

export const VIDAA_PRESETS: readonly VidaaPreset[] = [
    {
        environment: 'PreProd',
        name: 'FreeTV PreProd',
        url: 'https://uat-web.freetv.tv/apps/smarttv/preprod/hisense/index.html',
        iconUrl: `${ICONS}/freetv-lg-preprod-icon.png`,
    },
    {
        environment: 'UAT',
        name: 'FreeTV UAT',
        url: 'https://uat-web.freetv.tv/apps/smarttv/web/index.html',
        iconUrl: `${ICONS}/freetv-lg-uat-icon.png`,
    },
    {
        environment: 'Prod',
        name: 'FreeTV Prod',
        url: 'https://web.freetv.tv/apps/smarttv/web/index.html',
        iconUrl: `${ICONS}/freetv-lg-store-icon.png`,
    },
];

/** The preset an installed app came from, matched on URL — names vary between installs. */
export function presetForUrl(url: string): VidaaPreset | undefined {
    const normalized = url.trim().replace(/\/+$/, '');
    return VIDAA_PRESETS.find(p => p.url === normalized);
}

/**
 * Ports the QA tool's DevTools proxy listens on, per upstream origin. Fixed, because the proxied
 * URL is stored in the TV's app entry. Mirrors `KNOWN_PORTS` in `src-tauri/src/plugins/vidaa_devtools.rs`.
 */
export const DEVTOOLS_PORTS: Readonly<Record<string, number>> = {
    'https://uat-web.freetv.tv': 8765,
    'https://web.freetv.tv': 8766,
};

/**
 * For an app installed "with DevTools" (served through this computer's proxy), the FreeTV URL it
 * stands for; otherwise `null`. Recognised by port, since the proxy's LAN address can change.
 */
export function devtoolsUpstream(url: string): {origin: string; url: string; port: number} | null {
    let u: URL;
    try {
        u = new URL(url);
    } catch {
        return null;
    }
    if (u.protocol !== 'http:' || !u.pathname.startsWith('/apps/')) return null;
    const port = Number(u.port);
    const origin = Object.keys(DEVTOOLS_PORTS).find(o => DEVTOOLS_PORTS[o] === port);
    return origin ? {origin, url: origin + u.pathname + u.search, port} : null;
}
