/* eslint-disable no-new */
import test, {TestInterface} from 'ava';
import PQueue, {TimeoutError} from '../source';
import FakeTimers from './helpers/fake-timers';

interface Deferred<T> {
	promise: Promise<T>;
	resolve: (value: T) => void;
	reject: (error: Error) => void;
}

const createDeferred = <T = void>(): Deferred<T> => {
	const deferred: Partial<Deferred<T>> = {};
	deferred.promise = new Promise<T>((resolve, reject) => {
		deferred.resolve = resolve;
		deferred.reject = reject;
	});
	return deferred as Deferred<T>;
};

const fixture = Symbol('fixture');

interface TestContext {
	timers: FakeTimers;
	rejections: Error[];
	listener: (reason: unknown) => void;
}

const testWithContext = test as TestInterface<TestContext>;

testWithContext.beforeEach(t => {
	const listener = (reason: unknown): void => {
		t.context.rejections.push(reason as Error);
	};

	const context: TestContext = {
		timers: new FakeTimers(),
		rejections: [],
		listener
	};
	t.context = context;

	context.timers.install();
	process.on('unhandledRejection', listener);
});

testWithContext.afterEach(t => {
	t.context.timers.uninstall();
	process.removeListener('unhandledRejection', t.context.listener);
});

testWithContext.serial('queue-level timeout: task exceeding it rejects with TimeoutError, and idle is reached', async t => {
	const {timers, rejections: unhandled} = t.context;
	const queue = new PQueue({concurrency: 1, timeout: 100});
	const slow = createDeferred<symbol>();

	let failure: unknown;
	const promise = queue.add(() => slow.promise).catch(error => {
		failure = error;
	});

	t.is(queue.pending, 1);
	await timers.tickAsync(99);
	t.is(failure, undefined, 'does not reject before the timeout');

	await timers.tickAsync(1);
	await promise;
	t.true(failure instanceof TimeoutError);
	t.is((failure as Error).name, 'TimeoutError');

	await queue.onIdle();
	t.is(queue.pending, 0);
	t.is(timers.pendingCount, 0, 'timer is cleaned up');
	t.is(unhandled.length, 0);
});

testWithContext.serial('task-level timeout overrides the queue-level default', async t => {
	const {timers} = t.context;
	const queue = new PQueue({timeout: 100});
	const deferred200 = createDeferred<symbol>();
	const deferred600 = createDeferred<symbol>();

	// Override with a longer timeout; finish before it elapses.
	const long = queue.add(() => deferred200.promise, {timeout: 300});
	// Override with a shorter timeout.
	const short = queue.add(() => deferred600.promise, {timeout: 50});

	let shortError: unknown;
	short.catch(error => {
		shortError = error;
	});

	await timers.tickAsync(50);
	t.true(shortError instanceof TimeoutError);

	deferred200.resolve(fixture);
	await timers.tickAsync(150);
	t.is(await long, fixture);

	await queue.onIdle();
	t.is(timers.pendingCount, 0);
});

testWithContext.serial('timeout 0 disables the timer at queue level', async t => {
	const {timers} = t.context;
	const queue = new PQueue({timeout: 0});
	const deferred = createDeferred<symbol>();

	const promise = queue.add(() => deferred.promise);

	await timers.tickAsync(5000);
	t.is(queue.pending, 1, 'a 0 timeout means the task may run forever');

	deferred.resolve(fixture);
	await timers.tickAsync(1);
	t.is(await promise, fixture);
	await queue.onIdle();
	t.is(timers.pendingCount, 0);
});

testWithContext.serial('timeout Infinity disables the timer at queue level', async t => {
	const {timers} = t.context;
	const queue = new PQueue({timeout: Infinity});
	const deferred = createDeferred<symbol>();

	const promise = queue.add(() => deferred.promise);

	await timers.tickAsync(5000);
	t.is(queue.pending, 1);

	deferred.resolve(fixture);
	await timers.tickAsync(1);
	t.is(await promise, fixture);
	await queue.onIdle();
	t.is(timers.pendingCount, 0);
});

testWithContext.serial('task-level 0 and Infinity are honored and do not fall back to the default (no truthy check)', async t => {
	const {timers} = t.context;
	const queue = new PQueue({timeout: 100});
	const zero = createDeferred<symbol>();
	const infinite = createDeferred<symbol>();

	const zeroPromise = queue.add(() => zero.promise, {timeout: 0});
	const infinitePromise = queue.add(() => infinite.promise, {timeout: Infinity});

	await timers.tickAsync(500);
	t.is(queue.pending, 2, 'neither task timed out despite the queue default of 100');

	zero.resolve(fixture);
	infinite.resolve(fixture);
	await timers.tickAsync(1);
	t.deepEqual(await Promise.all([zeroPromise, infinitePromise]), [fixture, fixture]);
	await queue.onIdle();
	t.is(timers.pendingCount, 0);
});

