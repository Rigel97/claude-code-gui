class SessionOwnership {
  #owners = new Map();

  acquire(sessionId, ownerObj) {
    if (typeof sessionId !== 'string' || !sessionId || !ownerObj || typeof ownerObj !== 'object') {
      throw new TypeError('Session ID and an owner object are required');
    }
    if (this.#owners.has(sessionId)) throw new Error('Session is already owned by a live process');
    const lease = { owner: ownerObj };
    this.#owners.set(sessionId, lease);
    return () => {
      if (this.#owners.get(sessionId) === lease) this.#owners.delete(sessionId);
    };
  }

  owner(sessionId) { return this.#owners.get(sessionId)?.owner; }

  releaseOwner(ownerObj) {
    for (const [id, lease] of this.#owners) {
      if (lease.owner === ownerObj) this.#owners.delete(id);
    }
  }
}

module.exports = { SessionOwnership };
