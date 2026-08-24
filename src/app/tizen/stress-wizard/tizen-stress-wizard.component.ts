import {Component, Input, OnDestroy} from '@angular/core';
import {NgbActiveModal} from '@ng-bootstrap/ng-bootstrap';
import {fetch as tauriFetch} from '@tauri-apps/plugin-http';
import {SdbAppInfo, SdbService} from '../../core/services/sdb.service';
import {TizenDevice} from '../tizen-state.service';

type StressResult = {
    cycle: number;
    pass: boolean;
    timestamp: string;
    title: string;
    channel: string;
    type: string;
    label: string;
    buttons: string[];
};

@Component({
    selector: 'app-tizen-stress-wizard',
    templateUrl: './tizen-stress-wizard.component.html',
    styleUrls: ['./tizen-stress-wizard.component.scss'],
})
export class TizenStressWizardComponent implements OnDestroy {
    @Input() apps: SdbAppInfo[] = [];
    @Input() serial = '';
    @Input() device!: TizenDevice;

    step: 1 | 2 | 3 = 1;

    // Step 1
    selectedApp: SdbAppInfo | null = null;

    // Step 2
    cycles = 2;

    // Step 3
    private readonly READINESS_SELECTOR = 'h1.metadata__title';
    running = false;
    stressStatus = '';
    stressPassCount = 0;
    stressFailCount = 0;
    stressResults: StressResult[] = [];
    stressCountdown = 0;
    stressPhase: '' | 'after-launch' | 'after-kill' = '';
    stressTotalRemaining = 0;
    private stressAbort = false;
    private stressCurrentCycle = 0;
    private stressTotalCycles = 0;
    private stressAfterLaunchSec = 0;
    private stressAfterKillSec = 0;

    constructor(public modal: NgbActiveModal, private sdb: SdbService) {}

    ngOnDestroy(): void {
        this.stressAbort = true;
    }

    // ── Step navigation ────────────────────────────────────────────────────────

    nextStep(): void {
        if (this.step === 1 && this.selectedApp) {
            this.step = 2;
        } else if (this.step === 2) {
            this.step = 3;
            this.stressPassCount = 0;
            this.stressFailCount = 0;
            this.stressResults = [];
            this.stressAbort = false;
            this.runStress();
        }
    }

    prevStep(): void {
        if (this.step === 2) this.step = 1;
    }

    stopTest(): void {
        this.stressAbort = true;
    }

    // ── Stress logic (migrated from TizenAppsComponent) ────────────────────────

    formatDuration(secs: number): string {
        if (secs <= 0) return '0s';
        const h = Math.floor(secs / 3600);
        const m = Math.floor((secs % 3600) / 60);
        const s = secs % 60;
        const parts: string[] = [];
        if (h) parts.push(`${h}h`);
        if (m || h) parts.push(`${m}m`);
        parts.push(`${s}s`);
        return parts.join(' ');
    }

    private toFriendlyType(raw: string): string {
        if (!raw) return '';
        return raw.toUpperCase() === 'PROGRAMME' ? 'Live' : 'VOD';
    }

    private computeTotalRemaining(): number {
        if (!this.running) return 0;
        const cyclesAfterThis = this.stressTotalCycles - this.stressCurrentCycle;
        const perCycle = this.stressAfterLaunchSec + this.stressAfterKillSec;
        let remaining = this.stressCountdown;
        if (this.stressPhase === 'after-launch') remaining += this.stressAfterKillSec;
        remaining += cyclesAfterThis * perCycle;
        return remaining;
    }

    private async runStress(afterLaunchMs = 30_000, afterKillMs = 10_000): Promise<void> {
        const app = this.selectedApp;
        if (!app || !this.serial || !this.device) return;

        const cycles = Math.max(1, Math.floor(this.cycles || 2));
        const serial = this.serial;
        const ip = this.device.ip;
        const id = app.runtimeId || app.id;
        const tizenId = app.tizenId || id;

        this.running = true;
        this.stressTotalCycles = cycles;
        this.stressAfterLaunchSec = Math.ceil(afterLaunchMs / 1000);
        this.stressAfterKillSec   = Math.ceil(afterKillMs  / 1000);

        try {
            this.stressStatus = 'Pre-flight: closing app…';
            await this.sdb.kill(serial, id).catch(e => console.warn('[Stress] preflight kill', e));
            await this.stressWait(3000);

            for (let i = 1; i <= cycles; i++) {
                if (this.stressAbort) break;
                this.stressCurrentCycle = i;

                this.stressStatus = `Cycle ${i}/${cycles}: launching`;
                let debugPort: number | null = null;
                try {
                    debugPort = await this.sdb.debug(serial, tizenId);
                } catch (e) {
                    console.error('[Stress] debug launch failed:', e);
                }
                this.stressPhase = 'after-launch';
                if (await this.stressWait(afterLaunchMs)) break;

                const empty = {found: false, title: '', channel: '', type: '', label: '', buttons: [] as string[]};
                const check = await (debugPort !== null
                    ? this.checkByPort(ip, debugPort, this.READINESS_SELECTOR)
                    : Promise.resolve(empty)
                ).catch(e => { console.warn('[Stress] check failed:', e); return empty; });

                const friendlyType = this.toFriendlyType(check.type);
                if (check.found) this.stressPassCount++; else this.stressFailCount++;
                this.stressResults.push({
                    cycle: i, pass: check.found, timestamp: new Date().toLocaleTimeString(),
                    title: check.title, channel: check.channel,
                    type: friendlyType, label: check.label, buttons: check.buttons,
                });

                this.stressStatus = `Cycle ${i}/${cycles}: ${check.found ? 'PASS' : 'FAIL'} → killing`;
                await this.sdb.kill(serial, id).catch(e => console.error('[Stress] kill', e));
                this.stressPhase = 'after-kill';
                if (i < cycles && await this.stressWait(afterKillMs)) break;
            }

            this.stressStatus = this.stressAbort
                ? `Stopped — pass: ${this.stressPassCount} / fail: ${this.stressFailCount}`
                : `Done — pass: ${this.stressPassCount} / fail: ${this.stressFailCount}`;
        } finally {
            this.running = false;
            this.stressCountdown = 0;
            this.stressPhase = '';
            this.stressTotalRemaining = 0;
        }
    }

