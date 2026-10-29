import {phoneAppIcon, phoneAppName} from './phone.service';
import {BREW_INSTALL, scrcpyGuide} from './scrcpy-help/scrcpy-help.component';

describe('phoneAppName', () => {
    it('names FreeTV builds by their environment suffix', () => {
        expect(phoneAppName('tv.freetv.mobile.android')).toBe('FreeTV');
        expect(phoneAppName('tv.freetv.mobile.android.uat')).toBe('FreeTV UAT');
    });

    it('names the Mizrahi app and leaves anything else as its id', () => {
        expect(phoneAppName('com.MizrahiTefahot.nh')).toBe('Mizrahi Tefahot — Account');
        expect(phoneAppName('com.example')).toBe('com.example');
        expect(phoneAppIcon('com.MizrahiTefahot.nh')).toBe('bi-bank');
    });
});

describe('scrcpyGuide', () => {
    it('gives each OS its own install command', () => {
        expect(scrcpyGuide('macos').commands.map(c => c.command)).toEqual(['brew install scrcpy']);
        expect(scrcpyGuide('windows').commands.map(c => c.command)).toEqual(['winget install --exact Genymobile.scrcpy']);
        expect(scrcpyGuide('linux').commands.map(c => c.command)).toEqual(['sudo apt install scrcpy']);
    });

    it('installs Homebrew first on a Mac without it', () => {
        expect(scrcpyGuide('macos', false).commands.map(c => c.command)).toEqual([BREW_INSTALL, 'brew install scrcpy']);
    });
});
