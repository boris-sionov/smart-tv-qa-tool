import {TizenPrerequisites} from '../../../core/services/sdb.service';

/**
 * Install steps shown under the Samsung requirements list for whatever failed, written for the
 * computer the check ran on.
 *
 * The SDK guide links straight to the Tizen Studio 6.1 installers (14 April 2025, the last
 * release — Tizen Studio is deprecated, so the files should stay put), with the folder listing
 * beside them in case they move. Every other link is a page. All were checked on 2026-10-28.
 * tizen.org's download pages now redirect to samsungtizenos.com, and the "Installation guide"
 * link on its tools page is a GitHub 404, so neither is used.
 */

export interface FixLink {
    label: string;
    url: string;
}

export interface FixGuide {
    key: 'sdk' | 'java' | 'certificate' | 'duids' | 'bundled-sdb';
    title: string;
    /** What to download, when the fix is a download. */
    download?: string;
    links: FixLink[];
    steps: string[];
}

export type HostOs = 'macos' | 'windows' | 'linux';

const LINKS = {
    tizenArchive: {label: 'All Tizen Studio installers (download.tizen.org)', url: 'https://download.tizen.org/sdk/Installer/'},
    tvSdk: {
        label: 'Samsung: Installing TV SDK',
        url: 'https://developer.samsung.com/smarttv/develop/getting-started/setting-up-sdk/installing-tv-sdk.html',
    },
    certificates: {
        label: 'Samsung: Creating certificates',
        url: 'https://developer.samsung.com/smarttv/develop/getting-started/setting-up-sdk/creating-certificates.html',
    },
    java: {label: 'Eclipse Temurin (Java) downloads', url: 'https://adoptium.net/temurin/releases/'},
} satisfies Record<string, FixLink>;

/** The Tizen Studio location each OS's installer defaults to, which is where the app looks. */
function studioDir(os: HostOs): string {
    return os === 'windows' ? 'C:\\tizen-studio' : '~/tizen-studio';
}

export function osLabel(os: string, arch: string): string {
    switch (os) {
        case 'macos':
            return arch === 'aarch64' ? 'macOS (Apple Silicon)' : 'macOS (Intel)';
        case 'windows':
            return 'Windows';
        case 'linux':
            return 'Linux';
        default:
            return os;
    }
}

const STUDIO_VERSION = '6.1';
const STUDIO_BASE = `https://download.tizen.org/sdk/Installer/tizen-studio_${STUDIO_VERSION}/`;

/** The Tizen Studio installers for an OS: the IDE (recommended) and the smaller CLI-only one. */
function studioInstallers(os: HostOs): {ide: FixLink; cli: FixLink} {
    const [suffix, ideExt, ideSize, cliExt, cliSize] = {
        macos: ['macos-64', 'dmg', '650 MB', 'bin', '280 MB'],
        windows: ['windows-64', 'exe', '660 MB', 'exe', '295 MB'],
        linux: ['ubuntu-64', 'bin', '670 MB', 'bin', '280 MB'],
    }[os];
    const file = (kind: string, ext: string) => `web-${kind}_Tizen_Studio_${STUDIO_VERSION}_${suffix}.${ext}`;
    return {
        ide: {label: `${file('ide', ideExt)} (IDE, ${ideSize})`, url: STUDIO_BASE + file('ide', ideExt)},
        cli: {label: `${file('cli', cliExt)} (CLI only, ${cliSize})`, url: STUDIO_BASE + file('cli', cliExt)},
    };
}

function sdkGuide(os: HostOs, arch: string): FixGuide {
    const dir = studioDir(os);
    const {ide, cli} = studioInstallers(os);
    const run = {
        macos: 'Open the .dmg and run the installer inside it. (The CLI-only .bin instead: in Terminal, ' +
            'chmod +x ~/Downloads/web-cli_Tizen_Studio_*_macos-64.bin, then run that file.)',
        windows: 'Run the downloaded .exe. If SmartScreen warns about it, choose More info → Run anyway.',
        linux: 'In a terminal: chmod +x ~/Downloads/web-*_Tizen_Studio_*_ubuntu-64.bin, then run that file.',
    }[os];
    const packageManager = {
        macos: `${dir}/package-manager/package-manager.app`,
        windows: `${dir}\\package-manager\\package-manager.exe`,
        linux: `${dir}/package-manager/package-manager.bin`,
    }[os];

    const steps = [
        ...(os === 'macos' && arch === 'aarch64'
            ? ['Tizen Studio is built for Intel Macs. Install Rosetta first — in Terminal: ' +
               'softwareupdate --install-rosetta --agree-to-license']
            : []),
        `Download the Tizen Studio ${STUDIO_VERSION} installer below — the IDE one is recommended; the ` +
        'CLI-only one is smaller and enough for the QA tool. It is the last Tizen Studio release.',
        run,
        `Accept the license and keep the install location ${dir} — the QA tool looks there. ` +
        'Tizen Studio brings its own Java; nothing else to install.',
        `When it finishes, open the Package Manager (${packageManager}).`,
        'In its "Extension SDK" tab install "TV Extensions" and "Samsung Certificate Extension" ' +
        '(2.0.73 or later — older versions can no longer create certificates).',
        'This also installs the Tizen CLI and its sdb. Come back here and press "Check again".',
    ];
    return {
        key: 'sdk',
        title: `Install Tizen Studio ${STUDIO_VERSION} and the TV extensions`,
        download: ide.label,
        links: [ide, cli, LINKS.tizenArchive, LINKS.tvSdk],
        steps,
    };
}

