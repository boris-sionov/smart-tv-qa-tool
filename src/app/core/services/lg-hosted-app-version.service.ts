import {Injectable} from '@angular/core';
import {fetch} from '@tauri-apps/plugin-http';
import {Command} from '@tauri-apps/plugin-shell';
import {Device, PackageInfo} from '../../types';
import {RemoteFileService} from './remote-file.service';

@Injectable({
    providedIn: 'root'
})
export class LgHostedAppVersionService {
    private cache = new Map<string, Promise<string | null>>();

    constructor(private fileService: RemoteFileService) {}

    getVersion(device: Device, pkg: PackageInfo): Promise<string | null> {
        const key = `${device.name}:${pkg.id}:${pkg.version}:${pkg.folderPath}`;
        let cached = this.cache.get(key);
        if (!cached) {
            cached = this.resolveVersion(device, pkg).catch(() => null);
            this.cache.set(key, cached);
        }
        return cached;
    }

    clear(): void {
        this.cache.clear();
    }

    private async resolveVersion(device: Device, pkg: PackageInfo): Promise<string | null> {
        if (!this.mayBeHostedFreeTvApp(pkg)) return null;

        const candidates = this.directHostedIndexCandidates(pkg);
        const localIndex = await this.fileService.read(device, `${pkg.folderPath}/index.html`, undefined, 'utf-8')
            .catch(() => '');
        candidates.push(...await this.findHostedIndexUrls(localIndex));

        for (const hostedIndexUrl of this.unique(candidates)) {
            const version = await this.resolveHostedIndexVersion(hostedIndexUrl);
            if (version) return version;
        }

        const curlVersion = await this.resolveWithCurl(candidates[0]);
        if (curlVersion) return curlVersion;

        return null;
    }

    private mayBeHostedFreeTvApp(pkg: PackageInfo): boolean {
        const haystack = `${pkg.id} ${pkg.title} ${pkg.vendor}`.toLowerCase();
        return haystack.includes('freetv') || haystack.includes('free tv');
    }

    private directHostedIndexCandidates(pkg: PackageInfo): string[] {
        const haystack = `${pkg.id} ${pkg.title}`.toLowerCase();
        if (haystack.includes('preprod')) {
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
        const redirectUrl = localIndex.match(/window\.location\.href\s*=\s*['"]([^'"]+)['"]/)?.[1];
        if (redirectUrl && this.isLgSmartTvUrl(redirectUrl)) {
            urls.push(redirectUrl);
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
            .filter(src => /\/apps\/smarttv\/.*\/lg\/.*\/js\/index\.[^/]+\.js/i.test(src));
        const script = scripts[0];
        return script ? new URL(script, indexUrl).toString() : null;
    }

    private extractAppVersion(bundle: string): string | null {
        return bundle.match(/\bAPP_VERSION\s*:\s*['"]([^'"]+)['"]/)?.[1] ?? null;
    }

    private isLgSmartTvUrl(url: string): boolean {
        return /^https:\/\/[^/]+\/apps\/smarttv\/.+\/lg\/.+\/index\.html$/i.test(url);
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
