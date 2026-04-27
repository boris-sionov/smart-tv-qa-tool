import { Component, OnInit, OnDestroy } from '@angular/core';
import { AdbStateService, SavedDevice } from '../../../android-tv/adb-state.service';
import { Subscription } from 'rxjs';

@Component({
  selector: 'app-environment-marker',
  templateUrl: './environment-marker.component.html',
  styleUrls: ['./environment-marker.component.scss']
})
export class EnvironmentMarkerComponent implements OnInit, OnDestroy {
  environment: string | null = null;
  private sub?: Subscription;

  constructor(private state: AdbStateService) {}

  ngOnInit(): void {
    this.sub = this.state.selected$.subscribe((dev: SavedDevice | null) => {
      if (!dev) {
        this.environment = null;
        return;
      }

      // Detect environment from device properties
      const deviceName = dev.name.toLowerCase();

      if (deviceName.includes('uat')) {
        this.environment = 'UAT';
      } else if (deviceName.includes('staging') || deviceName.includes('stg')) {
        this.environment = 'STG';
      } else {
        this.environment = null;
      }
    });
  }

  ngOnDestroy(): void {
    this.sub?.unsubscribe();
  }
}
