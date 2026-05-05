import {Component, OnInit} from '@angular/core';
import {NgbActiveModal} from '@ng-bootstrap/ng-bootstrap';
import {Command} from '@tauri-apps/plugin-shell';
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
    currentStep: 1 | 2 = 1;

    name = '';
    ip = '';
    connecting = false;
    error: string | null = null;
    macIp: string | null = null;

    constructor(
        public modal: NgbActiveModal,
        private sdb: SdbService,
        private state: TizenStateService,
    ) {}

    async ngOnInit(): Promise<void> {
        // Ask the OS which interface owns the default route — that's the one
        // the TV reaches us on. Avoids grabbing a VPN tunnel (10.x) when the
        // user is on Wi-Fi (192.168.x).
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

    next(): void {
        this.currentStep = 2;
    }

    back(): void {
        this.currentStep = 1;
    }

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
            this.modal.close(device);
        } catch (e) {
            this.error = extractMessage(e, 'Failed to connect');
        } finally {
            this.connecting = false;
        }
    }
}
