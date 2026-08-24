import {Injectable} from '@angular/core';
import {fetch} from '@tauri-apps/plugin-http';
import {Command} from '@tauri-apps/plugin-shell';
import {Device, PackageInfo} from '../../types';
import {RemoteCommandService} from './remote-command.service';
import {RemoteFileService} from './remote-file.service';

/** Printed by the TV when its grep cannot do the extraction, so the caller reads the file instead. */
const GREP_UNSUPPORTED = '@@stvqa-nogrep@@';

@Injectable({
    providedIn: 'root'
})
export class LgHostedAppVersionService {
    private cache = new Map<string, Promise<string | null>>();
    private resolved = new Map<string, string | null>();

    constructor(private fileService: RemoteFileService, private cmd: RemoteCommandService) {}

    getVersionSync(device: Device, pkg: PackageInfo): string | null | undefined {
        return this.resolved.get(`${device.name}:${pkg.id}:${pkg.version}:${pkg.folderPath}`);
    }

    getVersion(device: Device, pkg: PackageInfo): Promise<string | null> {
        const key = `${device.name}:${pkg.id}:${pkg.version}:${pkg.folderPath}`;
        let cached = this.cache.get(key);
        if (!cached) {
            cached = this.resolveVersion(device, pkg).catch(() => null);
            cached.then(v => this.resolved.set(key, v));
            this.cache.set(key, cached);
        }
        return cached;
    }

    clear(): void {
        this.cache.clear();
        this.resolved.clear();
    }

    private async resolveVersion(device: Device, pkg: PackageInfo): Promise<string | null> {
        if (!this.mayBeHostedFreeTvApp(pkg)) return null;

        const localIndex = await this.fileService.read(device, `${pkg.folderPath}/index.html`, undefined, 'utf-8')
            .catch(() => '');

        const localVersion = await this.resolveLocalBundleVersion(device, pkg.folderPath, localIndex);
        if (localVersion) return localVersion;

        const localCandidates = await this.findHostedIndexUrls(localIndex);
        const fallbackCandidates = this.directHostedIndexCandidates(pkg);
        const candidates = [...localCandidates, ...fallbackCandidates];

        for (const hostedIndexUrl of this.unique(candidates)) {
            const version = await this.resolveHostedIndexVersion(hostedIndexUrl);
            if (version) return version;
        }

        const curlVersion = await this.resolveWithCurl(localCandidates[0] ?? fallbackCandidates[0]);
        if (curlVersion) return curlVersion;

        return null;
    }

