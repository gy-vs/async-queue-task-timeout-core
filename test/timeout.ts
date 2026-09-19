/* eslint-disable no-new */
/* eslint-disable ava/no-ignored-test-files */
import test from 'ava';
import sinon from 'sinon';
import PQueue, {TimeoutError} from '../source';

interface Deferred<T> {
	promise: Promise<T>;
	resolve(value: T): void;
	reject(error: Error): void;
}

const createDeferred = <T>(): Deferred<T> => {
	let resolvePromise!: (value: T) => void;
	let rejectPromise!: (error: Error) => void;
	const promise = new Promise<T>((resolve, reject) => {
		resolvePromise = resolve;
		rejectPromise = reject;
	});

	return {promise, resolve: resolvePromise, reject: rejectPromise};
};

const neverSettles = (): Promise<never> => new Promise<never>(() => {});

// Start the fake clock at a realistic epoch. With the default `now: 0`, the
// queue's interval bookkeeping computes `_intervalEnd - now === 0` on the very
// first task and takes a code path that only exists for exactly-zero delays,
// spawning a spurious 0ms resume timer. Real clocks never hit that path.
const useClock = (): sinon.SinonFakeTimers => sinon.useFakeTimers({now: 1e9});

// All tests in this file are serial because the fake timers are installed globally.
// Every test restores the clock in a `finally` block so a failure cannot leak
// fake timers into the next test.

test.serial('timeout rejects with TimeoutError and releases the concurrency slot', async t => {
	const clock = useClock();
	const timerCount = clock.countTimers();

	try {
		const queue = new PQueue({concurrency: 1});

		const blocked = queue.add(neverSettles, {timeout: 100});
		const blockedAssertion = t.throwsAsync(blocked, {instanceOf: TimeoutError});

		const followup = createDeferred<string>();
		const followupPromise = queue.add(() => followup.promise);

		t.is(queue.pending, 1);
		t.is(queue.size, 1);

		await clock.tickAsync(99);
		t.is(queue.pending, 1);
		t.is(queue.size, 1);

		await clock.tickAsync(1);
		await blockedAssertion;

		// The timed out task released its slot, so the queued task started
		t.is(queue.pending, 1);
		t.is(queue.size, 0);

		followup.resolve('followup');
		t.is(await followupPromise, 'followup');
		await queue.onIdle();
		t.is(clock.countTimers(), timerCount);
	} finally {
		clock.restore();
	}
});

test.serial('time spent waiting in the queue does not count towards the timeout', async t => {
	const clock = useClock();
	const timerCount = clock.countTimers();

	try {
		const queue = new PQueue({concurrency: 1});

		const first = createDeferred<string>();
		const firstPromise = queue.add(() => first.promise);
		const second = queue.add(neverSettles, {timeout: 100});
		const secondAssertion = t.throwsAsync(second, {instanceOf: TimeoutError});

		// The second task waits in the queue for much longer than its timeout
		await clock.tickAsync(500);
		t.is(queue.pending, 1);
		t.is(queue.size, 1);

		// Let the first task finish so the second one starts; its timer starts now
		first.resolve('first');
		t.is(await firstPromise, 'first');
		t.is(queue.pending, 1);
		t.is(queue.size, 0);

		await clock.tickAsync(99);
		t.is(queue.pending, 1);

		await clock.tickAsync(1);
		await secondAssertion;
		t.is(queue.pending, 0);

		await queue.onIdle();
		t.is(clock.countTimers(), timerCount);
	} finally {
		clock.restore();
	}
});

test.serial('queue-level timeout is the default and can be overridden per task', async t => {
	const clock = useClock();
	const timerCount = clock.countTimers();

	try {
		const queue = new PQueue({concurrency: 1, timeout: 100});

		const usesDefault = queue.add(neverSettles);
		const defaultAssertion = t.throwsAsync(usesDefault, {instanceOf: TimeoutError});
		await clock.tickAsync(100);
		await defaultAssertion;
		t.is(queue.pending, 0);

		const overridden = queue.add(neverSettles, {timeout: 500});
		const overriddenAssertion = t.throwsAsync(overridden, {instanceOf: TimeoutError});
		await clock.tickAsync(100);
		t.is(queue.pending, 1);
		await clock.tickAsync(400);
		await overriddenAssertion;
		t.is(queue.pending, 0);

		await queue.onIdle();
		t.is(clock.countTimers(), timerCount);
	} finally {
		clock.restore();
	}
});

test.serial('timeout Infinity disables the timeout and timeout 0 times out immediately', async t => {
	const clock = useClock();
	const timerCount = clock.countTimers();

	try {
		const queue = new PQueue({concurrency: 1, timeout: 100});

		// A task-level Infinity overrides the queue-level default
		const deferred = createDeferred<string>();
		const noTimeout = queue.add(() => deferred.promise, {timeout: Infinity});
		await clock.tickAsync(10000);
		t.is(queue.pending, 1);
		deferred.resolve('done');
		t.is(await noTimeout, 'done');

		// A task-level 0 overrides the queue-level default and times out right away
		const immediate = queue.add(neverSettles, {timeout: 0});
		const immediateAssertion = t.throwsAsync(immediate, {instanceOf: TimeoutError});
		await clock.tickAsync(0);
		await immediateAssertion;
		t.is(queue.pending, 0);

		await queue.onIdle();
		t.is(clock.countTimers(), timerCount);
	} finally {
		clock.restore();
	}
});

