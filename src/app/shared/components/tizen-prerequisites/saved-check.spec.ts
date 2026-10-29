import {TizenPrereqCheck, TizenPrerequisites} from '../../../core/services/sdb.service';
import {changedChecks, loadSavedCheck, saveCheck} from './saved-check';

function check(id: string, detail = 'v1', status: TizenPrereqCheck['status'] = 'ok'): TizenPrereqCheck {
    return {id, label: id, status, detail, hint: null};
}

function result(...checks: TizenPrereqCheck[]): TizenPrerequisites {
    return {checks, studioPath: '/s', os: 'macos', arch: 'aarch64'};
}

describe('changedChecks', () => {
    it('reports nothing without a previous check', () => {
        expect(changedChecks(null, result(check('sdb'))).size).toBe(0);
    });

    it('reports a new version, a new status and a new row, with what was there before', () => {
        const before = result(check('sdb'), check('studio'), check('java'));
        const after = result(check('sdb', 'v2'), check('studio', 'v1', 'fail'), check('java'), check('studio-sdb', 'x', 'fail'));
        const changed = changedChecks(before, after);
        expect([...changed.keys()]).toEqual(['sdb', 'studio', 'studio-sdb']);
        expect(changed.get('sdb')?.detail).toBe('v1');
        expect(changed.get('studio')?.status).toBe('ok');
        expect(changed.get('studio-sdb')).toBeNull();
    });
});

describe('saved check', () => {
    afterEach(() => localStorage.removeItem('smart-tv-qa-tizen-requirements'));

    it('reads back what was saved', () => {
        saveCheck(result(check('sdb')), 1000);
        expect(loadSavedCheck()).toEqual({at: 1000, result: result(check('sdb'))});
    });

    it('ignores a broken entry', () => {
        localStorage.setItem('smart-tv-qa-tizen-requirements', '{"at":1}');
        expect(loadSavedCheck()).toBeNull();
    });
});
