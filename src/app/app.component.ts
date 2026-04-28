import {Component, HostListener} from '@angular/core';
import {Location} from '@angular/common';
import {Router} from '@angular/router';
import {DeviceManagerService} from './core/services';
import {noop} from 'rxjs';

@Component({
  selector: 'app-root',
  templateUrl: './app.component.html',
  styleUrls: ['./app.component.scss']
})
export class AppComponent {

  constructor(
    private deviceManager: DeviceManagerService,
    private location: Location,
    private router: Router,
  ) {
    deviceManager.load();
  }

  @HostListener('window:mousedown', ['$event'])
  onMouseDown(event: MouseEvent): void {
    if (event.button === 3) {
      event.preventDefault();
      this.goBack();
    }
  }

  @HostListener('window:auxclick', ['$event'])
  onAuxClick(event: MouseEvent): void {
    if (event.button === 3) {
      event.preventDefault();
      this.goBack();
    }
  }

  private goBack(): void {
    if (window.history.length > 1) {
      this.location.back();
    } else {
      this.router.navigate(['/']).catch(noop);
    }
  }

}
