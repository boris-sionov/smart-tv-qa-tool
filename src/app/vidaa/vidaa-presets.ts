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

const LAUNCHER_MARK = 'qa-devtools-launcher';

/**
 * The app URL for an install "with DevTools": a tiny `data:` page that, each time the app opens,
 * asks this computer's proxy whether the QA tool is there (≈1.5 s at most). If it answers, the
 * build runs through the proxy with DevTools attached; otherwise it runs straight from FreeTV, as
 * a plain install would — so the app keeps working without the Mac. `location.replace` keeps the
 * launcher out of history, so Back still exits the app.
 */
export function devtoolsLauncher(directUrl: string, lanIp: string, port: number): string {
    const u = new URL(directUrl);
    const proxied = `http://${lanIp}:${port}${u.pathname}${u.search}`;
    const ping = `http://${lanIp}:${port}/__qa/ping`;
    const html = `<!doctype html><meta charset=utf-8><body style="background:#0A0615">` +
        `<script>var D=${JSON.stringify(directUrl)},P=${JSON.stringify(proxied)},done=0;` +
        `function go(u){if(done)return;done=1;location.replace(u)}` +
        `try{var x=new XMLHttpRequest();x.open('GET',${JSON.stringify(ping)}+'?t='+Date.now(),true);x.timeout=1500;` +
        `x.onload=function(){go(x.status==204||x.status==200?P:D)};x.onerror=x.ontimeout=function(){go(D)};x.send()}catch(e){go(D)}` +
        `setTimeout(function(){go(D)},2500)</script><!--${LAUNCHER_MARK} ${directUrl}-->`;
    return 'data:text/html;charset=utf-8,' + encodeURIComponent(html);
}

/** For a launcher install, the FreeTV URL it opens when the Mac is away; otherwise `null`. */
export function launcherTarget(url: string): string | null {
    if (!url.startsWith('data:text/html')) return null;
    let html: string;
    try {
        html = decodeURIComponent(url.slice(url.indexOf(',') + 1));
    } catch {
        return null;
    }
    const m = html.match(new RegExp(`<!--${LAUNCHER_MARK} (\\S+)-->`));
    return m ? m[1] : null;
}
