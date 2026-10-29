import {Component, OnInit} from '@angular/core';
import {CommonModule} from '@angular/common';
import {NgbActiveModal, NgbModal} from '@ng-bootstrap/ng-bootstrap';
import {platform} from '@tauri-apps/plugin-os';
import {ExternalLinkDirective} from '../../shared/directives';

interface InstallGuide {
    os: string;
    command: string;
    shell: string;
    steps: string[];
    docs: string;
}

const RELEASES = 'https://github.com/Genymobile/scrcpy/releases/latest';
const DOCS = 'https://github.com/Genymobile/scrcpy/blob/master/doc';

/** How to install scrcpy on this computer's OS. Every link was checked on 2026-10-29. */
export function scrcpyGuide(os: string): InstallGuide {
    switch (os) {
        case 'windows':
            return {
                os: 'Windows',
                shell: 'Command Prompt',
                command: 'winget install --exact Genymobile.scrcpy',
                steps: [
                    'Open Command Prompt and run the command above.',
                    `No winget? Download scrcpy-win64-v….zip from the latest release, extract it to C:\\scrcpy and add that folder to PATH.`,
                    'Close and reopen the Smart TV QA Tool, so it sees the new PATH.',
                ],
                docs: `${DOCS}/windows.md`,
            };
        case 'linux':
            return {
                os: 'Linux',
                shell: 'Terminal',
                command: 'sudo apt install scrcpy',
                steps: [
                    'Run the command above (Debian / Ubuntu). Other distributions: see the install guide.',
                    'Distribution packages can lag behind; the guide also covers the latest release.',
                ],
                docs: `${DOCS}/linux.md`,
            };
        default:
            return {
                os: 'macOS',
                shell: 'Terminal',
                command: 'brew install scrcpy',
                steps: [
                    'Open Terminal and run the command above.',
                    'No Homebrew yet? Install it first from brew.sh, then run the command.',
                ],
                docs: `${DOCS}/macos.md`,
            };
    }
}

/**
 * Shown when "Mirror screen" finds no scrcpy. Closes with `true` on "Try again".
 *
 * scrcpy is the only part to install: the QA tool hands it the adb it ships with.
 */
@Component({
    selector: 'app-scrcpy-help',
    standalone: true,
    imports: [CommonModule, ExternalLinkDirective],
    templateUrl: './scrcpy-help.component.html',
    styleUrls: ['./scrcpy-help.component.scss'],
})
export class ScrcpyHelpComponent implements OnInit {
    guide = scrcpyGuide('macos');
    copied = false;
    readonly releases = RELEASES;

    constructor(public modal: NgbActiveModal) {}

    static open(modalService: NgbModal): Promise<boolean> {
        return modalService.open(ScrcpyHelpComponent, {centered: true})
            .result.then(r => r === true, () => false);
    }

    ngOnInit(): void {
        try {
            this.guide = scrcpyGuide(platform());
        } catch {
            // Outside Tauri (unit tests) there is no OS plugin; the macOS guide stays.
        }
    }

    async copy(): Promise<void> {
        await navigator.clipboard.writeText(this.guide.command);
        this.copied = true;
        setTimeout(() => this.copied = false, 1500);
    }
}

/**
 * Mirrors a phone with scrcpy, walking QA through installing it first when it is missing. Throws
 * scrcpy's own message when it is installed but fails to start.
 */
export async function mirrorPhone(
    phones: {openScrcpy(serial: string, title: string | null): Promise<boolean>},
    modalService: NgbModal,
    serial: string,
    title: string | null,
): Promise<void> {
    while (!await phones.openScrcpy(serial, title)) {
        if (!await ScrcpyHelpComponent.open(modalService)) return;
    }
}
