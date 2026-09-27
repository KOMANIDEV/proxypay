export class RequestTracker {
  private activeRequests = 0;
  private readonly waiters = new Set<() => void>();

  get activeCount(): number {
    return this.activeRequests;
  }

  start(): () => void {
    this.activeRequests += 1;
    let released = false;

    return () => {
      if (released) {
        return;
      }

      released = true;
      this.activeRequests = Math.max(0, this.activeRequests - 1);
      if (this.activeRequests === 0) {
        for (const resolve of this.waiters) {
          resolve();
        }
        this.waiters.clear();
      }
    };
  }

  waitForZero(timeoutMs: number): Promise<void> {
    if (this.activeRequests === 0) {
      return Promise.resolve();
    }

    return new Promise((resolve) => {
      let timeout: ReturnType<typeof setTimeout>;
      const finish = () => {
        clearTimeout(timeout);
        this.waiters.delete(finish);
        resolve();
      };

      timeout = setTimeout(finish, timeoutMs);
      this.waiters.add(finish);
    });
  }
}
