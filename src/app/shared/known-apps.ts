/**
 * The apps QA actually tracks — any environment variant of these brands.
 *
 * Shared by the Tizen and LG app lists. Android TV keeps its own copy as an explicit package-id
 * allowlist in `src-tauri/src/plugins/adb.rs` (`app_name`), because that filtering happens in Rust.
 *
 * The Hebrew aliases matter on webOS, where the TV reports localized titles ("סלקום TV") and the
 * app id is not always the brand name. `יס` is short enough to appear inside other Hebrew words,
 * so it is fenced with Hebrew-letter guards — written without lookbehind, which not every webview
 * we ship on supports.
 */
export const KNOWN_APP_PATTERN =
    /freetv|stingtv|sting\.tv|\bsting\b|yesplus|yes\.plus|\byes\b|partnertv|partner\.tv|\bpartner\b|cellcomtv|cellcom\.tv|\bcellcom\b|\bhot\b|nexttv|next\.tv|\bnext\b|disney|netflix|hbomax|hbo\.max|\bhbo\b|warnermedia|הוט|נקסט|(?:^|[^א-ת])יס(?![א-ת])|סטינג|פרטנר|סלקום|נטפליקס|דיסני/i;

/** FreeTV sorts above everything else. */
export const PRIORITY_APP_PATTERN = /freetv|free tv/i;

function matches(pattern: RegExp, fields: (string | null | undefined)[]): boolean {
    return fields.some(field => !!field && pattern.test(field));
}

export function isKnownApp(...fields: (string | null | undefined)[]): boolean {
    return matches(KNOWN_APP_PATTERN, fields);
}

export function isPriorityApp(...fields: (string | null | undefined)[]): boolean {
    return matches(PRIORITY_APP_PATTERN, fields);
}

/**
 * Which build of an app this is, read off its id/title — `tv.freetv.portal.preprodtest` is the
 * PreProd Test build, `…androidtv.stg` is Staging, and so on. Order matters: the longer markers
 * have to be tested before the substrings they contain.
 */
const ENVIRONMENTS: ReadonlyArray<[RegExp, string]> = [
    [/preprod[._-]?test/i, 'PreProd Test'],
    [/preprod/i, 'PreProd'],
    [/prod[._-]?(for|on)[._-]?uat/i, 'Prod on UAT'],
    [/\buat\b|[._-]uat\b/i, 'UAT'],
    [/staging|[._-]stg\b|\bstg\b/i, 'Staging'],
    [/\bqa\b|[._-]qa\b/i, 'QA'],
    [/\bdebug\b/i, 'Debug'],
    [/\btest\b|[._-]test\b/i, 'Test'],
    [/\bprod\b|[._-]prod\b/i, 'Prod'],
];

export function appEnvironment(...fields: (string | null | undefined)[]): string | null {
    for (const [pattern, label] of ENVIRONMENTS) {
        if (matches(pattern, fields)) return label;
    }
    return null;
}
