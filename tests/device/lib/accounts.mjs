// Reusing a run's accounts (backlog 76).
//
// Every run mints three fresh people through the sign-up UI. That is the
// slowest part of an area and the flakiest — a groups run died on a signup
// form on Sep 8 2026 without testing anything, and a one-line flow fix cost a
// whole area twice over. A run now writes down who it created, and a later run
// signs those same people back in with the password every simulated signup
// already sets.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const fileFor = (runDir) => join(runDir, 'accounts.json');

export function readAccounts(runDir) {
  const path = fileFor(runDir);
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return {};
  }
}

/** Written as each account is made, so a run interrupted half way is still
 * worth reusing. Keyed by area and label, which is how an area asks for one. */
export function rememberAccount(runDir, area, account) {
  const all = readAccounts(runDir);
  all[`${area}:${account.label}`] = {
    label: account.label,
    email: account.email,
    username: account.username,
    displayName: account.displayName,
    language: account.language,
    userId: account.userId,
  };
  writeFileSync(fileFor(runDir), `${JSON.stringify(all, null, 2)}\n`);
}

/** Only an account that finished signing up is worth signing back in. */
export function findAccount(saved, area, label) {
  const entry = saved?.[`${area}:${label}`];
  return entry?.userId && entry?.email ? entry : null;
}
