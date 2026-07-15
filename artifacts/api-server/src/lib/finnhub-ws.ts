import { EventEmitter } from "events";
import { logger } from "./logger.js";

export interface FinnhubTrade {
  s: string;
  p: number;
  t: number;
  v: number;
  c?: string[];
}

interface FinnhubTradeMessage {
  type: "trade";
  data: FinnhubTrade[];
}

const MAX_RETRIES = 5;
const BASE_DELAY_MS = 1000;

/**
 * Owns a single Finnhub WebSocket connection. Emits "trade" per tick and
 * "status" on connect/disconnect/exhausted so callers (candle aggregator,
 * SSE layer) don't need to know about reconnection state.
 */
export class FinnhubWsClient extends EventEmitter {
  private ws: WebSocket | null = null;
  private subscribed = new Set<string>();
  private retryCount = 0;
  private closedByUser = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  connect(): void {
    const apiKey = process.env.FINNHUB_API_KEY;
    if (!apiKey) throw new Error("FINNHUB_API_KEY not set");

    this.closedByUser = false;
    const ws = new WebSocket(`wss://ws.finnhub.io?token=${apiKey}`);
    this.ws = ws;

    ws.onopen = () => {
      this.retryCount = 0;
      logger.info({ symbols: this.subscribed.size }, "finnhub-ws: connected");
      this.emit("status", { connected: true });
      for (const symbol of this.subscribed) this.send({ type: "subscribe", symbol });
    };

    ws.onmessage = (event) => {
      let msg: FinnhubTradeMessage;
      try {
        msg = JSON.parse(event.data as string);
      } catch {
        return;
      }
      if (msg.type === "trade" && Array.isArray(msg.data)) {
        for (const trade of msg.data) this.emit("trade", trade);
      }
    };

    ws.onerror = (event) => {
      logger.warn({ err: (event as any)?.message ?? "unknown" }, "finnhub-ws: socket error");
    };

    ws.onclose = () => {
      this.emit("status", { connected: false });
      if (this.closedByUser) return;
      this.scheduleReconnect();
    };
  }

  private scheduleReconnect(): void {
    if (this.retryCount >= MAX_RETRIES) {
      logger.error({ retries: this.retryCount }, "finnhub-ws: reconnect retries exhausted");
      this.emit("status", { connected: false, exhausted: true });
      return;
    }
    const delay = BASE_DELAY_MS * 2 ** this.retryCount;
    this.retryCount++;
    logger.warn({ delay, attempt: this.retryCount }, "finnhub-ws: reconnecting");
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  private send(payload: unknown): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(payload));
    }
  }

  subscribe(symbol: string): void {
    if (this.subscribed.has(symbol)) return;
    this.subscribed.add(symbol);
    this.send({ type: "subscribe", symbol });
  }

  unsubscribe(symbol: string): void {
    if (!this.subscribed.has(symbol)) return;
    this.subscribed.delete(symbol);
    this.send({ type: "unsubscribe", symbol });
  }

  /** Diff current subscriptions against a new target list; subscribe/unsubscribe the delta. */
  syncSubscriptions(symbols: string[]): void {
    const target = new Set(symbols);
    for (const sym of this.subscribed) if (!target.has(sym)) this.unsubscribe(sym);
    for (const sym of target) if (!this.subscribed.has(sym)) this.subscribe(sym);
  }

  close(): void {
    this.closedByUser = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.ws?.close();
    this.ws = null;
  }
}
