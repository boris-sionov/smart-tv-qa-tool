import {Injectable} from '@angular/core';
import {open as showOpenDialog} from '@tauri-apps/plugin-dialog';
import {Command} from '@tauri-apps/plugin-shell';
import {readTextFile} from '@tauri-apps/plugin-fs';
import {homeDir} from '@tauri-apps/api/path';
import {DeviceProvider, DeviceInfo, Platform, PlatformApp, PlatformDevice} from '../models/device-provider.interface';

export interface SdbDevice {
    serial: string;
    state: string;
}

export interface SdbAppInfo {
    id: string;
    name: string;
}


function shellQuote(value: string): string {
    return `'${value.replace(/'/g, `'\\''`)}'`;
}

function parseAppList(output: string): PlatformApp[] {
    const apps = new Map<string, string>(); // id → name

    for (const rawLine of output.split('\n')) {
        const line = rawLine.trim();
        if (!line) continue;

        // Samsung Tizen applist format (sdb shell 0 applist):
        //   'App Name'   'com.package.AppID'
        const quotedPair = line.match(/^'([^']*)'\s+'([^']+)'$/);
        if (quotedPair) {
            const name = quotedPair[1].trim();
            const id   = quotedPair[2].trim();
            if (id) apps.set(id, name || id);
            continue;
        }

        // pkgcmd -l key=value format: pkgid=com.example.app
        const kvMatch = line.match(/\b(?:app[_-]?id|appid|pkgid|pkg_id|package)\s*[:=]\s*([A-Za-z0-9_.-]+)/i);
        if (kvMatch?.[1]) { apps.set(kvMatch[1], kvMatch[1]); continue; }

        // Bare package ID line: com.example.app
        if (/^[A-Za-z0-9][A-Za-z0-9_.-]+\.[A-Za-z0-9_.-]+$/.test(line)) {
            apps.set(line, line);
        }
    }

    return Array.from(apps.entries())
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([id, name]) => ({id, name, versionName: ''}));
}

// ---------------------------------------------------------------------------
// Shell helpers
// ---------------------------------------------------------------------------

/**
 * Builds a shell fragment that finds the SDB binary.
 * Search order:
 *   1. ~/.tizen-extension-platform  (Tizen Extension v10+ for VS Code)
 *   2. ~/tizen-studio                (older Tizen Extension / Tizen Studio)
 *   3. ~/.tizen-studio               (legacy Tizen Studio)
 *   4. VS Code extensions folder     (any tizen extension subfolder, depth search)
 *   5. System PATH
 */
function sdbLocator(): string {
    return `
SDB=""
for _try in \
    "$HOME/.tizen-extension-platform/server/sdktools/data/tools/sdb" \
    "$HOME/tizen-studio/tools/sdb" \
    "$HOME/.tizen-studio/tools/sdb"; do
  [ -x "$_try" ] && { SDB="$_try"; break; }
done
# Broad search under VS Code extensions as a final fallback
[ -z "$SDB" ] && _EXT_SDB="$(find "$HOME/.vscode/extensions" -name "sdb" -path "*/tools/sdb" -maxdepth 6 2>/dev/null | head -1)"
[ -n "$_EXT_SDB" ] && [ -x "$_EXT_SDB" ] && SDB="$_EXT_SDB"
[ -z "$SDB" ] && SDB="$(command -v sdb 2>/dev/null)"
[ -z "$SDB" ] && {
  echo "SDB not found." >&2
  echo "Install the Tizen Extension in VS Code, then open its sidebar → Packages → install TIZEN-CORE-APP" >&2
  exit 127
}
# Start the SDB server; if a stale server from an older installation is
# running (version mismatch), kill it first and start the correct one.
_SDB_START="$("$SDB" start-server 2>&1)"
if echo "$_SDB_START" | grep -qi "version.*different"; then
  "$SDB" kill-server >/dev/null 2>&1 || true
  "$SDB" start-server >/dev/null 2>&1 || true
fi
"$SDB"`.trim();
}

/**
 * Builds a shell fragment that finds the modern `tz` CLI (tizen-core).
 * No JDK required — `tz` is a standalone Mach-O. Used for install,
 * uninstall, signing, profile management, and (later) web inspector launch.
 */
function tzLocator(): string {
    return `
TZ_CLI=""
for _try in \
    "$HOME/.tizen-extension-platform/server/sdktools/data/tools/tizen-core/tz" \
    "$HOME/tizen-studio/tools/tizen-core/tz" \
    "$HOME/.tizen-studio/tools/tizen-core/tz"; do
  [ -x "$_try" ] && { TZ_CLI="$_try"; break; }
done
[ -z "$TZ_CLI" ] && _EXT_TZ="$(find "$HOME/.vscode/extensions" -name "tz" -path "*/tizen-core/tz" -maxdepth 8 2>/dev/null | head -1)"
[ -n "$_EXT_TZ" ] && [ -x "$_EXT_TZ" ] && TZ_CLI="$_EXT_TZ"
[ -z "$TZ_CLI" ] && {
  echo "tz CLI not found." >&2
  echo "Install the Tizen Extension in VS Code, then open its sidebar → Packages → install TIZEN-CORE-APP" >&2
  exit 127
}
"$TZ_CLI"`.trim();
}

/**
 * Builds a shell fragment that finds the tizen CLI (used for signing packages).
 * Comes from the same VS Code extension or old Tizen Studio.
 *
 * Also auto-patches sdk.info on Apple Silicon Macs: the bundled JDK shipped
 * with Tizen Studio is x86_64-only and cannot run under Rosetta 2.  When that
 * situation is detected we append JDK_PATH to sdk.info pointing to the first
 * ARM64 JDK found in /Library/Java/JavaVirtualMachines.
 */
function tizenLocator(): string {
    return `
TIZEN_CLI=""
for _try in \
    "$HOME/.tizen-extension-platform/server/sdktools/data/tools/ide/bin/tizen" \
    "$HOME/tizen-studio/tools/ide/bin/tizen" \
    "$HOME/.tizen-studio/tools/ide/bin/tizen"; do
  [ -x "$_try" ] && { TIZEN_CLI="$_try"; break; }
done
[ -z "$TIZEN_CLI" ] && _EXT_TIZEN="$(find "$HOME/.vscode/extensions" -name "tizen" -path "*/ide/bin/tizen" -maxdepth 7 2>/dev/null | head -1)"
[ -n "$_EXT_TIZEN" ] && [ -x "$_EXT_TIZEN" ] && TIZEN_CLI="$_EXT_TIZEN"
[ -z "$TIZEN_CLI" ] && TIZEN_CLI="$(command -v tizen 2>/dev/null)"
[ -z "$TIZEN_CLI" ] && {
  echo "tizen CLI not found." >&2
  echo "Install the Tizen Extension in VS Code, then open its sidebar → Packages → install TIZEN-CORE-APP" >&2
  exit 127
}
# ── Apple Silicon fix ────────────────────────────────────────────────────────
# The Tizen Studio bundle ships an x86_64 JDK that cannot initialise on ARM64.
# If sdk.info has no JDK_PATH entry yet, find an ARM64 JDK and add it so that
# tizen.sh picks it up instead of the bundled binary.
_SDK_INFO=""
for _si_try in \
    "$HOME/.tizen-extension-platform/server/sdktools/data/sdk.info" \
    "$HOME/tizen-studio/sdk.info" \
    "$HOME/.tizen-studio/sdk.info"; do
  [ -f "$_si_try" ] && { _SDK_INFO="$_si_try"; break; }
done
# Derive the bundled JDK path from the sdk.info location (../jdk relative to sdk root)
_SDK_ROOT="$(dirname "$_SDK_INFO" 2>/dev/null)"
_BUNDLED_JAVA="$_SDK_ROOT/jdk/Contents/Home/bin/java"
if [ -f "$_SDK_INFO" ] && ! grep -q "^JDK_PATH=" "$_SDK_INFO" 2>/dev/null; then
  if [ "$(uname -m)" = "arm64" ] && [ -f "$_BUNDLED_JAVA" ] && file "$_BUNDLED_JAVA" 2>/dev/null | grep -q "x86_64"; then
    _ARM_JDK=""
    for _jdk_try in \
        "/Library/Java/JavaVirtualMachines/temurin-17.jdk" \
        "/Library/Java/JavaVirtualMachines/temurin-21.jdk" \
        "/Library/Java/JavaVirtualMachines/temurin-11.jdk" \
        "/Library/Java/JavaVirtualMachines/zulu-17.jdk" \
        "/Library/Java/JavaVirtualMachines/jdk-17.jdk" \
        "/Library/Java/JavaVirtualMachines/jdk-11.jdk"; do
      if [ -x "$_jdk_try/Contents/Home/bin/java" ] && file "$_jdk_try/Contents/Home/bin/java" 2>/dev/null | grep -q "arm64"; then
        _ARM_JDK="$_jdk_try"
        break
      fi
    done
    [ -n "$_ARM_JDK" ] && echo "JDK_PATH=$_ARM_JDK" >> "$_SDK_INFO"
  fi
fi
# ────────────────────────────────────────────────────────────────────────────
"$TIZEN_CLI"`.trim();
}

// ---------------------------------------------------------------------------

@Injectable({providedIn: 'root'})
export class SdbService implements DeviceProvider {

    readonly platform: Platform = 'tizen';

    private async exec(shellCmd: string): Promise<string> {
        const cmd = Command.create('zsh', ['-lc', shellCmd]);
        let out = await cmd.execute();
        const combined = `${out.stdout ?? ''}\n${out.stderr ?? ''}`;

        // SDB prints "Server has started successfully" to stderr on first launch — retry once
        if (out.code !== 0 && combined.includes('Server has started successfully')) {
            out = await Command.create('zsh', ['-lc', shellCmd]).execute();
        }

        // SDB client/server version mismatch (stale server from an old installation).
        // Kill the old server, start the new one, then retry the original command.
        if (/version.*different|recommend.*sdb server/i.test(combined)) {
            const restart = `${sdbLocator()} kill-server >/dev/null 2>&1 || true; ${sdbLocator()} start-server >/dev/null 2>&1 || true`;
            await Command.create('zsh', ['-lc', restart]).execute().catch(() => {});
            out = await Command.create('zsh', ['-lc', shellCmd]).execute();
        }

        if (out.code !== 0) {
            // SDB 4.2.36+ exits non-zero when it emits the "unencrypted connection"
            // security warning, even though the underlying command (push, connect, etc.)
            // actually succeeded.  If stdout has real content, trust the command worked.
            if (/WARNING.*unencrypted/i.test(out.stderr ?? '') && (out.stdout ?? '').trim()) {
                return out.stdout ?? '';
            }
            throw new Error(out.stderr?.trim() || out.stdout?.trim() || `command exited with code ${out.code}`);
        }
        return out.stdout ?? '';
    }

    // -----------------------------------------------------------------------
    // Device connection
    // -----------------------------------------------------------------------

    async connect(host: string, port = 26101): Promise<string> {
        const target = host.includes(':') ? host : `${host}:${port}`;
        const out = await this.exec(`${sdbLocator()} connect ${shellQuote(target)}`);
        if (out.toLowerCase().includes('failed') || out.toLowerCase().includes('error')) {
            throw new Error(out.trim());
        }
        return out.trim();
    }

    async disconnect(serial: string): Promise<void> {
        await this.exec(`${sdbLocator()} disconnect ${shellQuote(serial)}`).catch(() => {});
    }

    async listConnectedDevices(): Promise<PlatformDevice[]> {
        const out = await this.exec(`${sdbLocator()} devices`);
        return out.split('\n')
            .map(l => l.trim())
            .filter(l => l && !l.toLowerCase().startsWith('list of devices'))
            .map(l => { const [serial, state] = l.split(/\s+/); return {serial, state: state ?? 'device'} as PlatformDevice; })
            .filter(d => !!d.serial);
    }

    async ensureConnected(serial: string): Promise<void> {
        const devices = await this.listConnectedDevices().catch(() => []);
        if (devices.some(d => d.serial === serial && d.state !== 'offline')) return;
        await this.connect(serial);
    }

    // -----------------------------------------------------------------------
    // Package management
    // -----------------------------------------------------------------------

    /**
     * Installs a TPK/WGT via the modern `tz install` flow.
     * This is the same install logic VS Code's Tizen Extension uses internally.
     * Replaces the old manual sdb-push + pkgcmd flow that silently failed when
     * the firmware wiped the pushed file before pkgcmd could find it.
     */
    async install(serial: string, filePath: string): Promise<string> {
        await this.ensureConnected(serial);
        const out = await this.exec(
            `${tzLocator()} install -p ${shellQuote(filePath)} -e ${shellQuote(serial)} 2>&1`
        );
        this.checkInstallOutput(out);
        return out.trim();
    }

    private checkInstallOutput(out: string): void {
        if (/cert|signature|privilege|author|distributor|invalid sig/i.test(out)) {
            throw new Error(
                `Certificate error — package is not signed for this TV.\n\n` +
                `How to fix:\n` +
                `1. Click "Get DUID" to get this TV's device ID\n` +
                `2. In VS Code → Tizen Extension → Certificate Manager\n` +
                `3. Add the DUID to a distributor certificate\n` +
                `4. Use "Sign & Install" in this app to sign + deploy in one step\n\n` +
                `Raw output:\n${out.trim()}`
            );
        }
        if (/fail|error|unknown type|invalid|denied/i.test(out) && !/success|100%|install ok/i.test(out)) {
            throw new Error(`Install reported a failure:\n\n${out.trim()}`);
        }
    }

    /**
     * Re-signs a WGT/TPK with a profile, then installs it. Uses `tz pack`
     * (no JDK required) instead of the legacy `tizen package` shell wrapper.
     */
    async signAndInstall(serial: string, filePath: string, profileName: string): Promise<string> {
        await this.ensureConnected(serial);

        const pkgType = filePath.toLowerCase().endsWith('.wgt') ? 'wgt' : 'tpk';
        const tz = tzLocator();

        const signOut = await this.exec(
            `${tz} pack -t ${pkgType} -s ${shellQuote(profileName)} -- ${shellQuote(filePath)} 2>&1`
        );

        const installResult = await this.install(serial, filePath);

        return [signOut.trim(), installResult].filter(Boolean).join('\n\n');
    }

    async uninstall(serial: string, appId: string): Promise<string> {
        await this.ensureConnected(serial);
        const safe = shellQuote(appId.trim());
        return this.exec(`${sdbLocator()} -s ${shellQuote(serial)} uninstall ${safe}`)
            .catch(() => this.exec(`${sdbLocator()} -s ${shellQuote(serial)} shell 0 pkgcmd -u -n ${safe}`))
            .then(out => out.trim());
    }

    async listApps(serial: string): Promise<PlatformApp[]> {
        await this.ensureConnected(serial);
        for (const cmd of [
            `${sdbLocator()} -s ${shellQuote(serial)} shell 0 applist`,
            `${sdbLocator()} -s ${shellQuote(serial)} shell pkgcmd -l`,
            `${sdbLocator()} -s ${shellQuote(serial)} shell /usr/bin/pkgcmd -l`,
        ]) {
            try {
                const apps = parseAppList(await this.exec(cmd));
                if (apps.length > 0) return apps;
            } catch {}
        }
        return [];
    }

    // DeviceProvider bridge methods
    async getAppIcon(_serial: string, _appId: string): Promise<string | null> {
        return null;
    }

    async launchApp(serial: string, appId: string): Promise<void> {
        await this.launch(serial, appId);
    }

    async killApp(serial: string, appId: string): Promise<void> {
        await this.kill(serial, appId);
    }

    async installApp(serial: string, filePath: string): Promise<void> {
        await this.install(serial, filePath);
    }

    async uninstallApp(serial: string, appId: string): Promise<void> {
        await this.uninstall(serial, appId);
    }

    async openPackageChooser(): Promise<string | null> {
        return this.openWgtChooser();
    }

    async getDeviceInfo(serial: string): Promise<DeviceInfo> {
        await this.ensureConnected(serial);
        const getProp = async (key: string): Promise<string> =>
            this.exec(`${sdbLocator()} -s ${shellQuote(serial)} shell getprop ${shellQuote(key)}`)
                .then(s => s.trim())
                .catch(() => '');
        const [model, manufacturer, osVersion] = await Promise.all([
            getProp('ro.product.model'),
            getProp('ro.product.manufacturer'),
            getProp('ro.build.version.release'),
        ]);
        return {model, manufacturer, osVersion};
    }

    async launch(serial: string, appId: string): Promise<string> {
        await this.ensureConnected(serial);
        return this.exec(`${sdbLocator()} -s ${shellQuote(serial)} shell 0 execute ${shellQuote(appId.trim())}`)
            .then(out => out.trim());
    }

    async kill(serial: string, appId: string): Promise<string> {
        await this.ensureConnected(serial);
        return this.exec(`${sdbLocator()} -s ${shellQuote(serial)} shell 0 execute 0 kill ${shellQuote(appId.trim())}`)
            .then(out => out.trim());
    }

    /**
     * Launches an app in debug mode and returns the inspector port.
     * Runs: sdb -s <serial> shell 0 debug <appId>
     * Expected output: "successfully launched pid = 3963 with debug 1 port: 37367"
     */
    async debug(serial: string, appId: string): Promise<number> {
        await this.ensureConnected(serial);
        const out = await this.exec(
            `${sdbLocator()} -s ${shellQuote(serial)} shell 0 debug ${shellQuote(appId.trim())}`
        );

        const portMatch = out.match(/port:\s*(\d+)/i);
        if (!portMatch) {
            throw new Error(
                `Could not parse debug port from SDB output.\n\n` +
                `Expected output containing "port: <number>".\n` +
                `Got: ${out.trim()}`
            );
        }

        const port = parseInt(portMatch[1], 10);
        if (isNaN(port) || port < 1 || port > 65535) {
            throw new Error(`Invalid port number parsed: ${portMatch[1]}`);
        }

        return port;
    }

    // -----------------------------------------------------------------------
    // Certificate helpers
    // -----------------------------------------------------------------------

    async getDeviceDuid(serial: string): Promise<string> {
        await this.ensureConnected(serial);
        for (const cmd of [
            `${sdbLocator()} -s ${shellQuote(serial)} duid`,
            `${sdbLocator()} -s ${shellQuote(serial)} shell 0 duid`,
            `${sdbLocator()} -s ${shellQuote(serial)} shell 0 /usr/bin/duid`,
            `${sdbLocator()} -s ${shellQuote(serial)} shell 0 getprop _duid`,
        ]) {
            const out = await this.exec(cmd).catch(() => '');
            const hex = out.match(/[0-9A-Fa-f]{40}/);
            if (hex) return hex[0];
            const trimmed = out.trim().replace(/^DUID:\s*/i, '');
            if (trimmed.length > 8 && !/not found|error/i.test(trimmed)) return trimmed;
        }
        throw new Error(
            'Could not retrieve DUID from this device.\n\n' +
            'Alternative: In VS Code → Tizen Extension (sidebar) → Connect Device → ' +
            'select this TV → the DUID is shown in the device details.'
        );
    }

    /**
     * Reads certificate profile names from profiles.xml.
     * Returns them with the active profile first.
     * Compatible with both old Tizen Studio and the new Tizen Extension for VS Code.
     */
    async getCertificateProfiles(): Promise<string[]> {
        const home = await homeDir();
        const candidates = [
            `${home}/.tizen-extension-platform/server/sdktools/sdk-data/profile/profiles.xml`, // Tizen Extension v10+
            `${home}/tizen-studio-data/profile/profiles.xml`,                                   // older Tizen Extension
            `${home}/.tizen-studio-data/profile/profiles.xml`,                                  // legacy Tizen Studio
        ];
        for (const path of candidates) {
            const xml = await readTextFile(path).catch(() => '');
            if (!xml) continue;

            // Get the active profile name
            const activeMatch = xml.match(/<profiles[^>]*\bactive=["']([^"']+)["']/i);
            const activeName = activeMatch?.[1] ?? '';

            // Extract all profile names
            const names = [...xml.matchAll(/<profile[^>]*\bname=["']([^"']+)["']/gi)]
                .map(m => m[1])
                .filter(Boolean);

            if (names.length === 0) continue;

            // Put active profile first
            if (activeName) {
                const sorted = [activeName, ...names.filter(n => n !== activeName)];
                return sorted;
            }
            return names;
        }
        return [];
    }

    async isTizenCliAvailable(): Promise<boolean> {
        const out = await this.exec(`${tizenLocator()} version 2>&1 || true`).catch(() => '');
        return out.toLowerCase().includes('tizen') || out.includes('CLI');
    }

    // -----------------------------------------------------------------------
    // Certificate / profile management (in-app, no Tizen Studio required)
    // -----------------------------------------------------------------------

    /**
     * Returns the path to the active profile's distributor cert. Used by the
     * "Create Profile" wizard to default to a sensible bundled cert.
     */
    async getBundledDistributorCerts(): Promise<{publicCert: string; partnerCert: string; password: string}> {
        const home = await homeDir();
        const root = `${home}/.tizen-extension-platform/server/sdktools/data/tools/tizen-core/certificates/distributor`;
        return {
            publicCert: `${root}/tizen_public_signer.p12`,
            partnerCert: `${root}/tizen_partner_signer.p12`,
            password: 'tizenpkcs12passfordsigner',  // well-known Tizen public password
        };
    }

    /**
     * Creates a new author certificate using `tz cert`. Returns the path to the
     * generated .p12 file.
     */
    async createAuthorCert(opts: {
        name: string;
        password: string;
        email?: string;
        country?: string;
        organization?: string;
        department?: string;
    }): Promise<string> {
        const home = await homeDir();
        const dir = `${home}/.tizen-extension-platform/server/sdktools/sdk-data/keystore/author`;
        const fileBase = `${dir}/${opts.name.replace(/[^a-zA-Z0-9_-]/g, '_')}_auth`;

        const args = [
            `-n ${shellQuote(opts.name)}`,
            `-p ${shellQuote(opts.password)}`,
            `-f ${shellQuote(fileBase)}`,
        ];
        if (opts.country) args.push(`-C ${shellQuote(opts.country)}`);
        if (opts.email) args.push(`-e ${shellQuote(opts.email)}`);
        if (opts.organization) args.push(`-o ${shellQuote(opts.organization)}`);
        if (opts.department) args.push(`-d ${shellQuote(opts.department)}`);

        await this.exec(`mkdir -p ${shellQuote(dir)} && ${tzLocator()} cert ${args.join(' ')} 2>&1`);
        return `${fileBase}.p12`;
    }

    /**
     * Adds a signing profile pairing an author cert with a distributor cert.
     * Optionally accepts a second distributor cert (e.g. Samsung partner cert).
     */
    async createProfile(opts: {
        name: string;
        author: string;
        authorPassword: string;
        distributor: string;
        distributorPassword: string;
        distributor2?: string;
        distributor2Password?: string;
        active: boolean;
    }): Promise<void> {
        const args = [
            `-n ${shellQuote(opts.name)}`,
            `-a ${shellQuote(opts.author)}`,
            `-p ${shellQuote(opts.authorPassword)}`,
            `-d ${shellQuote(opts.distributor)}`,
            `-P ${shellQuote(opts.distributorPassword)}`,
        ];
        if (opts.active) args.push('-A');
        if (opts.distributor2) {
            args.push(`-D ${shellQuote(opts.distributor2)}`);
            if (opts.distributor2Password) args.push(`-w ${shellQuote(opts.distributor2Password)}`);
        }
        await this.exec(`${tzLocator()} security-profiles add ${args.join(' ')} 2>&1`);
    }

    async setActiveProfile(name: string): Promise<void> {
        await this.exec(
            `${tzLocator()} security-profiles set-active -n ${shellQuote(name)} 2>&1`
        );
    }

    async deleteProfile(name: string): Promise<void> {
        await this.exec(
            `${tzLocator()} security-profiles remove -n ${shellQuote(name)} 2>&1`
        );
    }

    /** Returns the currently active profile name, or null if none. */
    async getActiveProfile(): Promise<string | null> {
        try {
            const out = await this.exec(`${tzLocator()} security-profiles list 2>&1`);
            const m = out.match(/Current Active Profile:\s*(\S+)/);
            return m?.[1] ?? null;
        } catch {
            return null;
        }
    }

    // -----------------------------------------------------------------------
    // File chooser
    // -----------------------------------------------------------------------

    async openWgtChooser(): Promise<string | null> {
        return showOpenDialog({
            filters: [{name: 'Tizen package', extensions: ['tpk', 'wgt']}],
            multiple: false,
        });
    }

    async openP12Chooser(): Promise<string | null> {
        return showOpenDialog({
            filters: [{name: 'PKCS#12 certificate', extensions: ['p12']}],
            multiple: false,
        });
    }

}
