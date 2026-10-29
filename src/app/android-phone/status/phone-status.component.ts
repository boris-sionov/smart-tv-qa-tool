import {Component} from '@angular/core';
import {PhoneStateService, phoneName} from '../phone-state.service';

/**
 * What the Apps and Info pages show while there is no usable phone: adb broken, still looking, no
 * phone plugged in, a phone waiting for "Allow USB debugging?", or one still connecting. The
 * pages switch to their content by themselves once the phone is ready.
 */
@Component({
    selector: 'app-phone-status',
    templateUrl: './phone-status.component.html',
    styleUrls: ['../../android-tv/devices/android-tv-devices.component.scss', './phone-status.component.scss'],
})
export class PhoneStatusComponent {
    readonly name = phoneName;

    constructor(public state: PhoneStateService) {}
}
