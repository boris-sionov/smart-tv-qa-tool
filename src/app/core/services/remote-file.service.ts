import {Injectable, NgZone} from "@angular/core";
import {BackendClient, BackendError} from "./backend-client";
import {Device, DeviceLike, FileItem} from "../../types";
import {Buffer} from "buffer";
import {RemoteCommandService} from "./remote-command.service";
import {finalize, firstValueFrom, lastValueFrom, Observable, Subject} from "rxjs";
import {EventChannel} from "../event-channel";
import {map} from "rxjs/operators";
import {ProgressCallback, progressChannel} from "./progress-callback";

/** Separates the base64 payloads in a `readMany` batch — must not occur in a file path. */
const READ_MANY_MARKER = '@@stvqa-file@@';

@Injectable({
    providedIn: 'root'
})
export class RemoteFileService extends BackendClient {

    constructor(zone: NgZone, private cmd: RemoteCommandService) {
        super(zone, 'remote-file');
    }

    public async ls(device: Device, path: string): Promise<FileItem[]> {
        return this.invoke<FileItem[]>('ls', {device, path});
    }

    public async rm(device: Device, path: string, recursive: boolean): Promise<void> {
        await this.cmd.exec(device, `xargs -0 rm ${recursive ? '-r' : ''}`, 'buffer', path);
    }

    public async read(device: DeviceLike, path: string, encoding?: 'gzip', output?: 'buffer'): Promise<Buffer>;
    public async read(device: DeviceLike, path: string, encoding?: 'gzip', output?: 'utf-8'): Promise<string>;

    public async read(device: DeviceLike, path: string, encoding?: 'gzip', output?: 'buffer' | 'utf-8'): Promise<Buffer | string> {
        const outputData = Buffer.from(await this.invoke<Buffer>('read', {device, path, encoding}));
        switch (output) {
            case 'utf-8':
                return outputData.toString('utf-8');
            default:
                return outputData;
        }
    }

    /**
     * Reads many small files in a single SSH command.
     *
     * One `read` is one SFTP channel open plus a round trip, and the app list needs an icon for
     * every row — on a TV that is seconds of latency for a few hundred kilobytes. This base64s
     * whatever exists in one exec instead. Paths that are missing or unreadable are simply absent
     * from the result, so the caller can fall back to `read` for those.
     */
    public async readMany(device: DeviceLike, paths: string[]): Promise<Map<string, Buffer>> {
        const result = new Map<string, Buffer>();
        const wanted = [...new Set(paths.filter(Boolean))];
        if (!wanted.length) return result;

        const quoted = wanted.map(path => `'${path.replace(/'/g, `'\\''`)}'`).join(' ');
        // base64 reads stdin rather than a file argument — BSD base64 has no positional form, and
        // the marker is only printed once the encode succeeded, so a TV without base64 yields an
        // empty result instead of error text decoded as image data.
        const command = `for p in ${quoted}; do ` +
            `if [ -r "$p" ]; then b="$(base64 < "$p" 2>/dev/null)"; ` +
            `if [ -n "$b" ]; then echo "${READ_MANY_MARKER}$p"; echo "$b"; fi; fi; done; true`;
        const output = await this.cmd.exec(device, command, 'utf-8');

        for (const chunk of output.split(READ_MANY_MARKER).slice(1)) {
            const breakAt = chunk.indexOf('\n');
            if (breakAt < 0) continue;
            const path = chunk.substring(0, breakAt).trim();
            const encoded = chunk.substring(breakAt + 1).replace(/\s+/g, '');
            if (!path || !encoded) continue;
            try {
                result.set(path, Buffer.from(encoded, 'base64'));
            } catch (e) {
                console.warn(`readMany: undecodable payload for ${path}`, e);
            }
        }
        return result;
    }

    public async write(device: Device, path: string, content?: string | Uint8Array): Promise<void> {
        await this.invoke('write', {device, path, content});
    }

    public async get(device: Device, path: string, target: string, progress?: ProgressCallback): Promise<void> {
        const onProgress = progressChannel(progress);
        await this.invoke('get', {device, path, target, onProgress});
    }

    public async put(device: Device, path: string, source: string, progress?: ProgressCallback): Promise<void> {
        const onProgress = progressChannel(progress);
        await this.invoke('put', {device, path, source, onProgress});
    }

    public async mkdir(device: Device, path: string): Promise<void> {
        await this.cmd.exec(device, `xargs -0 mkdir`, 'buffer', path);
    }

    public async getTemp(device: Device, path: string, progress?: ProgressCallback): Promise<string> {
        const onProgress = progressChannel(progress);
        return await this.invoke<string>('get_temp', {device, path, onProgress});
    }

    public async serveLocal(device: Device, localPath: string): Promise<ServeInstance> {
        const subject = new Subject<Record<string, any>>();
        const token = await this.invoke<string>('serve', {device, path: localPath});
        const call = `${this.category}/serveLocal`;
        const channel = new class extends EventChannel<Record<string, any>, any> {
            constructor(token: string) {
                super(token);
            }

            onClose(payload: any): void {
                console.log('serve closed', payload);
                if (payload) {
                    if (BackendError.isCompatibleBody(payload)) {
                        subject.error(new BackendError(payload, call));
                    } else {
                        subject.error(payload);
                    }
                } else {
                    subject.complete();
                }
            }

            onReceive(payload: Record<string, any>): void {
                subject.next(payload);
            }
        }(token);
        await channel.send();
        return firstValueFrom(subject).then((v: Record<string, any>): ServeInstance => {
            return {
                host: v['host'],
                requests: subject.pipe(map(v => v as ServeRequest), finalize(() => channel.unlisten())),
                async interrupt(): Promise<void> {
                    await channel.close();
                    await lastValueFrom(subject).catch(e => {
                        if (e.name === 'EmptyError') {
                            return null;
                        } else {
                            throw e
                        }
                    });
                },
            }
        }).catch(e => {
            channel.unlisten();
            throw e;
        });
    }

}

export declare interface ServeInstance {
    host: string;
    requests: Observable<ServeRequest>;

    interrupt(): Promise<void>;
}

export declare interface ServeRequest {
    path: string;
    status: 200 | 404;
}
