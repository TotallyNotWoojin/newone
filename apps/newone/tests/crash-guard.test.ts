import { beforeEach, describe, expect, it, jest } from '@jest/globals';

import { describeError, installCrashGuard, resetCrashGuardForTests } from '@/lib/crash-guard';

describe('crash guard', () => {
  beforeEach(() => resetCrashGuardForTests());

  function fakeErrorUtils() {
    const previous = jest.fn();
    let handler: (error: Error, isFatal?: boolean) => void = previous;
    return {
      previous,
      utils: {
        getGlobalHandler: () => handler,
        setGlobalHandler: (next: typeof handler) => { handler = next; },
      },
      fire: (error: Error, isFatal?: boolean) => handler(error, isFatal),
    };
  }

  it('keeps a production fatal error from reaching the aborting default handler and shows its identifier', () => {
    const fake = fakeErrorUtils();
    const alert = jest.fn();
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    installCrashGuard(fake.utils, { development: false, alert });
    fake.fire(new TypeError("Cannot read property 'method' of undefined"), true);
    expect(fake.previous).not.toHaveBeenCalled();
    expect(alert).toHaveBeenCalledWith('Newone hit a problem', "TypeError: Cannot read property 'method' of undefined");
    consoleError.mockRestore();
  });

  it('hands non-fatal errors and development errors to the default handler', () => {
    const fake = fakeErrorUtils();
    const alert = jest.fn();
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    installCrashGuard(fake.utils, { development: false, alert });
    const nonFatal = new Error('soft');
    fake.fire(nonFatal, false);
    expect(fake.previous).toHaveBeenCalledWith(nonFatal, false);
    resetCrashGuardForTests();
    const dev = fakeErrorUtils();
    installCrashGuard(dev.utils, { development: true, alert });
    const fatal = new Error('dev fatal');
    dev.fire(fatal, true);
    expect(dev.previous).toHaveBeenCalledWith(fatal, true);
    expect(alert).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it('describes non-Error throwables', () => {
    expect(describeError('plain string')).toBe('plain string');
    expect(describeError(new RangeError('x'))).toBe('RangeError: x');
  });
});
