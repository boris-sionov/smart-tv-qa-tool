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
