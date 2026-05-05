/**
 * Extract a human-readable message from any thrown value.
 *
 * Handles:
 *  - JS Error objects          → e.message
 *  - plain strings             → as-is
 *  - Tauri structured errors   → {reason, message, ...} → e.message
 *  - anything else             → JSON.stringify fallback
 */
export function extractMessage(e: unknown, fallback = 'Unknown error'): string {
    if (!e) return fallback;
    if (e instanceof Error) return e.message || fallback;
    if (typeof e === 'string') return e || fallback;
    if (typeof e === 'object') {
        const obj = e as Record<string, unknown>;
        const msg = obj['message'] ?? obj['reason'] ?? obj['error'];
        if (msg !== undefined) return String(msg) || fallback;
        try { return JSON.stringify(e) || fallback; } catch { return fallback; }
    }
    return String(e) || fallback;
}