function javaGuide(os: HostOs, arch: string): FixGuide {
    const build = {
        macos: arch === 'aarch64' ? 'macOS, x64 .pkg (it runs under Rosetta, like Tizen Studio)' : 'macOS, x64 .pkg',
        windows: 'Windows, x64 .msi',
        linux: 'Linux, x64 .tar.gz',
    }[os];
    return {
        key: 'java',
        title: 'Give the Tizen CLI a Java to run on',
        download: `Temurin JDK 11 (LTS) — ${build}`,
        links: [LINKS.java],
        steps: [
            `Tizen Studio ships its own Java in ${studioDir(os)}${os === 'windows' ? '\\' : '/'}jdk. ` +
            'If that folder is missing, reinstalling the Tizen SDK (above) puts it back — try that first.',
            'Otherwise install a JDK from Temurin: pick version 11, your OS and the x64 build.',
            os === 'windows'
                ? 'In the installer, enable "Add to PATH" so the Tizen CLI finds java.'
                : 'Run the installer; it puts java on the PATH, where the Tizen CLI looks for it.',
            'Press "Check again".',
        ],
    };
}

function certificateGuide(os: HostOs): FixGuide {
    const certs = os === 'windows' ? '%USERPROFILE%\\SamsungCertificate\\<profile>' : '~/SamsungCertificate/<profile>';
    return {
        key: 'certificate',
        title: 'Create or select a Samsung certificate profile',
        links: [LINKS.certificates],
        steps: [
            'Open Certificate Manager (button below, or Tizen Studio → Tools → Certificate Manager).',
            'Click "+", choose Samsung → TV, and name the profile. Sign in with the Samsung account when ' +
            'asked.',
            'Create the author certificate, then the distributor certificate. On the distributor step add ' +
            'the DUID of every TV you install on.',
            `If the team gave you a profile instead, keep its folder as ${certs} with author.p12, ` +
            'distributor.p12 and device-profile.xml inside.',
            'In the QA tool: Samsung → Apps → Configure, and pick the distributor.p12 inside the folder ' +
            'named after the profile — the tool takes the profile name from that folder.',
            'Press "Check again".',
        ],
    };
}

const DUIDS_GUIDE: FixGuide = {
    key: 'duids',
    title: 'Register your TVs on the distributor certificate',
    links: [LINKS.certificates],
    steps: [
        'Find the TV\'s DUID: Samsung → Info in the QA tool, or Device Manager in Tizen Studio.',
        'In Certificate Manager, create the distributor certificate again for the profile and add ' +
        'every TV\'s DUID.',
        'Keep the device-profile.xml it writes next to distributor.p12 — the QA tool reads it to pick ' +
        'the right certificate per TV.',
    ],
};

function bundledSdbGuide(): FixGuide {
    return {
        key: 'bundled-sdb',
        title: 'Restore the sdb that ships with the QA tool',
        links: [],
        steps: [
            'Reinstall the Smart TV QA Tool from the latest release.',
            'Developers running from source: run npm run setup (npm run setup:win on Windows), which ' +
            'downloads sdb into src-tauri/binaries/.',
        ],
    };
}

/**
 * The guides for every check that did not pass, in list order, each once.
 *
 * Without Tizen Studio the CLI, its sdb and Java all fail too; installing the SDK fixes all four,
 * so that is the one guide shown. A Studio that was found but is not the saved one needs the
 * certificate set up again, not an install — the check's own hint says so.
 */
export function fixGuidesFor({checks, studioPath, os, arch}: TizenPrerequisites): FixGuide[] {
    const host: HostOs = os === 'windows' || os === 'linux' ? os : 'macos';
    const guides: FixGuide[] = [];
    const add = (guide: FixGuide) => {
        if (!guides.some(g => g.key === guide.key)) guides.push(guide);
    };
    for (const check of checks) {
        if (check.status === 'ok') continue;
        switch (check.id) {
            case 'sdb':
                add(bundledSdbGuide());
                break;
            case 'studio':
                if (!studioPath) add(sdkGuide(host, arch));
                break;
            case 'tizen-cli':
            case 'studio-sdb':
                add(sdkGuide(host, arch));
                break;
            case 'java':
                add(studioPath ? javaGuide(host, arch) : sdkGuide(host, arch));
                break;
            case 'profiles':
            case 'cert-profile':
                add(certificateGuide(host));
                break;
            case 'duids':
                add(DUIDS_GUIDE);
                break;
        }
    }
    return guides;
}
