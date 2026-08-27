import {Device} from "./device";


export declare interface CrashReportEntry {
  device: Device;
  path: string;
}


export declare interface DevicePrivateKey {
  data: string;
  privatePEM?: string;
}

export declare interface RawPackageInfo {
  id: string;
  type: string;
  title: string;
  appDescription?: string;
  vendor: string;
  version: string;
  folderPath: string;
  icon: string;
  /** Optional higher-resolution icon from `appinfo.json` — what the home screen prefers. */
  largeIcon?: string;
}

/**
 * Where an app lives on the TV:
 * - `developer`: sideloaded into /media/developer (dev mode)
 * - `store`: installed from LG Content Store into /media/cryptofs
 * - `system`: preloaded by LG in /usr/palm
 */
export type PackageSource = 'developer' | 'store' | 'system';

export declare interface PackageInfo extends RawPackageInfo {
  iconUri?: string;
  source?: PackageSource;
  /** `false` for the system stubs the TV's own launcher hides — most of /usr/palm/applications. */
  visible?: boolean;
}

export declare interface StorageInfo {
  total: number;
  used: number;
  available: number;
}
