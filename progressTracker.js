/**
 * ProgressTracker — single source of truth for scraping job state.
 * Emits 'update' events that the WebSocket layer broadcasts.
 */

import { EventEmitter } from 'events';

export class ProgressTracker extends EventEmitter {
  constructor() {
    super();
    this.reset();
  }

  reset() {
    this.startedAt = null;
    this.totalQueries = 0;
    this.processedQueries = 0;
    this.totalDomains = 0;
    this.processedDomains = 0;
    this.leadsFound = 0;
    this.errors = 0;
    this.currentSector = '';
    this.currentCountry = '';
    this.currentDomain = '';
    this.logs = [];
    this.status = 'idle'; // idle | running | stopping | done
    this._leadsPerMinuteWindow = [];
  }

  start(totalQueries) {
    this.reset();
    this.startedAt = Date.now();
    this.totalQueries = totalQueries;
    this.status = 'running';
    this._emit();
  }

  stop() {
    this.status = 'done';
    this._emit();
  }

  requestStop() {
    this.status = 'stopping';
    this._emit();
  }

  addDomain(count = 1) {
    this.totalDomains += count;
    this._emit();
  }

  completeDomain(found = 0) {
    this.processedDomains += 1;
    if (found > 0) {
      this.leadsFound += found;
      this._leadsPerMinuteWindow.push(Date.now());
    }
    this._emit();
  }

  completeQuery() {
    this.processedQueries += 1;
    this._emit();
  }

  addError() {
    this.errors += 1;
    this._emit();
  }

  setContext(sector, country, domain = '') {
    this.currentSector = sector;
    this.currentCountry = country;
    this.currentDomain = domain;
    this._emit();
  }

  log(level, message) {
    const entry = {
      ts: new Date().toISOString(),
      level, // info | warn | error | success
      message,
    };
    this.logs.push(entry);
    if (this.logs.length > 500) this.logs.shift();
    this.emit('log', entry);
    this._emit();
  }

  get leadsPerMinute() {
    const cutoff = Date.now() - 60_000;
    this._leadsPerMinuteWindow = this._leadsPerMinuteWindow.filter((t) => t > cutoff);
    return this._leadsPerMinuteWindow.length;
  }

  get eta() {
    if (!this.startedAt || this.processedDomains === 0) return null;
    const elapsed = (Date.now() - this.startedAt) / 1000;
    const rate = this.processedDomains / elapsed;
    if (rate === 0 || this.totalDomains === 0) return null;
    const remaining = (this.totalDomains - this.processedDomains) / rate;
    return Math.round(remaining);
  }

  get progressPct() {
    if (this.totalDomains === 0) return 0;
    return Math.round((this.processedDomains / this.totalDomains) * 100);
  }

  snapshot() {
    return {
      status: this.status,
      totalQueries: this.totalQueries,
      processedQueries: this.processedQueries,
      totalDomains: this.totalDomains,
      processedDomains: this.processedDomains,
      leadsFound: this.leadsFound,
      errors: this.errors,
      progressPct: this.progressPct,
      leadsPerMinute: this.leadsPerMinute,
      eta: this.eta,
      currentSector: this.currentSector,
      currentCountry: this.currentCountry,
      currentDomain: this.currentDomain,
      elapsedSeconds: this.startedAt ? Math.round((Date.now() - this.startedAt) / 1000) : 0,
      recentLogs: this.logs.slice(-50),
    };
  }

  _emit() {
    this.emit('update', this.snapshot());
  }
}

export default new ProgressTracker();
