// Minimal virtual (fake) timers.
//
// Replaces global `setTimeout`/`clearTimeout`/`setInterval` and freezes
// `Date.now()`. Time only advances when `.tickAsync()` is called, so
// timeout-related scheduling can be tested deterministically without real
// delays. After each fired timer callback, the full microtask queue is
// flushed, which lets every `await` on a settled promise resume.

// Captured at module load, before tests can patch the globals.
const realSetImmediate: (callback: () => void) => void = setImmediate;

const flushMicrotasks = (): Promise<void> => new Promise(resolve => {
	realSetImmediate(resolve);
});

interface TimerHandle {
	id: number;
	nextRun: number;
	period: number | undefined;
	callback: () => void;
}

export default class FakeTimers {
	// Start at a positive value, like the real `Date.now()`. Code that compares
	// against an uninitialized timestamp of `0` must see a negative delay;
	// starting at `0` would turn that into a spurious zero-delay timer.
	private _now = 1000;

	private _nextId = 1;

	private readonly _active = new Map<number, TimerHandle>();

	private readonly _timers: TimerHandle[] = [];

	private _realSetTimeout?: unknown;

	private _realClearTimeout?: unknown;

	private _realSetInterval?: unknown;

	private _realClearInterval?: unknown;

	private _realDateNow?: () => number;

	install(): void {
		this._realSetTimeout = global.setTimeout;
		this._realClearTimeout = global.clearTimeout;
		this._realSetInterval = global.setInterval;
		this._realClearInterval = global.clearInterval;
		this._realDateNow = Date.now;

		const globals = global as unknown as Record<string, unknown>;
		globals.setTimeout = (callback: () => void, ms?: number) => this._setTimeout(callback, ms);
		globals.clearTimeout = (handle: unknown) => this._clearTimer(handle);
		globals.setInterval = (callback: () => void, ms?: number) => this._setInterval(callback, ms);
		globals.clearInterval = (handle: unknown) => this._clearTimer(handle);
		Date.now = (): number => this.now;
	}

	uninstall(): void {
		const globals = global as unknown as Record<string, unknown>;
		globals.setTimeout = this._realSetTimeout;
		globals.clearTimeout = this._realClearTimeout;
		globals.setInterval = this._realSetInterval;
		globals.clearInterval = this._realClearInterval;

		if (this._realDateNow) {
			Date.now = this._realDateNow;
		}

		this._active.clear();
		this._timers.length = 0;
	}

	get now(): number {
		return this._now;
	}

	get pendingCount(): number {
		return this._active.size;
	}

	// Fire every timer due at or before the target time, in time order,
	// flushing microtasks after each one.
	async tickAsync(ms: number): Promise<void> {
		const target = this._now + ms;

		for (;;) {
			const due = this._timers.find(handle =>
				this._active.has(handle.id) && handle.nextRun <= target
			);

			if (due === undefined) {
				break;
			}

			this._timers.splice(this._timers.indexOf(due), 1);

			if (!this._active.has(due.id)) {
				continue;
			}

			if (due.period === undefined) {
				this._active.delete(due.id);
			} else {
				due.nextRun += due.period;
				this._insert(due);
			}

			this._now = Math.min(due.nextRun, target);
			due.callback();

			// Let every queued promise reaction run before firing the next timer.
			// eslint-disable-next-line no-await-in-loop
			await flushMicrotasks();
		}

		this._now = target;
		await flushMicrotasks();
	}

	private _insert(handle: TimerHandle): void {
		let low = 0;
		let high = this._timers.length;
		while (low < high) {
			const mid = (low + high) >>> 1;
			if (this._timers[mid].nextRun <= handle.nextRun) {
				low = mid + 1;
			} else {
				high = mid;
			}
		}

		this._timers.splice(low, 0, handle);
	}

	private _setTimeout(callback: () => void, ms = 0): number {
		const id = this._nextId++;
		const handle: TimerHandle = {id, nextRun: this._now + Math.max(0, ms), period: undefined, callback};
		this._active.set(id, handle);
		this._insert(handle);
		return id;
	}

	private _setInterval(callback: () => void, ms = 0): number {
		const id = this._nextId++;
		const period = Math.max(0, ms);
		const handle: TimerHandle = {id, nextRun: this._now + period, period, callback};
		this._active.set(id, handle);
		this._insert(handle);
		return id;
	}

	private _clearTimer(handle: unknown): void {
		if (handle === undefined || handle === null) {
			return;
		}

		this._active.delete(handle as number);
	}
}
