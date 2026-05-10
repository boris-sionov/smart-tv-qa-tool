import {Component} from '@angular/core';
import {Router} from '@angular/router';

@Component({
    selector: 'app-platform-selector',
    templateUrl: './platform-selector.component.html',
    styleUrls: ['./platform-selector.component.scss']
})
export class PlatformSelectorComponent {
    constructor(private router: Router) {}

    openLg(): void {
        this.router.navigate(['/lg']);
    }

    openAndroid(): void {
        this.router.navigate(['/android-tv']);
    }

    openVidaa(): void {
        this.router.navigate(['/vidaa']);
    }
}
