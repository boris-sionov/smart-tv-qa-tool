import {Component} from '@angular/core';
import {Router} from '@angular/router';

@Component({
    selector: 'app-vidaa',
    templateUrl: './vidaa.component.html',
    // Same shell as Tizen — navbar, platform chips, nav pills.
    styleUrls: ['../tizen/tizen.component.scss', './vidaa.component.scss'],
})
export class VidaaComponent {
    constructor(private router: Router) {}

    goBack(): void {
        this.router.navigate(['/']);
    }

    open(platform: 'lg' | 'android-tv' | 'tizen' | 'vidaa'): void {
        this.router.navigate(['/' + platform]);
    }
}