test.serial('sync tasks settle before their timeout and clean up the timer', async t => {
	const clock = useClock();
	const timerCount = clock.countTimers();

	try {
		const queue = new PQueue({concurrency: 1, timeout: 100});

		t.is(await queue.add(() => 'sync value'), 'sync value');
		t.is(clock.countTimers(), timerCount);

		const error = await t.throwsAsync(queue.add(() => {
			throw new Error('sync broken');
		}));
		t.is(error.message, 'sync broken');
		t.is(clock.countTimers(), timerCount);

		// Even a zero timeout does not beat a synchronous task
		t.is(await queue.add(() => 'still sync', {timeout: 0}), 'still sync');
		t.is(clock.countTimers(), timerCount);

		await queue.onIdle();
		t.is(clock.countTimers(), timerCount);
	} finally {
		clock.restore();
	}
});

test.serial('a task that rejects before its timeout rejects with the original error', async t => {
	const clock = useClock();
	const timerCount = clock.countTimers();

	try {
		const queue = new PQueue({concurrency: 1, timeout: 100});

		const deferred = createDeferred<never>();
		const failure = new Error('task failed');
		const promise = queue.add(() => deferred.promise);
		const assertion = t.throwsAsync(promise);

		await clock.tickAsync(50);
		deferred.reject(failure);

		t.is(await assertion, failure);
		t.is(queue.pending, 0);

		// The timer was cleaned up: advancing past the timeout does nothing
		t.is(clock.countTimers(), timerCount);
		await clock.tickAsync(1000);
		t.is(queue.pending, 0);

		await queue.onIdle();
		t.is(clock.countTimers(), timerCount);
	} finally {
		clock.restore();
	}
});

test.serial('late completion after a timeout cannot change the queue state', async t => {
	const clock = useClock();
	const timerCount = clock.countTimers();

	try {
		const queue = new PQueue({concurrency: 1});

		const deferred = createDeferred<string>();
		const timedOut = queue.add(() => deferred.promise, {timeout: 100});
		const timedOutAssertion = t.throwsAsync(timedOut, {instanceOf: TimeoutError});

		const followup = createDeferred<string>();
		const followupPromise = queue.add(() => followup.promise);

		await clock.tickAsync(100);
		await timedOutAssertion;
		t.is(queue.pending, 1);
		followup.resolve('followup');
		t.is(await followupPromise, 'followup');
		t.is(queue.pending, 0);

		// The underlying task resolves long after its timeout
		deferred.resolve('too late');
		await clock.tickAsync(1000);

		// The slot was released exactly once: the queue state is unaffected
		t.is(queue.pending, 0);
		t.is(queue.size, 0);

		// The queue still schedules new work correctly
		t.is(await queue.add(async () => 'after'), 'after');
		t.is(queue.pending, 0);

		await queue.onIdle();
		t.is(clock.countTimers(), timerCount);
	} finally {
		clock.restore();
	}
});

test.serial('late rejection after a timeout does not produce an unhandled rejection', async t => {
	const clock = useClock();
	const timerCount = clock.countTimers();
	const unhandled: unknown[] = [];
	const onUnhandled = (reason: unknown): void => {
		unhandled.push(reason);
	};

	process.on('unhandledRejection', onUnhandled);

	try {
		const queue = new PQueue({concurrency: 1});

		const deferred = createDeferred<string>();
		const promise = queue.add(() => deferred.promise, {timeout: 100});
		const assertion = t.throwsAsync(promise, {instanceOf: TimeoutError});

		await clock.tickAsync(100);
		await assertion;

		// The underlying task rejects long after its timeout
		deferred.reject(new Error('too late'));
		await clock.tickAsync(1000);

		await queue.onIdle();
		t.is(clock.countTimers(), timerCount);
	} finally {
		clock.restore();
	}

	// Let the real event loop run so any unhandled rejection would surface
	await new Promise<void>(resolve => {
		setImmediate(resolve);
	});

	await new Promise<void>(resolve => {
		setImmediate(resolve);
	});

	process.removeListener('unhandledRejection', onUnhandled);
	t.deepEqual(unhandled, []);
});

