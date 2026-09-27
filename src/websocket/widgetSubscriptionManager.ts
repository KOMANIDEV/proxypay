// ---------------------------------------------------------------------------
// Real-Time Dashboard Widget Subscription Manager (#461)
// ---------------------------------------------------------------------------

export interface WidgetSubscription {
  clientId: string;
  widgetId: string;
  updateFrequencyMs: number;
  subscribedAt: Date;
  intervalHandle: ReturnType<typeof setInterval>;
}

export interface WidgetUpdate {
  widgetId: string;
  data: unknown;
  timestamp: string;
}

export type WidgetUpdateCallback = (update: WidgetUpdate) => void;

/**
 * Manages per-widget, per-client subscriptions for real-time dashboard widgets.
 *
 * Each subscription runs an independent interval that calls a registered
 * broadcast callback at a configurable frequency. Subscriptions are indexed
 * by `clientId:widgetId` for O(1) lookup and memory-safe cleanup.
 *
 * @example
 * const manager = new WidgetSubscriptionManager();
 *
 * // Register a broadcast handler (e.g. WebSocket send)
 * manager.onBroadcast((update) => {
 *   wsClients.get(update.widgetId)?.forEach((ws) => ws.send(JSON.stringify(update)));
 * });
 *
 * // Subscribe a client to a widget at 2-second intervals
 * manager.subscribe('client-abc', 'transaction_volume', 2000);
 *
 * // Broadcast a widget update to all subscribers
 * manager.broadcastUpdate('transaction_volume', { count: 1234, delta: +5 });
 *
 * // Unsubscribe when the client disconnects
 * manager.unsubscribe('client-abc', 'transaction_volume');
 */
export class WidgetSubscriptionManager {
  /** Indexed by `${clientId}:${widgetId}` */
  private readonly subscriptions = new Map<string, WidgetSubscription>();

  /** Registered broadcast listeners */
  private readonly broadcastListeners: WidgetUpdateCallback[] = [];

  /** Data providers keyed by widgetId, called on each interval tick */
  private readonly dataProviders = new Map<
    string,
    () => Promise<unknown> | unknown
  >();

  /**
   * Subscribes a client to a widget with a given update frequency.
   *
   * If the client is already subscribed to this widget, the existing
   * subscription is replaced (frequency may change).
   *
   * @param clientId          - Unique identifier for the connected client
   * @param widgetId          - Widget to subscribe to
   * @param updateFrequencyMs - How often (in ms) to push updates to this client
   */
  subscribe(
    clientId: string,
    widgetId: string,
    updateFrequencyMs: number,
  ): void {
    const key = this.subscriptionKey(clientId, widgetId);

    // Clean up any existing subscription for this client+widget pair
    this.clearSubscription(key);

    const intervalHandle = setInterval(async () => {
      const provider = this.dataProviders.get(widgetId);
      const data = provider ? await provider() : null;
      this.broadcastUpdate(widgetId, data);
    }, updateFrequencyMs);

    // Prevent the interval from blocking process exit
    if (typeof intervalHandle === "object" && "unref" in intervalHandle) {
      (intervalHandle as NodeJS.Timeout).unref();
    }

    this.subscriptions.set(key, {
      clientId,
      widgetId,
      updateFrequencyMs,
      subscribedAt: new Date(),
      intervalHandle,
    });
  }

  /**
   * Unsubscribes a client from a widget, stopping its update interval.
   *
   * @param clientId - Client to unsubscribe
   * @param widgetId - Widget to unsubscribe from
   */
  unsubscribe(clientId: string, widgetId: string): void {
    const key = this.subscriptionKey(clientId, widgetId);
    this.clearSubscription(key);
  }

  /**
   * Unsubscribes a client from all widgets (e.g. on disconnect).
   *
   * @param clientId - Client whose subscriptions should all be removed
   */
  unsubscribeAll(clientId: string): void {
    for (const key of this.subscriptions.keys()) {
      if (key.startsWith(`${clientId}:`)) {
        this.clearSubscription(key);
      }
    }
  }

  /**
   * Broadcasts a widget update to all registered listeners.
   *
   * @param widgetId - The widget the data belongs to
   * @param data     - Arbitrary update payload
   */
  broadcastUpdate(widgetId: string, data: unknown): void {
    const update: WidgetUpdate = {
      widgetId,
      data,
      timestamp: new Date().toISOString(),
    };

    for (const listener of this.broadcastListeners) {
      try {
        listener(update);
      } catch {
        // Individual listener errors must not crash the broadcast loop
      }
    }
  }

  /**
   * Registers a callback that is invoked whenever `broadcastUpdate` is called.
   *
   * @param callback - Function receiving the widget update
   */
  onBroadcast(callback: WidgetUpdateCallback): void {
    this.broadcastListeners.push(callback);
  }

  /**
   * Registers a data provider for a widget.
   * The provider is called on each interval tick and its return value
   * becomes the update payload.
   *
   * @param widgetId - Widget identifier
   * @param provider - Sync or async function returning the widget data
   */
  registerDataProvider(
    widgetId: string,
    provider: () => Promise<unknown> | unknown,
  ): void {
    this.dataProviders.set(widgetId, provider);
  }

  /**
   * Returns a snapshot of all active subscriptions (read-only).
   */
  getActiveSubscriptions(): ReadonlyMap<string, Omit<WidgetSubscription, "intervalHandle">> {
    const result = new Map<string, Omit<WidgetSubscription, "intervalHandle">>();
    for (const [key, sub] of this.subscriptions) {
      const { intervalHandle: _handle, ...rest } = sub;
      result.set(key, rest);
    }
    return result;
  }

  /**
   * Returns the number of currently active subscriptions.
   */
  getSubscriptionCount(): number {
    return this.subscriptions.size;
  }

  /**
   * Checks whether a specific client is subscribed to a specific widget.
   */
  isSubscribed(clientId: string, widgetId: string): boolean {
    return this.subscriptions.has(this.subscriptionKey(clientId, widgetId));
  }

  /**
   * Clears all subscriptions and stops all intervals.
   * Call this during application shutdown to prevent memory/timer leaks.
   */
  dispose(): void {
    for (const key of [...this.subscriptions.keys()]) {
      this.clearSubscription(key);
    }
    this.broadcastListeners.length = 0;
    this.dataProviders.clear();
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private subscriptionKey(clientId: string, widgetId: string): string {
    return `${clientId}:${widgetId}`;
  }

  private clearSubscription(key: string): void {
    const existing = this.subscriptions.get(key);
    if (existing) {
      clearInterval(existing.intervalHandle);
      this.subscriptions.delete(key);
    }
  }
}

/** Singleton instance — import and use directly across the application. */
export const widgetSubscriptionManager = new WidgetSubscriptionManager();
