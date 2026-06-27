import {Component, Input, OnInit} from '@angular/core';
import {NgbActiveModal} from '@ng-bootstrap/ng-bootstrap';
import {Command} from '@tauri-apps/plugin-shell';
import {open as showOpenDialog} from '@tauri-apps/plugin-dialog';
import {homeDir} from '@tauri-apps/api/path';
import {SdbService} from '../../core/services/sdb.service';
import {tizenSerial, TizenDevice, TizenStateService} from '../tizen-state.service';
import {extractMessage} from '../../core/utils/error.utils';

const DEFAULT_PORT = 26101;

@Component({
    selector: 'app-tizen-wizard',
    templateUrl: './tizen-wizard.component.html',
    styleUrls: ['./tizen-wizard.component.scss'],
})
export class TizenWizardComponent implements OnInit {
    /** Set to 3 to open directly on the certificate step (from the Apps banner). */
    @Input() startStep: 1 | 2 | 3 = 1;

    currentStep: 1 | 2 | 3 = 1;

    // ── Step 1 & 2 ────────────────────────────────────────────────────────────
    name = '';
    ip = '';
    connecting = false;
    error: string | null = null;
    macIp: string | null = null;

    // ── Step 3 — certificate setup ────────────────────────────────────────────
    /** Full path to the selected distributor .p12 file */
    certFilePath = '';

    /** Profile name = the parent folder of the selected .p12 */
    get certProfileName(): string {
        if (!this.certFilePath) return '';
        const parts = this.certFilePath.replace(/\\/g, '/').split('/');
        return parts.length >= 2 ? parts[parts.length - 2] : '';
    }

    constructor(
        public modal: NgbActiveModal,
        private sdb: SdbService,
        private state: TizenStateService,
    ) {}

    async ngOnInit(): Promise<void> {
        this.currentStep = this.startStep;

        if (this.startStep !== 3) {
            // Detect this Mac's IP for the developer mode hint
            try {
                const cmd = Command.create('zsh', ['-lc',
                    `IFACE=$(route -n get default 2>/dev/null | awk '/interface:/ {print $2}'); ` +
                    `[ -n "$IFACE" ] && ipconfig getifaddr "$IFACE"`,
                ]);
                const out = await cmd.execute();
                const ip = (out.stdout ?? '').trim().split('\n')[0]?.trim();
                this.macIp = (ip && /^\d+\.\d+\.\d+\.\d+$/.test(ip) && !ip.startsWith('169.254')) ? ip : null;
            } catch {
                this.macIp = null;
            }
        }
    }

    // ── Step 1 / 2 actions ───────────────────────────────────────────────────

    next(): void { this.currentStep = 2; }
    back(): void { this.currentStep = 1; }

    get canSubmit(): boolean {
        return !!this.name.trim() && !!this.ip.trim() && !this.connecting;
    }

    async submit(): Promise<void> {
        if (!this.canSubmit) return;
        const name = this.name.trim();
        const ip = this.ip.trim();
        this.connecting = true;
        this.error = null;
        try {
            const device: TizenDevice = {name, ip, port: DEFAULT_PORT};
            await this.sdb.connect(tizenSerial(device));
            this.state.saveDevice(device);
            this.state.select(device);
            this.currentStep = 3;
        } catch (e) {
            this.error = extractMessage(e, 'Failed to connect');
        } finally {
            this.connecting = false;
        }
    }

    // ── Step 3 actions ───────────────────────────────────────────────────────

    async browseCert(): Promise<void> {
        const home = await homeDir().catch(() => '');
        const defaultPath = `${home}/SamsungCertificate`;
        const selected = await showOpenDialog({
            defaultPath,
            filters: [{name: 'Certificate', extensions: ['p12']}],
            multiple: false,
        });
        if (selected) {
            this.certFilePath = selected as string;
        }
    }

    saveCert(): void {
        if (!this.certProfileName) return;
        this.state.setCertProfile(this.certProfileName);
        // Derive home from cert path: /Users/borissionov/SamsungCertificate/... → /Users/borissionov
        const parts = this.certFilePath.replace(/\\/g, '/').split('/');
        // On macOS: ['', 'Users', 'borissionov', 'SamsungCertificate', ...]
        const homeDir = parts.length >= 3 ? '/' + parts[1] + '/' + parts[2] : '';
        if (homeDir) {
            this.state.setStudioPath(homeDir + '/tizen-studio');
        }
        this.modal.close({certProfile: this.certProfileName});
    }

    skipCert(): void {
        this.modal.close(null);
    }

    get certTitle(): string {
        return this.startStep === 3 ? 'Signing Certificate' : 'Set Up Signing Certificate';
    }
}
