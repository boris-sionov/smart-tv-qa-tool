import {TizenPrereqCheck, TizenPrerequisites} from '../../../core/services/sdb.service';

/** The last requirements check, so the list opens at once and a new check can say what changed. */
export interface SavedCheck {
    /** When it ran, in ms since the epoch. */
    at: number;
    result: TizenPrerequisites;
}

const KEY = 'smart-tv-qa-tizen-requirements';

export function loadSavedCheck(): SavedCheck | null {
    try {
        const saved = JSON.parse(localStorage.getItem(KEY) ?? 'null') as SavedCheck | null;
        return saved && Array.isArray(saved.result?.checks) ? saved : null;
    } catch {
        return null;
    }
}

export function saveCheck(result: TizenPrerequisites, at = Date.now()): SavedCheck {
    const saved = {at, result};
    try {
        localStorage.setItem(KEY, JSON.stringify(saved));
    } catch {
        // Not saving only costs the instant list next time.
    }
    return saved;
}

/**
 * The rows of `next` that differ from `previous`, keyed by id, with the row as it was — `null` for
 * a row the previous check did not have. Nothing when there was no previous check.
 */
export function changedChecks(previous: TizenPrerequisites | null, next: TizenPrerequisites): Map<string, TizenPrereqCheck | null> {
    const changed = new Map<string, TizenPrereqCheck | null>();
    if (!previous) return changed;
    for (const check of next.checks) {
        const before = previous.checks.find(c => c.id === check.id) ?? null;
        if (!before || before.status !== check.status || before.detail !== check.detail) {
            changed.set(check.id, before);
        }
    }
    return changed;
}
