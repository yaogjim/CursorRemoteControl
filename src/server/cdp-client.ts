import { WebSocket } from 'ws';
import { EventEmitter } from 'events';
import { connect as netConnect, type Socket } from 'net';

const DEFAULT_TIMEOUT_MS = 10000;

interface CdpMessage {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: { code: number; message: string; data?: string };
}

interface PendingCall {
  resolve: (value: Record<string, unknown>) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Lightweight CDP client that connects directly to a page target's
 * WebSocket endpoint. Avoids the browser-level Target.getBrowserContexts
 * call that Electron/Cursor blocks.
 */
export class CdpClient extends EventEmitter {
  private ws: WebSocket | null = null;
  private nextId = 1;
  private pending = new Map<number, PendingCall>();
  private _connected = false;
  private connectTimer: ReturnType<typeof setTimeout> | null = null;
  private connectWaiter: { resolve: () => void; reject: (err: Error) => void } | null = null;
  private handshakeSocket: Socket | null = null;

  /**
   * Open a WebSocket to a page target. `timeoutMs` bounds the handshake;
   * a new connect() tears down any in-flight or leftover socket first.
   */
  async connect(wsUrl: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<void> {
    this.resetConnection('Superseded by new connect');

    return new Promise((resolve, reject) => {
      this.connectWaiter = { resolve, reject };
      this.handshakeSocket = null;
      this.ws = new WebSocket(wsUrl, {
        // Own the TCP socket so timed-out / superseded handshakes can be
        // destroyed. ws.terminate() uses request.abort(), which on recent
        // Node leaves CONNECTING sockets open.
        createConnection: ((opts: import('net').NetConnectOpts, listener?: () => void) => {
          const { host, port } = opts as { host: string; port: number | string };
          const socket = netConnect({ host, port: Number(port) }, listener);
          this.handshakeSocket = socket;
          return socket;
        }) as typeof netConnect,
      });

      this.connectTimer = setTimeout(() => {
        this.failConnect(new Error(`CDP WebSocket connect timeout (${timeoutMs}ms)`));
      }, timeoutMs);

      this.ws.on('open', () => {
        if (!this.connectWaiter) return;
        this.clearConnectTimer();
        this._connected = true;
        const waiter = this.connectWaiter;
        this.connectWaiter = null;
        waiter.resolve();
      });

      this.ws.on('error', (err) => {
        if (!this._connected) {
          this.failConnect(err instanceof Error ? err : new Error(String(err)));
        } else {
          console.error('[cdp-client] WebSocket error:', err.message);
        }
      });

      this.ws.on('message', (data) => {
        this.handleMessage(data.toString());
      });

      this.ws.on('close', () => {
        const wasConnected = this._connected;
        if (!wasConnected && this.connectWaiter) {
          this.failConnect(new Error('WebSocket closed before open'));
          return;
        }
        this._connected = false;
        this.rejectAllPending('WebSocket closed');
        this.ws = null;
        if (wasConnected) {
          this.emit('disconnected');
        }
      });
    });
  }

  disconnect(): void {
    this.resetConnection('Intentional disconnect');
  }

  isConnected(): boolean {
    return this._connected;
  }

  /**
   * Send a raw CDP command and wait for the response.
   */
  async send(
    method: string,
    params?: Record<string, unknown>,
    timeoutMs = DEFAULT_TIMEOUT_MS
  ): Promise<Record<string, unknown>> {
    if (!this.ws || !this._connected) {
      throw new Error('CDP client not connected');
    }

    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP timeout for ${method} (${timeoutMs}ms)`));
      }, timeoutMs);

      this.pending.set(id, { resolve, reject, timer });
      this.ws!.send(JSON.stringify({ id, method, params }));
    });
  }

  /**
   * Evaluate a JavaScript expression in the page context.
   * Returns the deserialized value.
   */
  async evaluate(expression: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<unknown> {
    const result = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    }, timeoutMs);

    const exceptionDetails = result.exceptionDetails as
      | { text?: string; exception?: { description?: string } }
      | undefined;
    if (exceptionDetails) {
      const msg = exceptionDetails.exception?.description
        ?? exceptionDetails.text
        ?? 'Evaluation failed';
      throw new Error(msg);
    }

    const remoteObj = result.result as { value?: unknown } | undefined;
    return remoteObj?.value;
  }

  /**
   * Serialize a function and its arguments, then evaluate in the page context.
   * The function must be self-contained (no closures over Node.js variables).
   *
   * Injects a __name shim because tsx/esbuild wraps named functions with
   * __name() calls that don't exist in the target page context.
   */
  async callFunction(
    fn: (...args: never[]) => unknown,
    ...args: unknown[]
  ): Promise<unknown> {
    const argStr = args.map(a => JSON.stringify(a)).join(', ');
    const shim = 'var __name = function(fn, _n){ return fn; };';
    const expression = `${shim}(${fn.toString()})(${argStr})`;
    return this.evaluate(expression);
  }

  async callFunctionWithTimeout(
    fn: (...args: never[]) => unknown,
    args: unknown[],
    timeoutMs: number
  ): Promise<unknown> {
    const argStr = args.map(a => JSON.stringify(a)).join(', ');
    const shim = 'var __name = function(fn, _n){ return fn; };';
    const expression = `${shim}(${fn.toString()})(${argStr})`;
    return this.evaluate(expression, timeoutMs);
  }

  /**
   * Click an element identified by a CSS selector.
   * Uses evaluate to scroll into view then dispatches a click event.
   */
  async click(selector: string): Promise<void> {
    const clicked = await this.evaluate(`
      (() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return false;
        el.scrollIntoView({ block: 'center', behavior: 'instant' });
        el.click();
        return true;
      })()
    `);
    if (!clicked) {
      throw new Error(`Element not found: ${selector}`);
    }
  }

  /**
   * Focus an element identified by a CSS selector.
   */
  async focus(selector: string): Promise<void> {
    const focused = await this.evaluate(`
      (() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return false;
        el.focus();
        return true;
      })()
    `);
    if (!focused) {
      throw new Error(`Element not found for focus: ${selector}`);
    }
  }

  /**
   * Dispatch a key event (keyDown, keyUp, char) via the Input domain.
   */
  async dispatchKeyEvent(
    type: 'keyDown' | 'keyUp' | 'char',
    options: {
      key?: string;
      code?: string;
      text?: string;
      unmodifiedText?: string;
      windowsVirtualKeyCode?: number;
      nativeVirtualKeyCode?: number;
      modifiers?: number;
    } = {}
  ): Promise<void> {
    await this.send('Input.dispatchKeyEvent', { type, ...options });
  }

  /**
   * Insert text using Input.insertText — single CDP call, no double-character issues.
   */
  async typeText(text: string, _delayMs = 0): Promise<void> {
    await this.send('Input.insertText', { text });
  }

  /**
   * Press a special key (Enter, Backspace, etc.).
   */
  async pressKey(
    key: string,
    code: string,
    keyCode: number,
    modifiers = 0
  ): Promise<void> {
    await this.dispatchKeyEvent('keyDown', {
      key,
      code,
      windowsVirtualKeyCode: keyCode,
      nativeVirtualKeyCode: keyCode,
      modifiers,
    });
    await this.dispatchKeyEvent('keyUp', {
      key,
      code,
      windowsVirtualKeyCode: keyCode,
      nativeVirtualKeyCode: keyCode,
      modifiers,
    });
  }

  /**
   * Click a viewport coordinate using native CDP mouse events.
   */
  async clickAtCoords(x: number, y: number): Promise<void> {
    await this.send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x,
      y,
      button: 'left',
      clickCount: 1,
    });
    await this.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x,
      y,
      button: 'left',
      clickCount: 1,
    });
  }

  /**
   * Check if an element exists in the page.
   */
  async exists(selector: string): Promise<boolean> {
    return (await this.evaluate(
      `document.querySelector(${JSON.stringify(selector)}) !== null`
    )) as boolean;
  }

  private handleMessage(raw: string): void {
    let msg: CdpMessage;
    try {
      msg = JSON.parse(raw) as CdpMessage;
    } catch {
      return;
    }

    if (msg.id !== undefined && this.pending.has(msg.id)) {
      const pending = this.pending.get(msg.id)!;
      this.pending.delete(msg.id);
      clearTimeout(pending.timer);

      if (msg.error) {
        pending.reject(new Error(msg.error.message));
      } else {
        pending.resolve(msg.result ?? {});
      }
    }

    if (msg.method) {
      this.emit('event', msg.method, msg.params);
    }
  }

  private rejectAllPending(reason: string): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error(reason));
      this.pending.delete(id);
    }
  }

  private clearConnectTimer(): void {
    if (this.connectTimer) {
      clearTimeout(this.connectTimer);
      this.connectTimer = null;
    }
  }

  private failConnect(err: Error): void {
    const waiter = this.connectWaiter;
    this.connectWaiter = null;
    this.clearConnectTimer();
    this._connected = false;
    this.rejectAllPending(err.message);
    this.destroySocket();
    waiter?.reject(err);
  }

  private resetConnection(reason: string): void {
    this.clearConnectTimer();
    this._connected = false;
    this.rejectAllPending(reason);
    const waiter = this.connectWaiter;
    this.connectWaiter = null;
    this.destroySocket();
    waiter?.reject(new Error(reason));
  }

  private destroySocket(): void {
    const handshake = this.handshakeSocket;
    this.handshakeSocket = null;
    if (handshake && !handshake.destroyed) {
      try { handshake.destroy(); } catch { /* ignore */ }
    }

    const ws = this.ws;
    this.ws = null;
    if (!ws) return;
    ws.removeAllListeners();
    ws.on('error', () => { /* ignore errors from teardown */ });
    try {
      if (ws.readyState !== WebSocket.CLOSED) {
        ws.terminate();
      }
    } catch {
      /* ignore */
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