testWithContext.serial('time spent waiting in the queue does not count toward the timeout', async t => {
	const {timers} = t.context;
	const queue = new PQueue({concurrency: 1, timeout: 100});
	const blocking = createDeferred();
	const queued = createDeferred();

	const blocker = queue.add(() => blocking.promise, {timeout: Infinity});
	let failure: unknown;
	const queuedPromise = queue.add(() => queued.promise).catch(error => {
		failure = error;
	});

	// The second task sits in the queue for 150ms, longer than its 100ms
	// timeout, without timing out.
	await timers.tickAsync(150);
	t.is(queue.size, 1);
	t.is(failure, undefined);

	blocking.resolve();
	await timers.tickAsync(1);
	t.is(queue.size, 0);
	t.is(queue.pending, 1);
	t.is(failure, undefined, 'timer only starts when the task starts running');

	// The queued task has now been running for 99ms.
	await timers.tickAsync(99);
	t.is(failure, undefined);

	// It times out 100ms after it started, i.e. at virtual time 250.
	await timers.tickAsync(1);
	await queuedPromise;
	t.true(failure instanceof TimeoutError);
	await blocker;
	await queue.onIdle();
	t.is(timers.pendingCount, 0);
});

testWithContext.serial('synchronous task resolves and its timer is defused', async t => {
	const {timers} = t.context;
	const queue = new PQueue({timeout: 100});

	t.is(await queue.add(() => fixture), fixture);
	await timers.tickAsync(500);
	await queue.onIdle();
	t.is(queue.pending, 0);
	t.is(timers.pendingCount, 0);
});

testWithContext.serial('synchronous throw rejects before the timeout and defuses the timer', async t => {
	const {timers} = t.context;
	const queue = new PQueue({timeout: 100});

	await t.throwsAsync(
		queue.add(() => {
			throw new Error('broken sync');
		}),
		'broken sync'
	);

	await timers.tickAsync(500);
	await queue.onIdle();
	t.is(timers.pendingCount, 0);
});

testWithContext.serial('a rejection before the timeout wins and cleans up the timer', async t => {
	const {timers, rejections: unhandled} = t.context;
	const queue = new PQueue({timeout: 100});
	const deferred = createDeferred();

	const promise = queue.add(() => deferred.promise);
	// Attach the handler before the rejection happens.
	const rejection = t.throwsAsync(promise, 'broken async');

	await timers.tickAsync(50);
	deferred.reject(new Error('broken async'));
	await timers.tickAsync(1);
	await rejection;

	await timers.tickAsync(500);
	await queue.onIdle();
	t.is(timers.pendingCount, 0, 'the timeout never fires');
	t.is(unhandled.length, 0);
});

testWithContext.serial('a late resolve after timeout neither changes the result nor corrupts the queue', async t => {
	const {timers, rejections: unhandled} = t.context;
	const queue = new PQueue({concurrency: 1, timeout: 100});
	const slow = createDeferred<symbol>();

	let failure: unknown;
	const first = queue.add(() => slow.promise).catch(error => {
		failure = error;
	});
	const second = queue.add(async () => fixture);

	await timers.tickAsync(100);
	await first;
	t.true(failure instanceof TimeoutError);

	// The timed-out task already released its slot, so the queued task ran.
	t.is(await second, fixture);
	t.is(queue.pending, 0);

	// The underlying task settles late; nothing must happen.
	slow.resolve(fixture);
	await timers.tickAsync(200);
	t.true(failure instanceof TimeoutError);
	t.is(queue.pending, 0);

	await queue.onIdle();
	t.is(timers.pendingCount, 0);
	t.is(unhandled.length, 0);
});

testWithContext.serial('a late rejection after timeout is swallowed (no unhandled rejection)', async t => {
	const {timers, rejections: unhandled} = t.context;
	const queue = new PQueue({concurrency: 1, timeout: 100});
	const slow = createDeferred<symbol>();

	let failure: unknown;
	const first = queue.add(() => slow.promise).catch(error => {
		failure = error;
	});

	await timers.tickAsync(100);
	await first;
	t.true(failure instanceof TimeoutError);

	slow.reject(new Error('late failure'));
	await timers.tickAsync(200);

	await queue.onIdle();
	t.is(timers.pendingCount, 0);
	t.is(unhandled.length, 0, 'the late rejection does not surface as unhandled');
});

