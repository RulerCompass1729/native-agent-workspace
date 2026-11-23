const MAX_REQUESTS = 256;
const MAX_RETIRED_IDS = 4096;

function confirmedNative(result) {
  return !result.storageWarning && ['submitted', 'not-sent'].includes(result.status);
}

function admissionError(code) {
  return Object.assign(Error('Mobile request was not admitted'), { code });
}

class ReceiptLedger {
  #rows = new Map();
  #retired = new Map();

  constructor(confirmed) { this.confirmed = confirmed; }
  get(id) { return this.#rows.get(id); }
  retired(id) { return this.#retired.get(id); }
  values() { return this.#rows.values(); }
  clear() { this.#rows.clear(); this.#retired.clear(); }
  release(id, row) { if (this.#rows.get(id) === row) this.#rows.delete(id); }

  #retirable() {
    if (this.#retired.size >= MAX_RETIRED_IDS) return undefined;
    for (const [id, row] of this.#rows) if (this.confirmed(row)) return id;
  }

  assertAvailable() {
    if (this.#rows.size >= MAX_REQUESTS && this.#retirable() === undefined) throw admissionError('MOBILE_PAIR_LIMIT');
  }

  reserve(id, row) {
    if (this.#retired.has(id) || this.#rows.has(id)) throw admissionError('MOBILE_REQUEST_CONFLICT');
    if (this.#rows.size >= MAX_REQUESTS) {
      const retired = this.#retirable();
      if (retired === undefined) throw admissionError('MOBILE_PAIR_LIMIT');
      const previous = this.#rows.get(retired);
      this.#retired.set(retired, previous.result ?? previous);
      this.#rows.delete(retired);
    }
    this.#rows.set(id, row);
  }
}

module.exports = { ReceiptLedger, MAX_REQUESTS, MAX_RETIRED_IDS, confirmedNative };
