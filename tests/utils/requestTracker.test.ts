import { RequestTracker } from "../../src/utils/requestTracker";

describe("RequestTracker", () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it("waits until all active requests have completed", async () => {
    const tracker = new RequestTracker();
    const releaseFirst = tracker.start();
    const releaseSecond = tracker.start();
    const drained = tracker.waitForZero(1_000);

    expect(tracker.activeCount).toBe(2);

    releaseFirst();
    await Promise.resolve();
    expect(tracker.activeCount).toBe(1);

    releaseSecond();
    await expect(drained).resolves.toBeUndefined();
    expect(tracker.activeCount).toBe(0);
  });

  it("only releases a request once", () => {
    const tracker = new RequestTracker();
    const release = tracker.start();

    release();
    release();

    expect(tracker.activeCount).toBe(0);
  });

  it("resolves after the timeout when a request does not finish", async () => {
    jest.useFakeTimers();
    const tracker = new RequestTracker();
    tracker.start();

    const drained = tracker.waitForZero(5_000);
    jest.advanceTimersByTime(5_000);

    await expect(drained).resolves.toBeUndefined();
    expect(tracker.activeCount).toBe(1);
  });
});