test.serial('multiple concurrent tasks time out and settle independently', async t => {
	const clock = useClock();
	const timerCount = clock.countTimers();

	try {
		const queue = new PQueue({concurrency: 2});

		const a = queue.add(neverSettles, {timeout: 100});
		const aAssertion = t.throwsAsync(a, {instanceOf: TimeoutError});

		const bDeferred = createDeferred<string>();
		const b = queue.add(() => bDeferred.promise, {timeout: 1000});

		const c = queue.add(neverSettles, {timeout: 50});
		const cAssertion = t.throwsAsync(c, {instanceOf: TimeoutError});

		t.is(queue.pending, 2);
		t.is(queue.size, 1);

		// Task b completes and c takes the freed slot; the timer of c starts now
		bDeferred.resolve('b');
		t.is(await b, 'b');
		t.is(queue.pending, 2);
		t.is(queue.size, 0);

		// Task c times out 50ms after it started
		await clock.tickAsync(50);
		await cAssertion;
		t.is(queue.pending, 1);

		// Task a is still within its own 100ms budget
		await clock.tickAsync(49);
		t.is(queue.pending, 1);
		await clock.tickAsync(1);
		await aAssertion;
		t.is(queue.pending, 0);

		await queue.onIdle();
		t.is(clock.countTimers(), timerCount);
	} finally {
		clock.restore();
	}
});

test.serial('a paused queue does not start the timeout until the task actually starts', async t => {
	const clock = useClock();
	const timerCount = clock.countTimers();

	try {
		const queue = new PQueue({concurrency: 1, autoStart: false});

		const promise = queue.add(neverSettles, {timeout: 100});
		const assertion = t.throwsAsync(promise, {instanceOf: TimeoutError});

		// The task never started, so its timeout cannot elapse
		await clock.tickAsync(1000);
		t.is(queue.pending, 0);
		t.is(queue.size, 1);

		queue.start();
		t.is(queue.pending, 1);

		await clock.tickAsync(99);
		t.is(queue.pending, 1);
		await clock.tickAsync(1);
		await assertion;
		t.is(queue.pending, 0);

		await queue.onIdle();
		t.is(clock.countTimers(), timerCount);
	} finally {
		clock.restore();
	}
});

test.serial('intervalCap scheduling still applies to slots released by a timeout', async t => {
	const clock = useClock();
	const timerCount = clock.countTimers();

	try {
		const queue = new PQueue({concurrency: 1, intervalCap: 1, interval: 100, timeout: 50});

		const first = queue.add(neverSettles);
		const firstAssertion = t.throwsAsync(first, {instanceOf: TimeoutError});

		let secondStarted = false;
		const second = queue.add(async () => {
			secondStarted = true;
		});

		// The first task times out and releases its slot…
		await clock.tickAsync(50);
		await firstAssertion;
		t.is(queue.pending, 0);

		// …but the interval cap keeps the second task queued until the interval resets
		t.false(secondStarted);
		await clock.tickAsync(49);
		t.false(secondStarted);
		await clock.tickAsync(1);
		t.true(secondStarted);
		t.is(await second, undefined);

		await queue.onIdle();
		t.is(clock.countTimers(), timerCount);
	} finally {
		clock.restore();
	}
});

test.serial('concurrency can be changed dynamically while tasks have timeouts', async t => {
	const clock = useClock();
	const timerCount = clock.countTimers();

	try {
		const queue = new PQueue({concurrency: 1, timeout: 1000});

		let firstStarted = false;
		let secondStarted = false;
		const first = queue.add(async () => {
			firstStarted = true;
			await neverSettles();
		});

		const firstAssertion = t.throwsAsync(first, {instanceOf: TimeoutError});
		const second = queue.add(async () => {
			secondStarted = true;
		});

		t.true(firstStarted);
		t.false(secondStarted);

		// Increasing the concurrency starts queued tasks immediately
		queue.concurrency = 2;
		t.true(secondStarted);
		t.is(queue.pending, 2);

		t.is(await second, undefined);
		await clock.tickAsync(1000);
		await firstAssertion;
		t.is(queue.pending, 0);

		await queue.onIdle();
		t.is(clock.countTimers(), timerCount);
	} finally {
		clock.restore();
	}
});

test.serial('TimeoutError exposes a useful name and message', async t => {
	const clock = useClock();

	try {
		const queue = new PQueue();

		const promise = queue.add(neverSettles, {timeout: 10});
		const assertion = t.throwsAsync(promise, {instanceOf: TimeoutError});
		await clock.tickAsync(10);

		const error = await assertion;
		t.is(error.name, 'TimeoutError');
		t.true(error.message.includes('10'));

		// The message is optional
		t.is(new TimeoutError().message, 'Task timed out');

		await queue.onIdle();
	} finally {
		clock.restore();
	}
});

test.serial('concurrency getter and setter validation', t => {
	const queue = new PQueue({concurrency: 2});
	t.is(queue.concurrency, 2);

	queue.concurrency = 5;
	t.is(queue.concurrency, 5);

	t.throws(() => {
		queue.concurrency = 0;
	}, TypeError);

	t.throws(() => {
		queue.concurrency = NaN;
	}, TypeError);
});

test.serial('enforce number in options.timeout', t => {
	t.throws(() => {
		new PQueue({timeout: -1});
	}, TypeError);

	t.throws(() => {
		new PQueue({timeout: NaN});
	}, TypeError);

	t.notThrows(() => {
		new PQueue({timeout: 0});
	});

	t.notThrows(() => {
		new PQueue({timeout: 10});
	});

	t.notThrows(() => {
		new PQueue({timeout: Infinity});
	});
});
