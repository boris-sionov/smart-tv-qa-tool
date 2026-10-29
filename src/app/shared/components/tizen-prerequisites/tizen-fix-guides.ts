import {TizenPrerequisites} from '../../../core/services/sdb.service';

/**
 * Install steps shown under the Samsung requirements list for whatever failed, written for the
 * computer the check ran on.
 *
 * The SDK guide links straight to the Tizen Studio 6.1 CLI installer (14 April 2025, the last
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
    key: 'sdk' | 'java' | 'bundled-sdb';
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

/** The Tizen Studio installers for an OS: the CLI-only one (recommended) and the full IDE. */
function studioInstallers(os: HostOs): {cli: FixLink; ide: FixLink; cliFile: string} {
    const [suffix, ideExt, ideSize, cliExt, cliSize] = {
        macos: ['macos-64', 'dmg', '650 MB', 'bin', '280 MB'],
        windows: ['windows-64', 'exe', '660 MB', 'exe', '295 MB'],
        linux: ['ubuntu-64', 'bin', '670 MB', 'bin', '280 MB'],
    }[os];
    const file = (kind: string, ext: string) => `web-${kind}_Tizen_Studio_${STUDIO_VERSION}_${suffix}.${ext}`;
    return {
        cli: {label: `${file('cli', cliExt)} (CLI only, ${cliSize})`, url: STUDIO_BASE + file('cli', cliExt)},
        ide: {label: `${file('ide', ideExt)} (full IDE, ${ideSize})`, url: STUDIO_BASE + file('ide', ideExt)},
        cliFile: file('cli', cliExt),
    };
}

/**
 * The CLI-only install, start to finish, without opening a window: the installer and the package
 * manager both take `--accept-license`. The CLI install already carries the tizen CLI, sdb, a JDK
 * and Device Manager; Certificate Manager and the Samsung Certificate Extension (`cert-add-on`)
 * come from `package-manager-cli`. Run on macOS on 2026-10-29 into an empty home; not run on
 * Windows or Linux.
 */
function sdkGuide(os: HostOs, arch: string): FixGuide {
    const dir = studioDir(os);
    const {cli, ide, cliFile} = studioInstallers(os);
    const install = {
        macos: `chmod +x ~/Downloads/${cliFile} && ~/Downloads/${cliFile} --accept-license ${dir}`,
        windows: `%USERPROFILE%\\Downloads\\${cliFile} --accept-license ${dir}`,
        linux: `chmod +x ~/Downloads/${cliFile} && ~/Downloads/${cliFile} --accept-license ${dir}`,
    }[os];
    const packageManager = os === 'windows'
        ? `${dir}\\package-manager\\package-manager-cli.exe`
        : `${dir}/package-manager/package-manager-cli.bin`;
    const shell = os === 'windows' ? 'Command Prompt' : 'Terminal';

    const steps = [
        ...(os === 'macos' && arch === 'aarch64'
            ? ['Tizen Studio is built for Intel Macs. Install Rosetta first — in Terminal: ' +
               'softwareupdate --install-rosetta --agree-to-license']
            : []),
        `Download the Tizen Studio ${STUDIO_VERSION} CLI installer below (${cliFile}). ` +
        'It is the last Tizen Studio release, and the IDE is not needed.',
        `Install it without any window — in ${shell}: ${install}. It brings the Tizen CLI, sdb, ` +
        'its own Java and Device Manager.',
        `Add Certificate Manager and the Samsung Certificate Extension — in ${shell}: ` +
        `${packageManager} install --accept-license Certificate-Manager,cert-add-on. It first updates ` +
        'what is already installed; expect over 10 minutes and about 2 GB in all.',
        `Keep the location ${dir} — the QA tool looks there. Then press "Check again".`,
    ];
    return {
        key: 'sdk',
        title: `Install Tizen Studio ${STUDIO_VERSION} (CLI) and Certificate Manager`,
        download: cli.label,
        links: [cli, ide, LINKS.tizenArchive, LINKS.tvSdk],
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
 * so that is the one guide shown. A Studio that was found but is not the saved one needs no
 * install — the check's own hint says what to do.
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
        }
    }
    return guides;
}
