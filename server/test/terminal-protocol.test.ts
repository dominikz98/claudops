import { describe, expect, it } from 'vitest';
import { closeReason, decodeClientFrame, parseSizeQuery } from '../src/terminal/protocol.ts';

const text = (value: string) => decodeClientFrame(Buffer.from(value, 'utf8'), false);
const binary = (value: string) => decodeClientFrame(Buffer.from(value, 'utf8'), true);

describe('decodeClientFrame', () => {
  it('takes a binary frame as terminal input', () => {
    expect(binary('ls\r')).toEqual({ kind: 'input', data: Buffer.from('ls\r') });
  });

  it('takes a binary frame that happens to look like JSON as input too', () => {
    // Only the frame type decides -- otherwise pasting JSON into the console
    // would silently disappear.
    expect(binary('{"type":"resize","cols":80,"rows":24}').kind).toBe('input');
  });

  it('reads a resize control message from a text frame', () => {
    expect(text('{"type":"resize","cols":120,"rows":40}')).toEqual({
      kind: 'resize',
      size: { cols: 120, rows: 40 },
    });
  });

  it('takes text that is not JSON as input, which is what makes wscat usable', () => {
    expect(text('ls -la\r')).toEqual({ kind: 'input', data: Buffer.from('ls -la\r') });
  });

  it('takes a JSON scalar or array as input, not as a control message', () => {
    expect(text('42').kind).toBe('input');
    expect(text('"hello"').kind).toBe('input');
    expect(text('[1,2]').kind).toBe('input');
  });

  it('rejects an object without a known type', () => {
    expect(text('{"cols":80}')).toEqual({
      kind: 'invalid',
      message: 'message needs a string type',
    });
    expect(text('{"type":"kill"}')).toEqual({
      kind: 'invalid',
      message: "unknown message type 'kill'",
    });
  });

  it.each([
    ['a missing dimension', '{"type":"resize","cols":80}'],
    ['a zero', '{"type":"resize","cols":0,"rows":24}'],
    ['a fraction', '{"type":"resize","cols":80.5,"rows":24}'],
    ['a number as a string', '{"type":"resize","cols":"80","rows":"24"}'],
    ['a size no terminal has', '{"type":"resize","cols":100000,"rows":24}'],
  ])('rejects a resize with %s', (_case, frame) => {
    expect(text(frame).kind).toBe('invalid');
  });
});

describe('parseSizeQuery', () => {
  it('reads the geometry a client puts in the connect URL', () => {
    expect(parseSizeQuery('120', '40')).toEqual({ cols: 120, rows: 40 });
  });

  it.each([
    ['nothing', undefined, undefined],
    ['only one dimension', '120', undefined],
    ['garbage', 'wide', 'tall'],
    ['an empty string', '', ''],
    ['a size out of range', '120', '99999'],
  ])('ignores %s rather than refusing the connection', (_case, cols, rows) => {
    expect(parseSizeQuery(cols, rows)).toBeUndefined();
  });
});

describe('closeReason', () => {
  it('leaves a short reason alone', () => {
    expect(closeReason('session ended')).toBe('session ended');
  });

  it('keeps a long reason inside the 123 bytes a close frame allows', () => {
    const reason = closeReason('x'.repeat(400));

    expect(Buffer.byteLength(reason, 'utf8')).toBeLessThanOrEqual(123);
  });

  it('cuts multi-byte text without producing a longer replacement character', () => {
    const reason = closeReason('ä'.repeat(200));

    expect(Buffer.byteLength(reason, 'utf8')).toBeLessThanOrEqual(123);
    expect(reason).not.toContain('�');
  });
});