testWithContext.serial('timeout releases the concurrency slot and subsequent tasks keep running', async t => {
	const {timers} = t.context;
	const queue = new PQueue({concurrency: 2, timeout: 100});
	const taskA = createDeferred();
	const taskB = createDeferred();

	let aError: unknown;
	const a = queue.add(() => taskA.promise).catch(error => {
		aError = error;
	});
	let bError: unknown;
	const b = queue.add(() => taskB.promise, {timeout: 200}).catch(error => {
		bError = error;
	});
	const c = queue.add(async () => fixture);

	t.is(queue.size, 1);
	t.is(queue.pending, 2);

	await timers.tickAsync(100);
	await a;
	t.true(aError instanceof TimeoutError);
	// Slot freed: C started and finished even though B is still pending.
	t.is(await c, fixture);
	t.is(queue.pending, 1);

	await timers.tickAsync(100);
	await b;
	t.true(bError instanceof TimeoutError);

	await queue.onIdle();
	t.is(queue.size, 0);
	t.is(queue.pending, 0);
	t.is(timers.pendingCount, 0);
});

testWithContext.serial('multiple concurrent tasks have independent timers', async t => {
	const {timers} = t.context;
	const queue = new PQueue({concurrency: 3});
	const d1 = createDeferred<number>();
	const d2 = createDeferred<number>();
	const d3 = createDeferred<number>();

	let e1: unknown;
	const p1 = queue.add(() => d1.promise, {timeout: 100}).catch(error => {
		e1 = error;
	});
	let v2: number | undefined;
	const p2 = (async () => {
		v2 = await queue.add(() => d2.promise, {timeout: 200});
	})();
	let e3: unknown;
	const p3 = queue.add(() => d3.promise, {timeout: 300}).catch(error => {
		e3 = error;
	});

	await timers.tickAsync(150);
	d2.resolve(2);
	await timers.tickAsync(1);
	await p1;
	await p2;
	t.true(e1 instanceof TimeoutError, 'the 100ms task timed out');
	t.is(v2, 2, 'the 200ms task resolved in time');

	await timers.tickAsync(150);
	await p3;
	t.true(e3 instanceof TimeoutError, 'the 300ms task timed out');

	await queue.onIdle();
	t.is(timers.pendingCount, 0);
});

testWithContext.serial('pause: timers only run after the queue starts', async t => {
	const {timers} = t.context;
	const queue = new PQueue({concurrency: 1, autoStart: false, timeout: 100});
	const deferred = createDeferred();

	let failure: unknown;
	const promise = queue.add(() => deferred.promise).catch(error => {
		failure = error;
	});

	await timers.tickAsync(500);
	t.is(queue.pending, 0);
	t.is(failure, undefined, 'a paused task has no timer running');

	queue.start();
	await timers.tickAsync(99);
	t.is(failure, undefined);

	await timers.tickAsync(1);
	await promise;
	t.true(failure instanceof TimeoutError);

	await queue.onIdle();
	t.is(timers.pendingCount, 0);
});

testWithContext.serial('intervalCap still gates tasks released by a timeout', async t => {
	const {timers} = t.context;
	const queue = new PQueue({
		concurrency: 1,
		intervalCap: 1,
		interval: 100,
		timeout: 50
	});
	const slow = createDeferred<symbol>();

	const order: string[] = [];
	const first = queue.add(async () => {
		order.push('first-start');
		await slow.promise;
	}).catch(() => {
		order.push('first-timeout');
	});

	const secondTask = queue.add(async () => {
		order.push('second-start');
		return fixture;
	});
	const second = (async () => {
		const value = await secondTask;
		order.push('second-done');
		return value;
	})();

	await timers.tickAsync(50);
	t.deepEqual(order, ['first-start', 'first-timeout']);
	t.is(queue.size, 1, 'the interval cap holds the second task back');

	// At the next interval boundary the count resets and the second task starts.
	await timers.tickAsync(50);
	t.deepEqual(order, ['first-start', 'first-timeout', 'second-start', 'second-done']);
	t.is(await second, fixture);

	await first;
	await queue.onIdle();
	t.is(queue.pending, 0);
	t.is(timers.pendingCount, 0);
});

testWithContext.serial('invalid queue-level timeout throws', t => {
	t.throws(() => {
		new PQueue({timeout: -1});
	}, TypeError);

	t.throws(() => {
		new PQueue({timeout: 'nope' as unknown as number});
	}, TypeError);

	t.notThrows(() => {
		new PQueue({timeout: 0});
	});

	t.notThrows(() => {
		new PQueue({timeout: Infinity});
	});
});

testWithContext.serial('invalid task-level timeout rejects the returned promise', async t => {
	const queue = new PQueue({timeout: 100});

	await t.throwsAsync(
		queue.add(async () => fixture, {timeout: -1}),
		TypeError
	);

	await t.throwsAsync(
		queue.add(async () => fixture, {timeout: 'nope' as unknown as number}),
		TypeError
	);

	await queue.onIdle();
});
