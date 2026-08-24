import {Component} from '@angular/core';
import {Router} from '@angular/router';
import {APP_VERSION} from '../core/build-info';

@Component({
    selector: 'app-platform-selector',
    templateUrl: './platform-selector.component.html',
    styleUrls: ['./platform-selector.component.scss']
})
export class PlatformSelectorComponent {
    readonly appVersion = APP_VERSION;

    constructor(private router: Router) {}

    openLg(): void {
        this.router.navigate(['/lg']);
    }

    openAndroid(): void {
        this.router.navigate(['/android-tv']);
    }

    openTizen(): void {
        this.router.navigate(['/tizen']);
    }

}
