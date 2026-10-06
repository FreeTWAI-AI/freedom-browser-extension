import { check, fail } from './codec.ts';

/** Closed JSON grammar shared with the reference machine client.
 * Duplicate keys, unsafe integers, arrays and prototype keys are rejected
 * before JSON.parse can collapse them. */
export function parseBoundedJson(text: string): unknown {
  let at = 0;
  let nodes = 0;
  const ws = () => {
    while (at < text.length && ' \t\r\n'.includes(text[at])) at += 1;
  };
  function string(): void {
    const start = at;
    at += 1;
    while (at < text.length) {
      const character = text[at];
      at += 1;
      if (character === '"') {
        JSON.parse(text.slice(start, at));
        return;
      }
      if (character === '\\') at += 1;
    }
    fail('response_invalid');
  }
  function value(depth: number): void {
    check(depth <= 8 && nodes < 128);
    nodes += 1;
    ws();
    if (text[at] === '{') {
      at += 1;
      ws();
      const keys = new Set<string>();
      if (text[at] === '}') {
        at += 1;
        return;
      }
      while (at < text.length) {
        check(text[at] === '"');
        const start = at;
        string();
        const key = JSON.parse(text.slice(start, at)) as string;
        check(!keys.has(key) && key !== '__proto__' && key !== 'constructor' && key !== 'prototype');
        keys.add(key);
        ws();
        check(text[at] === ':');
        at += 1;
        value(depth + 1);
        ws();
        const end = text[at];
        at += 1;
        if (end === '}') return;
        check(end === ',');
        ws();
      }
      fail('response_invalid');
    }
    if (text[at] === '"') {
      string();
      return;
    }
    if (text[at] === '[') fail('response_invalid');
    const match = /^(?:true|false|null|0|[1-9][0-9]*)/.exec(text.slice(at));
    check(match !== null);
    at += match[0].length;
    if (/^[0-9]/.test(match[0])) check(Number.isSafeInteger(Number(match[0])));
  }
  value(0);
  ws();
  check(at === text.length);
  return JSON.parse(text);
}
