const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function record(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`Invalid ${label}.`);
  }
  return value;
}

function exactKeys(value, keys, label) {
  const expected = new Set(keys);
  if (Object.keys(value).length !== expected.size
    || Object.keys(value).some((key) => !expected.has(key))) {
    throw new TypeError(`Invalid ${label}.`);
  }
}

function uuid(value, label) {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw new TypeError(`Invalid ${label}.`);
  }
  return value;
}

function date(value, label) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    throw new TypeError(`Invalid ${label}.`);
  }
  return value;
}

function nullableBoolean(value, label) {
  if (value === null) return null;
  if (typeof value !== 'boolean') throw new TypeError(`Invalid ${label}.`);
  return value;
}

function nullablePreview(value) {
  if (value === null) return null;
  if (value !== 'generic' && value !== 'hidden') {
    throw new TypeError('Invalid device notification preview override.');
  }
  return value;
}

export function normalizeDeviceNotificationPreferencePatch(value) {
  const input = record(value, 'device notification preference patch');
  const allowed = new Set(['notificationPreview', 'soundEnabled', 'vibrationEnabled']);
  const keys = Object.keys(input);
  if (keys.length === 0 || keys.some((key) => !allowed.has(key))) {
    throw new TypeError('Invalid device notification preference patch.');
  }
  const patch = {};
  if ('notificationPreview' in input) {
    patch.notificationPreview = nullablePreview(input.notificationPreview);
  }
  if ('soundEnabled' in input) {
    patch.soundEnabled = nullableBoolean(input.soundEnabled, 'device sound override');
  }
  if ('vibrationEnabled' in input) {
    patch.vibrationEnabled = nullableBoolean(input.vibrationEnabled, 'device vibration override');
  }
  return patch;
}

export function parseDeviceNotificationPreferences(value) {
  const data = record(value, 'device notification preferences');
  const overrides = record(data.overrides, 'device notification overrides');
  const effective = record(data.effective, 'effective device notification preferences');
  exactKeys(data, [
    'registered',
    'deviceId',
    'installationId',
    'platform',
    'preferenceVersion',
    'overrides',
    'effective',
    'updatedAt',
  ], 'device notification preferences');
  exactKeys(overrides, [
    'notificationPreview',
    'soundEnabled',
    'vibrationEnabled',
  ], 'device notification overrides');
  exactKeys(effective, [
    'notificationPreview',
    'soundEnabled',
    'vibrationEnabled',
  ], 'effective device notification preferences');
  const platform = data.platform;
  if (data.registered !== true || !['ios', 'android', 'web'].includes(platform)) {
    throw new TypeError('Invalid registered device notification preferences.');
  }
  if (!Number.isInteger(data.preferenceVersion) || data.preferenceVersion < 1) {
    throw new TypeError('Invalid device notification preference version.');
  }
  const notificationPreview = nullablePreview(overrides.notificationPreview);
  const soundEnabled = nullableBoolean(overrides.soundEnabled, 'device sound override');
  const vibrationEnabled = nullableBoolean(overrides.vibrationEnabled, 'device vibration override');
  if (!['generic', 'hidden'].includes(effective.notificationPreview)
    || typeof effective.soundEnabled !== 'boolean'
    || typeof effective.vibrationEnabled !== 'boolean'
    || (notificationPreview !== null && effective.notificationPreview !== notificationPreview)
    || (soundEnabled !== null && effective.soundEnabled !== soundEnabled)
    || (vibrationEnabled !== null && effective.vibrationEnabled !== vibrationEnabled)) {
    throw new TypeError('Invalid effective device notification preferences.');
  }
  return {
    registered: true,
    deviceId: uuid(data.deviceId, 'device'),
    installationId: uuid(data.installationId, 'installation'),
    platform,
    preferenceVersion: data.preferenceVersion,
    overrides: { notificationPreview, soundEnabled, vibrationEnabled },
    effective: {
      notificationPreview: effective.notificationPreview,
      soundEnabled: effective.soundEnabled,
      vibrationEnabled: effective.vibrationEnabled,
    },
    updatedAt: date(data.updatedAt, 'device notification preference update time'),
  };
}
