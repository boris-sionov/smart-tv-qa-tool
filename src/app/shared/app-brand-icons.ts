import {isPriorityApp} from './known-apps';

/**
 * Bundled artwork for the OTT apps QA tracks, matched on an app's id and title.
 *
 * webOS reads an app's real icon off the TV over SFTP. Tizen cannot: a retail Samsung TV answers
 * `You cannot pull files from this path` for `/opt/share/webappservice/apps_icon/`, and its `sdb
 * shell` is the restricted `vd_*` one with no `cat`. So our list shows bundled artwork instead —
 * the same approach the Android TV list takes, and the closest thing to the webOS behaviour that
 * a Samsung TV allows.
 *
 * Matched on patterns rather than an id table because the ids differ per platform and per store
 * listing — `Di0N6xZMEA.disneyplus` on one Samsung TV, `com.disneyplus` on Android TV — while the
 * brand in the id or the title does not. Order matters: the longer brands are tested before the
 * substrings they contain.
 */
const BRAND_ICONS: ReadonlyArray<[RegExp, string]> = [
    [/hbo\.?max|warnermedia/i, 'assets/brand-icons/hbo-max.png'],
    [/disney/i, 'assets/brand-icons/disney-plus.png'],
    [/netflix|נטפליקס/i, 'assets/brand-icons/netflix.png'],
    [/sting\.?tv|\bsting\b|סטינג/i, 'assets/brand-icons/sting-plus.png'],
    [/yes\.?plus|yesplus|\byes\b|(?:^|[^א-ת])יס(?![א-ת])/i, 'assets/brand-icons/yes-plus.png'],
    [/partner\.?tv|partnertv|\bpartner\b|פרטנר/i, 'assets/brand-icons/partner-tv-plus.png'],
    [/cellcom\.?tv|cellcomtv|\bcellcom\b|סלקום/i, 'assets/brand-icons/cellcom-tv.png'],
    [/next\.?tv|nexttv|\bnext\b|נקסט/i, 'assets/brand-icons/next-tv.png'],
    [/\bhot\b|הוט/i, 'assets/brand-icons/hot.png'],
    [/kan\.?11|\bkan\b|כאן/i, 'assets/brand-icons/kan-11.png'],
    [/thirteen|רשת\s*13|\b13\b/i, 'assets/brand-icons/thirteen-plus.png'],
];

/** The unbadged FreeTV artwork, for a build with no environment of its own — the store one. */
export const FREETV_PLAIN_ICON = 'assets/tizen-icons/freetv-tizen-base-icon.png';

/**
 * Bundled artwork for an app, or `null` when we ship none and the row keeps its placeholder.
 *
 * FreeTV is checked first and separately: every FreeTV build shares one brand but they are the
 * builds whose icons most need telling apart, so the caller badges them by environment rather
 * than dropping the plain logo on all of them.
 */
export function brandIcon(...fields: (string | null | undefined)[]): string | null {
    if (isPriorityApp(...fields)) return FREETV_PLAIN_ICON;
    for (const [pattern, asset] of BRAND_ICONS) {
        if (fields.some(field => !!field && pattern.test(field))) return asset;
    }
    return null;
}
