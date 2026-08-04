// Production web authentication terminates at the Newone BFF and uses an
// HttpOnly, Secure, SameSite cookie. This in-memory adapter deliberately avoids
// persisting a bearer token in localStorage during the standalone client phase.
const values = new Map<string, string>();

export const secureStorage = {
  async getItem(key: string) {
    return values.get(key) ?? null;
  },
  async setItem(key: string, value: string) {
    values.set(key, value);
  },
  async removeItem(key: string) {
    values.delete(key);
  },
};

export const authStorage = secureStorage;
