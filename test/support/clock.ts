export function createClock(start = Date.parse('2026-10-06T00:00:00.000Z')) {
  let current = start;
  return {
    now: () => current,
    set(ms: number) {
      current = ms;
    },
    advance(ms: number) {
      current += ms;
    },
  };
}

export type TestClock = ReturnType<typeof createClock>;
