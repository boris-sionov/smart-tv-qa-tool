import {Component, OnInit} from '@angular/core';
import {CommonModule} from '@angular/common';
import {NgbActiveModal, NgbModal} from '@ng-bootstrap/ng-bootstrap';
import {platform} from '@tauri-apps/plugin-os';
import {invoke} from '@tauri-apps/api/core';
import {ExternalLinkDirective} from '../../shared/directives';

interface Command {
    label: string;
    command: string;
}

interface InstallGuide {
    os: string;
    shell: string;
    /** Run in order; each gets its own copy button. */
    commands: Command[];
    steps: string[];
    docs: string;
}

const RELEASES = 'https://github.com/Genymobile/scrcpy/releases/latest';
const DOCS = 'https://github.com/Genymobile/scrcpy/blob/master/doc';
/** Homebrew's own install command, as brew.sh gives it. */
export const BREW_INSTALL = '/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"';

/**
 * How to install scrcpy on this computer's OS. On macOS without Homebrew, installing Homebrew
 * comes first. Every link was checked on 2026-10-29.
 */
export function scrcpyGuide(os: string, hasBrew = true): InstallGuide {
    switch (os) {
        case 'windows':
            return {
                os: 'Windows',
                shell: 'Command Prompt',
                commands: [{label: 'Install scrcpy', command: 'winget install --exact Genymobile.scrcpy'}],
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
                commands: [{label: 'Install scrcpy', command: 'sudo apt install scrcpy'}],
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
                commands: [
                    ...(hasBrew ? [] : [{label: 'Homebrew is not installed — install it first', command: BREW_INSTALL}]),
                    {label: 'Install scrcpy', command: 'brew install scrcpy'},
                ],
                steps: [
                    hasBrew
                        ? 'Open Terminal and run the command above.'
                        : 'Open Terminal and run the commands above, in order. Homebrew asks for your Mac password, ' +
                          'and ends with "Next steps": run the lines it prints there, then the scrcpy command.',
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
    hasBrew = true;
    /** The command whose copy button was just pressed. */
    copied: string | null = null;
    readonly releases = RELEASES;

    constructor(public modal: NgbActiveModal) {}

    static open(modalService: NgbModal): Promise<boolean> {
        return modalService.open(ScrcpyHelpComponent, {centered: true})
            .result.then(r => r === true, () => false);
    }

    async ngOnInit(): Promise<void> {
        let os = 'macos';
        try {
            os = platform();
            if (os === 'macos') this.hasBrew = await invoke<boolean>('plugin:adb-manager|brew_installed');
        } catch {
            // Outside Tauri (unit tests) there is no OS plugin; the macOS guide stays.
        }
        this.guide = scrcpyGuide(os, this.hasBrew);
    }

    async copy(command: string): Promise<void> {
        await navigator.clipboard.writeText(command);
        this.copied = command;
        setTimeout(() => this.copied = this.copied === command ? null : this.copied, 1500);
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
