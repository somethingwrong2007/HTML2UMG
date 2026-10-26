// Copyright (c) 2026 FPVSkyline. MIT License.
// Minimal Chrome DevTools Protocol client built on the global WebSocket (Node >= 22).
// No npm dependencies: request table + event waiting are implemented here.
'use strict';

class CDPError extends Error {
  constructor(message, details) {
    super(message);
    this.name = 'CDPError';
    this.details = details;
  }
}

const DEFAULT_TIMEOUT_MS = 30000;

/**
 * A connection to a single CDP endpoint (a page target, in practice).
 * Messages are `{id, method, params}`; answers are matched by id, events are
 * dispatched to listeners.
 */
class CDPConnection {
  constructor(ws, label) {
    this.ws = ws;
    this.label = label || 'page';
    this.nextId = 1;
    this.pending = new Map(); // id -> {resolve, reject, method, timer}
    this.listeners = new Map(); // method -> [handler]
    this.eventHistory = []; // {method, params} for late waiters (bounded)
    this.closed = false;
    this.closeReason = null;
    this.onClose = null;

    ws.addEventListener('message', (event) => this._onMessage(event));
    ws.addEventListener('close', () => this._onClose('socket closed'));
    ws.addEventListener('error', () => this._onClose('socket error'));
  }