    private async resolveLocalBundleVersion(device: Device, folderPath: string, indexHtml: string): Promise<string | null> {
        const scripts = Array.from(indexHtml.matchAll(/<script[^>]+src=['"]([^'"]+)['"]/g))
            .map(m => m[1])
            .filter(src => /\bjs\/index\.[^/'"]+\.js/i.test(src));

        for (const src of scripts) {
            const filePath = src.startsWith('/') ? src : `${folderPath}/${src.replace(/^\.\//, '')}`;
            const version = await this.grepAppVersion(device, filePath);
            if (version) return version;
        }
        return null;
    }

    /**
     * Reads APP_VERSION out of a bundle without downloading it.
     *
     * These bundles run to megabytes, and pulling one over SFTP just to regex it was the slowest
     * step in showing the app list — grep on the TV sends back a single line instead. The probe
     * in front checks that grep understands -o and -E before trusting a silent result, since a
     * busybox without them looks exactly like a bundle that has no APP_VERSION.
     */
    private async grepAppVersion(device: Device, filePath: string): Promise<string | null> {
        const pattern = `APP_VERSION[[:space:]]*:[[:space:]]*["'][^"']*["']`.replace(/"/g, '\\"');
        const command = [
            `if echo APP_VERSION | grep -aoE APP_VERSION >/dev/null 2>&1; then`,
            `grep -aoE "${pattern}" ${this.shellQuote(filePath)} 2>/dev/null | head -n 1;`,
            `else echo '${GREP_UNSUPPORTED}'; fi; true`,
        ].join(' ');

        const matched = await this.cmd.exec(device, command, 'utf-8').catch(() => GREP_UNSUPPORTED);
        if (!matched.includes(GREP_UNSUPPORTED)) {
            // grep ran: either it found the version, or the bundle genuinely has none.
            return this.extractAppVersion(matched);
        }

        const bundle = await this.fileService.read(device, filePath, undefined, 'utf-8').catch(() => '');
        return bundle ? this.extractAppVersion(bundle) : null;
    }

    private mayBeHostedFreeTvApp(pkg: PackageInfo): boolean {
        const haystack = `${pkg.id} ${pkg.title} ${pkg.vendor}`.toLowerCase();
        return haystack.includes('freetv') || haystack.includes('free tv');
    }

    private directHostedIndexCandidates(pkg: PackageInfo): string[] {
        const haystack = `${pkg.id} ${pkg.title}`.toLowerCase();
        if (haystack.includes('preprodtest') || pkg.id === 'tv.freetv.portal.preprodtest') {
            return ['https://uat-web.freetv.tv/apps/smarttv/preprodtest/lg/uhd/index.html'];
        }
        if (haystack.includes('preprod') || pkg.id === 'tv.freetv.portal.preprod') {
            return ['https://uat-web.freetv.tv/apps/smarttv/preprod/lg/uhd/index.html'];
        }
        if (
            haystack.includes('uat') ||
            haystack.includes('prod-for-uat') ||
            haystack.includes('prod.on.uat') ||
            haystack.includes('prod on uat')
        ) {
            return ['https://uat-web.freetv.tv/apps/smarttv/prod-for-uat/lg/uhd/index.html'];
        }
        return [
            'https://uat-web.freetv.tv/apps/smarttv/preprod/lg/uhd/index.html',
            'https://uat-web.freetv.tv/apps/smarttv/prod-for-uat/lg/uhd/index.html',
        ];
    }

    private async findHostedIndexUrls(localIndex: string): Promise<string[]> {
        const urls: string[] = [];

        const redirectPatterns = [
            /window\.location\.href\s*=\s*['"]([^'"]+)['"]/,
            /window\.location\s*=\s*['"]([^'"]+)['"]/,
            /location\.href\s*=\s*['"]([^'"]+)['"]/,
        ];
        for (const pattern of redirectPatterns) {
            const url = localIndex.match(pattern)?.[1];
            if (url?.startsWith('https://')) {
                urls.push(url);
                break;
            }
        }

        const hostUrl = localIndex.match(/hostUrl\s*:\s*['"]([^'"]+)['"]/)?.[1];
        if (hostUrl) {
            urls.push(
                `${hostUrl.replace(/\/$/, '')}/lg/uhd/index.html`,
                `${hostUrl.replace(/\/$/, '')}/lg/index.html`,
            );
        }

        return urls;
    }

    private async resolveHostedIndexVersion(hostedIndexUrl: string): Promise<string | null> {
        const hostedIndex = await this.fetchText(hostedIndexUrl).catch(() => '');
        if (!hostedIndex) return null;

        const bundleUrl = this.findBundleUrl(hostedIndex, hostedIndexUrl);
        if (!bundleUrl) return null;

        const bundle = await this.fetchText(bundleUrl).catch(() => '');
        return bundle ? this.extractAppVersion(bundle) : null;
    }

    private async resolveWithCurl(hostedIndexUrl?: string): Promise<string | null> {
        if (!hostedIndexUrl) return null;

        const script = [
            `set -e`,
            `index_url=${this.shellQuote(hostedIndexUrl)}`,
            `base_url="$(printf '%s' "$index_url" | sed -E 's#(https?://[^/]+).*#\\1#')"`,
            `bundle="$(curl -LfsS "$index_url" | sed -n 's/.*src="\\([^"]*\\/js\\/index\\.[^"]*\\.js\\)".*/\\1/p' | head -1)"`,
            `test -n "$bundle"`,
            `curl -LfsS "$base_url$bundle" | sed -n 's/.*APP_VERSION:"\\([^"]*\\)".*/\\1/p' | head -1`,
        ].join('; ');

        const out = await Command.create('zsh', ['-lc', script]).execute().catch(() => null);
        if (!out || out.code !== 0) return null;

        return out.stdout.trim() || null;
    }

    private findBundleUrl(indexHtml: string, indexUrl: string): string | null {
        const scripts = Array.from(indexHtml.matchAll(/<script[^>]+src=['"]([^'"]+)['"]/g))
            .map(match => match[1])
            .filter(src => /\bjs\/index\.[^/'"]+\.js/i.test(src));
        const script = scripts[0];
        return script ? new URL(script, indexUrl).toString() : null;
    }

    private extractAppVersion(bundle: string): string | null {
        return bundle.match(/\bAPP_VERSION\s*:\s*['"]([^'"]+)['"]/)?.[1] ?? null;
    }

    private unique(urls: string[]): string[] {
        return Array.from(new Set(urls.filter(Boolean)));
    }

    private shellQuote(value: string): string {
        return `'${value.replace(/'/g, `'\\''`)}'`;
    }

    private async fetchText(url: string): Promise<string> {
        const response = await fetch(url);
        if (!response.ok) {
            throw new Error(`Failed to fetch ${url}: ${response.status}`);
        }
        return response.text();
    }
}
