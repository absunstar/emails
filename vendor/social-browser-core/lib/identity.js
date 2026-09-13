'use strict';

class IdentityProviders {
  constructor() {
    this.providers = new Map();
  }

  register(name, provider) {
    if (!name || !provider) throw new Error('Identity provider name and provider are required');
    if (typeof provider === 'function') provider = { load: provider };
    if (typeof provider.load !== 'function') throw new Error('Identity provider must expose load()');
    this.providers.set(String(name), provider);
    return provider;
  }

  unregister(name) {
    return this.providers.delete(String(name));
  }

  has(name) {
    return this.providers.has(String(name));
  }

  get(name) {
    return this.providers.get(String(name)) || null;
  }

  async load(ref, context = {}) {
    if (!ref?.provider) return null;
    const provider = this.get(ref.provider);
    if (!provider) return null;
    return provider.load(ref.id, context);
  }

  async save(ref, user, context = {}) {
    if (!ref?.provider) throw new Error('Identity provider is required');
    const provider = this.get(ref.provider);
    if (!provider?.save) return user;
    return provider.save(ref.id, user, context);
  }

  async clear(ref, context = {}) {
    if (!ref?.provider) return true;
    const provider = this.get(ref.provider);
    if (!provider?.clear) return true;
    return provider.clear(ref.id, context);
  }
}

module.exports = { IdentityProviders };
