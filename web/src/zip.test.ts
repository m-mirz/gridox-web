import { describe, expect, it } from 'vitest';
import { zip } from '../tests/zipfile';
import { unzipped } from './zip';

const file = (name: string, data: Uint8Array | string) => new File([typeof data === 'string' ? data : new Uint8Array(data)], name);
const texts = async (files: File[]) => Promise.all(files.map(async (f) => [f.name, await f.text()]));

describe('unzipped', () => {
  it('takes a zip archive XML files out, stored or deflated, in path order, and leaves other files be', async () => {
    const archive = zip(
      [
        { path: 'model/b_SSH.xml', data: '<ssh/>', deflate: true },
        { path: 'model/', data: '' },
        { path: 'model/a_EQ.xml', data: '<eq/>' },
        { path: 'README.txt', data: 'not a model' },
        { path: '__MACOSX/model/._a_EQ.xml', data: 'resource fork' },
      ],
      'written by a test',
    );
    const out = await unzipped([file('first.xml', '<x/>'), file('Model.ZIP', archive)]);
    expect(await texts(out.files)).toEqual([
      ['first.xml', '<x/>'],
      ['a_EQ.xml', '<eq/>'],
      ['b_SSH.xml', '<ssh/>'],
    ]);
    expect(out.paths).toEqual(['first.xml', 'Model.ZIP/model/a_EQ.xml', 'Model.ZIP/model/b_SSH.xml']);
    expect(out.failed).toEqual([]);
  });

  it('opens a zip in a zip', async () => {
    const inner = zip([{ path: 'TP.xml', data: '<tp/>', deflate: true }]);
    const outer = zip([{ path: 'igm/inner.zip', data: inner }, { path: 'EQ.xml', data: '<eq/>' }]);
    const out = await unzipped([file('cgm.zip', outer)]);
    expect(await texts(out.files)).toEqual([
      ['EQ.xml', '<eq/>'],
      ['TP.xml', '<tp/>'],
    ]);
    expect(out.paths).toEqual(['cgm.zip/EQ.xml', 'cgm.zip/igm/inner.zip/TP.xml']);
  });

  it('says which archives it could not read, and keeps the rest', async () => {
    const out = await unzipped([file('broken.zip', 'PK, but no more'), file('EQ.xml', '<eq/>')]);
    expect(out.files.map((f) => f.name)).toEqual(['EQ.xml']);
    expect(out.failed).toEqual([{ name: 'broken.zip', reason: 'the archive could not be read (not a zip archive)' }]);
  });
});
