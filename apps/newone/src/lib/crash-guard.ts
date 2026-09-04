import { Alert } from 'react-native';

type GlobalHandler = (error: Error, isFatal?: boolean) => void;
type ErrorUtilsLike = { getGlobalHandler(): GlobalHandler; setGlobalHandler(handler: GlobalHandler): void };

let installed = false;

export function describeError(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`.slice(0, 500);
  return String(error).slice(0, 500);
}

/**
 * Release builds abort the whole process on an uncaught JavaScript error
 * (React Native reports it as fatal and the native side calls abort()), and
 * the crash log carries no message. This handler keeps the app alive on a
 * fatal error in production and shows the identifier so a tester can report
 * it; development keeps the default red box.
 */
export function installCrashGuard(
  errorUtils: ErrorUtilsLike | undefined = (globalThis as { ErrorUtils?: ErrorUtilsLike }).ErrorUtils,
  options: { development?: boolean; alert?: (title: string, message: string) => void } = {},
) {
  if (installed || !errorUtils) return;
  installed = true;
  const previous = errorUtils.getGlobalHandler();
  const development = options.development ?? __DEV__;
  const alert = options.alert ?? ((title: string, message: string) => Alert.alert(title, message));
  errorUtils.setGlobalHandler((error, isFatal) => {
    const identifier = describeError(error);
    console.error('[crash-guard]', isFatal ? 'fatal' : 'non-fatal', identifier, error instanceof Error ? error.stack : '');
    if (development || !isFatal) {
      previous(error, isFatal);
      return;
    }
    alert('Newone hit a problem', identifier);
  });
}

export function resetCrashGuardForTests() {
  installed = false;
}