    private async checkByPort(
        ip: string, port: number, selector: string,
    ): Promise<{found: boolean, title: string, channel: string, type: string, label: string, buttons: string[]}> {
        const resp = await tauriFetch(`http://${ip}:${port}/json`, {method: 'GET'});
        if (!resp.ok) throw new Error(`devtools /json HTTP ${resp.status}`);
        const targets: Array<{webSocketDebuggerUrl?: string, type?: string, url?: string, title?: string}> = await resp.json();
        const candidates = targets.filter(t => t.type === 'page' && !!t.webSocketDebuggerUrl);
        for (const target of candidates) {
            const wsUrl = target.webSocketDebuggerUrl!
                .replace(/^ws:\/\/(localhost|127\.0\.0\.1)/, `ws://${ip}`);
            try {
                const result = await this.cdpEval(wsUrl, selector);
                if (result.found) return result;
            } catch (e) {
                console.warn('[Stress] CDP eval failed:', e);
            }
        }
        return {found: false, title: '', channel: '', type: '', label: '', buttons: []};
    }

    private cdpEval(wsUrl: string, selector: string): Promise<{found: boolean, title: string, channel: string, type: string, label: string, buttons: string[]}> {
        return new Promise((resolve, reject) => {
            const ws = new WebSocket(wsUrl);
            const timeout = setTimeout(() => { ws.close(); reject(new Error('CDP timeout')); }, 5000);
            const expression = `(() => {
                const sel = ${JSON.stringify(selector)};
                const all = document.querySelectorAll(sel);
                const first = all[0];
                const channelEl = document.querySelector('.metadata__channel-name');
                const labelEl   = document.querySelector('.metadata__item-label');
                const wrap      = document.querySelector('.metadata.wrapper__details');
                const typeClass = wrap ? Array.from(wrap.classList).find(c => c.indexOf('metadata--') === 0) : '';
                const type      = typeClass ? typeClass.replace('metadata--', '') : '';
                const buttons   = Array.from(document.querySelectorAll('.section__bullets .button__title'))
                    .map(b => (b.textContent || '').trim()).filter(t => t.length > 0);
                return {
                    found: all.length > 0,
                    title:   first     ? (first.textContent     || '').trim() : '',
                    channel: channelEl ? (channelEl.textContent || '').trim() : '',
                    label:   labelEl   ? (labelEl.textContent   || '').trim() : '',
                    type, buttons,
                };
            })()`;
            ws.onopen = () => ws.send(JSON.stringify({
                id: 1, method: 'Runtime.evaluate',
                params: {expression, returnByValue: true, awaitPromise: false},
            }));
            ws.onmessage = (ev) => {
                clearTimeout(timeout);
                try {
                    const data = JSON.parse(ev.data);
                    const v = data?.result?.result?.value;
                    if (!v) {
                        resolve({found: false, title: '', channel: '', type: '', label: '', buttons: []});
                    } else {
                        resolve({found: v.found, title: v.title, channel: v.channel, type: v.type, label: v.label, buttons: v.buttons || []});
                    }
                } catch (e) { reject(e); }
                finally { ws.close(); }
            };
            ws.onerror = () => { clearTimeout(timeout); reject(new Error('CDP ws error')); };
        });
    }

    private stressWait(ms: number): Promise<boolean> {
        return new Promise(resolve => {
            const step = 250;
            let elapsed = 0;
            this.stressCountdown = Math.ceil(ms / 1000);
            const timer = setInterval(() => {
                elapsed += step;
                this.stressCountdown = Math.max(0, Math.ceil((ms - elapsed) / 1000));
                this.stressTotalRemaining = this.computeTotalRemaining();
                if (this.stressAbort) {
                    clearInterval(timer);
                    this.stressCountdown = 0;
                    resolve(true);
                } else if (elapsed >= ms) {
                    clearInterval(timer);
                    this.stressCountdown = 0;
                    resolve(false);
                }
            }, step);
        });
    }
}
