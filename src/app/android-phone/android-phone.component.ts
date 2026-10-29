import {Component} from '@angular/core';
import {Router} from '@angular/router';

/** The Android Phone shell: platform switcher on top, the phone list or one phone's apps below. */
@Component({
    selector: 'app-android-phone',
    templateUrl: './android-phone.component.html',
    styleUrls: ['../android-tv/android-tv.component.scss'],
})
export class AndroidPhoneComponent {

    constructor(private router: Router) {}

    go(path: string): void {
        void this.router.navigate([path]);
    }
}
