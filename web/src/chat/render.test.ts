import { describe, expect, it } from 'vitest';
import { pieces } from './render';

describe('pieces', () => {
  it('links objects by their mRID', () => {
    expect(pieces('Line [L1](#object:_abc-1) is out.')).toEqual([
      { type: 'text', text: 'Line ' },
      { type: 'object', text: 'L1', id: '_abc-1' },
      { type: 'text', text: ' is out.' },
    ]);
  });

  it('keeps code and bold, and links out only over http', () => {
    expect(pieces('**Note** `x` [a](https://e.org) [b](javascript:alert(1))')).toEqual([
      { type: 'bold', text: 'Note' },
      { type: 'text', text: ' ' },
      { type: 'code', text: 'x' },
      { type: 'text', text: ' ' },
      { type: 'link', text: 'a', href: 'https://e.org' },
      { type: 'text', text: ' ' },
      { type: 'text', text: '[b](javascript:alert(1)' },
      { type: 'text', text: ')' },
    ]);
  });

  it('leaves plain text whole', () => {
    expect(pieces('no links\nhere')).toEqual([{ type: 'text', text: 'no links\nhere' }]);
  });
});
