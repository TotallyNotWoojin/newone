export function assert(condition: unknown, message = 'Assertion failed'): asserts condition {
  if (!condition) throw new Error(message);
}

export function assertEquals(actual: unknown, expected: unknown, message?: string): void {
  const actualJson = JSON.stringify(actual);
  const expectedJson = JSON.stringify(expected);
  if (actualJson !== expectedJson) {
    throw new Error(message ?? `Expected ${expectedJson}, received ${actualJson}`);
  }
}

export async function assertRejects(
  operation: () => unknown | Promise<unknown>,
  predicate?: (error: unknown) => boolean,
  message?: string,
): Promise<void> {
  try {
    await operation();
  } catch (error) {
    if (predicate && !predicate(error)) {
      throw message
        ? new Error(`${message}: ${error instanceof Error ? error.message : String(error)}`)
        : error;
    }
    return;
  }
  throw new Error(message ? `${message}: expected operation to reject` : 'Expected operation to reject');
}
