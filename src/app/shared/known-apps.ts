/**
 * Sorting and environment helpers shared by the Tizen, LG and Android TV app lists.
 *
 * The brand whitelist that used to live here (`isKnownApp`) filtered those lists down to the
 * brands QA tracks, and hid everything else the TV had installed. The lists now show every app
 * and nothing matches on brand except the FreeTV-first sort below.
 */

/** FreeTV sorts above everything else. */
export const PRIORITY_APP_PATTERN = /freetv|free tv/i;

function matches(pattern: RegExp, fields: (string | null | undefined)[]): boolean {
    return fields.some(field => !!field && pattern.test(field));
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