  static async connect(wsUrl, options) {
    const opts = options || {};
    const timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;
    const ws = new WebSocket(wsUrl);
    await new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try { ws.close(); } catch (e) { /* ignore */ }
        reject(new CDPError(`CDP: timed out connecting to ${wsUrl}`));
      }, timeoutMs);
      ws.addEventListener('open', () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      });
      ws.addEventListener('error', (event) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new CDPError(`CDP: cannot connect to ${wsUrl} (${event && event.message ? event.message : 'socket error'})`));
      });
    });
    return new CDPConnection(ws, opts.label);
  }

  get open() {
    return !this.closed;
  }

  _onMessage(event) {
    let message;
    if (typeof event.data === 'string') {
      message = event.data;
    } else if (event.data && typeof event.data === 'object' && typeof event.data.text === 'function') {
      // Blob payload (some builds deliver Blobs); read synchronously is not possible,
      // so schedule it. CDP responses are small and ordered.
      event.data.text().then((text) => this._dispatchText(text));
      return;
    } else {
      return;
    }
    this._dispatchText(message);
  }

  _dispatchText(text) {
    let msg;
    try {
      msg = JSON.parse(text);
    } catch (e) {
      return;
    }
    if (msg.id !== undefined) {
      const entry = this.pending.get(msg.id);
      if (!entry) return;
      this.pending.delete(msg.id);
      if (entry.timer) clearTimeout(entry.timer);
      if (msg.error) {
        entry.reject(new CDPError(`${entry.method}: ${msg.error.message || 'protocol error'}`, msg.error));
      } else {
        entry.resolve(msg.result || {});
      }
      return;
    }
    if (msg.method) {
      const record = { method: msg.method, params: msg.params || {} };
      this.eventHistory.push(record);
      if (this.eventHistory.length > 64) this.eventHistory.shift();
      const handlers = this.listeners.get(msg.method);
      if (handlers) {
        for (const handler of handlers.slice()) {
          try {
            handler(record.params);
          } catch (err) {
            // A listener must never break the protocol loop.
          }
        }
      }
    }
  }

  _onClose(reason) {
    if (this.closed) return;
    this.closed = true;
    this.closeReason = reason;
    for (const [, entry] of this.pending) {
      if (entry.timer) clearTimeout(entry.timer);
      entry.reject(new CDPError(`${entry.method}: connection closed (${reason})`));
    }
    this.pending.clear();
    if (this.onClose) {
      try { this.onClose(reason); } catch (e) { /* ignore */ }
    }
  }

  send(method, params, timeoutMs) {
    if (this.closed) {
      return Promise.reject(new CDPError(`${method}: connection is closed (${this.closeReason})`));
    }
    const id = this.nextId;
    this.nextId += 1;
    const effectiveTimeout = timeoutMs || DEFAULT_TIMEOUT_MS;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new CDPError(`${method}: timed out after ${effectiveTimeout}ms`));
      }, effectiveTimeout);
      if (timer.unref) timer.unref();
      this.pending.set(id, { resolve, reject, method, timer });
      try {
        this.ws.send(JSON.stringify({ id, method, params: params || {} }));
      } catch (err) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(new CDPError(`${method}: cannot send (${err.message})`));
      }
    });
  }

  /** Subscribe to a protocol event. Returns an unsubscribe function. */
  on(method, handler) {
    let list = this.listeners.get(method);
    if (!list) {
      list = [];
      this.listeners.set(method, list);
    }
    list.push(handler);
    return () => {
      const index = list.indexOf(handler);
      if (index >= 0) list.splice(index, 1);
    };
  }

  /**
   * Resolve on the next occurrence of `method`. `predicate` filters events.
   * Events already seen *after* the call is made are honoured, but history is
   * consulted so callers cannot lose an event that arrived in the same tick.
   */
  waitForEvent(method, options) {
    const opts = options || {};
    const timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;
    const predicate = opts.predicate || (() => true);
    const historyFloor = this.eventHistory.length;

    return new Promise((resolve, reject) => {
      let done = false;
      const timer = setTimeout(() => {
        if (done) return;
        done = true;
        unsubscribe();
        reject(new CDPError(`event ${method}: timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      if (timer.unref) timer.unref();

      const finish = (params) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        unsubscribe();
        resolve(params);
      };

      const unsubscribe = this.on(method, (params) => {
        if (predicate(params)) finish(params);
      });

      // Replay anything that arrived before this listener was attached.
      for (let i = Math.max(0, historyFloor - 1); i < this.eventHistory.length; i += 1) {
        const record = this.eventHistory[i];
        if (record && record.method === method && predicate(record.params)) {
          finish(record.params);
          break;
        }
      }

      if (this.closed) {
        clearTimeout(timer);
        unsubscribe();
        reject(new CDPError(`event ${method}: connection closed (${this.closeReason})`));
      }
    });
  }

  close() {
    if (this.closed) return;
    try {
      this.ws.close();
    } catch (e) {
      /* ignore */
    }
    this._onClose('closed by client');
  }
}

/**
 * Page-level convenience verbs. Thin wrappers over CDPConnection so the rest of
 * the converter reads like a script instead of raw protocol calls.
 */
class CDPSession {
  constructor(connection, options) {
    this.cdp = connection;
    this.timeoutMs = (options && options.timeoutMs) || DEFAULT_TIMEOUT_MS;
    this.viewport = null;
  }

  static async connect(wsUrl, options) {
    const connection = await CDPConnection.connect(wsUrl, options);
    return new CDPSession(connection, options);
  }

  send(method, params) {
    return this.cdp.send(method, params, this.timeoutMs);
  }

  async enable() {
    await this.send('Page.enable');
    await this.send('Runtime.enable');
    await this.send('Network.enable').catch(() => {});
    // Keep the surface predictable: no throttling, no emulated media quirks.
    await this.send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});
    return this;
  }

  /** Set the design viewport (CSS pixels; device scale forced to 1). */
  async setViewport(width, height) {
    this.viewport = { width: Math.round(width), height: Math.round(height) };
    await this.send('Emulation.setDeviceMetricsOverride', {
      width: this.viewport.width,
      height: this.viewport.height,
      deviceScaleFactor: 1,
      mobile: false,
      screenWidth: this.viewport.width,
      screenHeight: this.viewport.height,
      screenOrientation: { type: 'portraitPrimary', angle: 0 },
    });
    return this.viewport;
  }

  /** Navigate and wait for the load event (or readyState complete as a fallback). */
  async navigate(url, timeoutMs) {
    const effective = timeoutMs || this.timeoutMs;
    const loaded = this.cdp.waitForEvent('Page.loadEventFired', { timeoutMs: effective });
    loaded.catch(() => {});
    const result = await this.send('Page.navigate', { url });
    if (result.errorText) {
      throw new CDPError(`Page.navigate failed: ${result.errorText} (${url})`);
    }
    try {
      await loaded;
    } catch (err) {
      // A load event can be missed on warm navigations; poll readyState instead.
      await this.waitForReadyState('complete', effective);
    }
    return result;
  }

  async waitForReadyState(target, timeoutMs) {
    const effective = timeoutMs || this.timeoutMs;
    const deadline = Date.now() + effective;
    for (;;) {
      const state = await this.evaluate('document.readyState', { awaitPromise: false });
      if (state === target) return true;
      if (Date.now() > deadline) {
        throw new CDPError(`document.readyState never reached "${target}" (now "${state}")`);
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  /**
   * Evaluate an expression in the page and return its value.
   * Expression may return a Promise; awaitPromise is on by default.
   */
  async evaluate(expression, options) {
    const opts = options || {};
    const params = {
      expression,
      returnByValue: opts.returnByValue !== false,
      awaitPromise: opts.awaitPromise !== false,
      userGesture: false,
      allowUnsafeEvalBlockedByCSP: true,
      replMode: false,
    };
    if (opts.contextId !== undefined) params.contextId = opts.contextId;
    const result = await this.send('Runtime.evaluate', params);
    if (result.exceptionDetails) {
      const details = result.exceptionDetails;
      const text = (details.exception && (details.exception.description || details.exception.value)) || details.text || 'evaluation failed';
      throw new CDPError(`Runtime.evaluate threw: ${text}`);
    }
    return result.result ? result.result.value : undefined;
  }

  async screenshot(options) {
    const opts = options || {};
    const params = {
      format: opts.format || 'png',
      fromSurface: opts.fromSurface !== false,
      captureBeyondViewport: opts.captureBeyondViewport === true,
    };
    if (opts.clip) {
      params.clip = {
        x: opts.clip.x,
        y: opts.clip.y,
        width: opts.clip.width,
        height: opts.clip.height,
        scale: opts.clip.scale || 1,
      };
      params.captureBeyondViewport = true;
    }
    if (opts.quality && params.format === 'jpeg') params.quality = opts.quality;
    const result = await this.send('Page.captureScreenshot', params);
    return Buffer.from(result.data, 'base64');
  }

  close() {
    if (this.cdp) this.cdp.close();
  }
}

module.exports = { CDPConnection, CDPSession, CDPError, DEFAULT_TIMEOUT_MS };
