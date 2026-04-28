import {Injectable} from '@angular/core';

@Injectable({providedIn: 'root'})
export class IconCacheService {
    private cache = new Map<string, string>();

    has(key: string): boolean {
        return this.cache.has(key);
    }

    get(key: string): string | undefined {
        return this.cache.get(key);
    }

    set(key: string, value: string): void {
        this.cache.set(key, value);
    }

    delete(key: string): void {
        this.cache.delete(key);
    }

    clear(): void {
        this.cache.clear();
    }
}
