import {Injectable, NgZone} from '@angular/core';
import {BackendClient} from "./backend-client";
import {Device} from "../../types";

@Injectable({
  providedIn: 'root'
})
export class DevModeService extends BackendClient {

  constructor(zone: NgZone) {
    super(zone, "dev-mode");
  }

  private statusCache = new Map<string, DevModeStatus>();

  invalidateStatus(deviceName: string): void {
    this.statusCache.delete(deviceName);
  }

  async status(device: Device): Promise<DevModeStatus> {
    const cached = this.statusCache.get(device.name);
    if (cached) return cached;
    const result = await this.invoke<DevModeStatus>('status', {device});
    this.statusCache.set(device.name, result);
    return result;
  }

  async token(device: Device): Promise<string> {
    return this.invoke('token', {device});
  }
}

export interface DevModeStatus {
  token?: string;
  remaining?: string;
}
