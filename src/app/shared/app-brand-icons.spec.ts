import {brandIcon, FREETV_PLAIN_ICON} from './app-brand-icons';

/**
 * The ids are the ones the office TVs actually report — a Samsung store id carries a random
 * vendor prefix (`Di0N6xZMEA.disneyplus`), which is why the match is on a brand pattern rather
 * than a table of ids.
 */
describe('brandIcon', () => {
    const cases: ReadonlyArray<[string, string, string]> = [
        ['Disney+', 'Di0N6xZMEA.disneyplus', 'assets/brand-icons/disney-plus.png'],
        ['Netflix', 'org.tizen.netflix-app', 'assets/brand-icons/netflix.png'],
        ['HOT', 'utJFT5dRYB.HOT', 'assets/brand-icons/hot.png'],
        ['STING+', 'xNjDbgVJeT.stingtv', 'assets/brand-icons/sting-plus.png'],
        ['yes+', 'yesPlusApp.yesplus', 'assets/brand-icons/yes-plus.png'],
        ['סלקום tv+', 'cellcomtvApp.cellcom', 'assets/brand-icons/cellcom-tv.png'],
        ['נקסט tv', 'nexttvApp.next', 'assets/brand-icons/next-tv.png'],
        ['פרטנר TV', 'partnerApp.partnertv', 'assets/brand-icons/partner-tv-plus.png'],
    ];

    cases.forEach(([name, id, asset]) => {
        it(`matches ${name}`, () => {
            expect(brandIcon(id, name)).toBe(asset);
        });
    });

    it('gives every FreeTV build the FreeTV artwork, whatever the environment', () => {
        expect(brandIcon('mQW7KpVv5g.FreeTV', 'FreeTV')).toBe(FREETV_PLAIN_ICON);
        expect(brandIcon('kY6012WvBv.FreeTVpreprod', 'Free TV preprod')).toBe(FREETV_PLAIN_ICON);
    });

    it('leaves an app we ship no artwork for to its placeholder', () => {
        expect(brandIcon('org.tizen.browser', 'Internet')).toBeNull();
        expect(brandIcon('3201606009684', 'Spotify')).toBeNull();
    });

    /** `hbomax` contains no `hbo` word boundary issue, but it must not fall through to `hot`. */
    it('prefers the longer brand where two could match', () => {
        expect(brandIcon('com.hbo.hbomax', 'HBO Max')).toBe('assets/brand-icons/hbo-max.png');
    });
});
