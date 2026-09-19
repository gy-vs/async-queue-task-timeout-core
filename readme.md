# p-queue [![Build Status](https://travis-ci.org/sindresorhus/p-queue.svg?branch=master)](https://travis-ci.org/sindresorhus/p-queue) [![codecov](https://codecov.io/gh/sindresorhus/p-queue/branch/master/graph/badge.svg)](https://codecov.io/gh/sindresorhus/p-queue)

> Promise queue with concurrency control

Useful for rate-limiting async (or sync) operations. For example, when interacting with a REST API or when doing CPU/memory intensive tasks.


## Install

```
$ npm install p-queue
```


## Usage

Here we run only one promise at the time. For example, set `concurrency` to 4 to run four promises at the same time.

```js
const PQueue = require('p-queue');
const got = require('got');

const queue = new PQueue({concurrency: 1});

(async () => {
	await queue.add(() => got('sindresorhus.com'));
	console.log('Done: sindresorhus.com');
})();

(async () => {
	await queue.add(() => got('ava.li'));
	console.log('Done: ava.li');
})();

(async () => {
	const task = await getUnicornTask();
	await queue.add(task);
	console.log('Done: Unicorn task');
})();
```


## API

### PQueue([options])

Returns a new `queue` instance, which is an [`EventEmitter3`](https://github.com/primus/eventemitter3) subclass.

#### options

Type: `Object`

##### concurrency

Type: `number`<br>
Default: `Infinity`<br>
Minimum: `1`

Concurrency limit.

##### autoStart

Type: `boolean`<br>
Default: `true`

Whether queue tasks within concurrency limit, are auto-executed as soon as they're added.

##### queueClass

Type: `Function`

Class with a `enqueue` and `dequeue` method, and a `size` getter. See the [Custom QueueClass](#custom-queueclass) section.

##### intervalCap

Type: `number`<br>
Default: `Infinity`<br>
Minimum: `1`

The max number of runs in the given interval of time.

##### interval

Type: `number`<br>
Default: `0`<br>
Minimum: `0`

The length of time in milliseconds before the interval count resets. Must be finite.

##### carryoverConcurrencyCount

Type: `boolean`<br>
Default: `false`

Whether the task must finish in the given interval or will be carried over into the next interval count.

##### timeout

Type: `number`<br>
Default: `Infinity`

Per-operation timeout in milliseconds. When a task runs longer than this, its promise rejects with a `TimeoutError`. The timer starts when the task actually starts running, so time spent waiting in the queue does not count. `0` and `Infinity` disable the timeout. Can be overridden per task.

### queue

`PQueue` instance.

#### .add(fn, [options])

Adds a sync or async task to the queue. Always returns a promise.

##### fn

Type: `Function`

Promise-returning/async function.

#### options

Type: `Object`

##### priority

Type: `number`<br>
Default: `0`

Priority of operation. Operations with greater priority will be scheduled first.

##### timeout

Type: `number`<br>
Default: The queue-level [`timeout`](#timeout) option

Per-operation timeout in milliseconds, overriding the queue-level default. `0` and `Infinity` disable the timeout for this task (an explicit `undefined` or omitting the option means "use the queue default").

```js
const PQueue = require('p-queue');
const {TimeoutError} = require('p-queue');

const queue = new PQueue({timeout: 100});

// Resolves normally, despite the 100ms queue default.
queue.add(longRunningTask, {timeout: Infinity});

// Rejects with a TimeoutError after 50ms; the concurrency slot is released.
queue.add(anotherTask, {timeout: 50})
	.catch(error => {
		if (error instanceof TimeoutError) {
			// Timed out
		}
	});
```

#### .addAll(fns, [options])

Same as `.add()`, but accepts an array of sync or async functions and returns a promise that resolves when all functions are resolved.

#### .pause()

Put queue execution on hold.

#### .start()

Start (or resume) executing enqueued tasks within concurrency limit. No need to call this if queue is not paused (via `options.autoStart = false` or by `.pause()` method.)

#### .onEmpty()

Returns a promise that settles when the queue becomes empty.

Can be called multiple times. Useful if you for example add additional items at a later time.

#### .onIdle()

Returns a promise that settles when the queue becomes empty, and all promises have completed; `queue.size === 0 && queue.pending === 0`.

The difference with `.onEmpty` is that `.onIdle` guarantees that all work from the queue has finished. `.onEmpty` merely signals that the queue is empty, but it could mean that some promises haven't completed yet.

#### .clear()

Clear the queue.

#### .size

Size of the queue.

#### .pending

Number of pending promises.

#### .isPaused

Whether the queue is currently paused.


## Events

#### active

Emitted as each item is processed in the queue for the purpose of tracking progress.

```js
const delay = require('delay');
const PQueue = require('p-queue');

const queue = new PQueue({concurrency: 2});

let count = 0;
queue.on('active', () => {
	console.log(`Working on item #${++count}.  Size: ${queue.size}  Pending: ${queue.pending}`);
});

queue.add(() => Promise.resolve());
queue.add(() => delay(2000));
queue.add(() => Promise.resolve());
queue.add(() => Promise.resolve());
queue.add(() => delay(500));
```


## Advanced example

A more advanced example to help you understand the flow.

```js
const delay = require('delay');
const PQueue = require('p-queue');

const queue = new PQueue({concurrency: 1});

(async () => {
	await delay(200);

	console.log(`8. Pending promises: ${queue.pending}`);
	//=> '8. Pending promises: 0'

	(async () => {
		await queue.add(async () => '🐙');
		console.log('11. Resolved')
	})();

	console.log('9. Added 🐙');

	console.log(`10. Pending promises: ${queue.pending}`);
	//=> '10. Pending promises: 1'

	await queue.onIdle();
	console.log('12. All work is done');
})();

(async () => {
	await queue.add(async () => '🦄');
	console.log('5. Resolved')
})();
console.log('1. Added 🦄');

(async () => {
	await queue.add(async () => '🐴');
	console.log('6. Resolved')
})();
console.log('2. Added 🐴');

(async () => {
	await queue.onEmpty();
	console.log('7. Queue is empty');
})();

console.log(`3. Queue size: ${queue.size}`);
//=> '3. Queue size: 1`

console.log(`4. Pending promises: ${queue.pending}`);
//=> '4. Pending promises: 1'
```

```
$ node example.js
1. Added 🦄
2. Added 🐴
3. Queue size: 1
4. Pending promises: 1
5. Resolved 🦄
6. Resolved 🐴
7. Queue is empty
8. Pending promises: 0
9. Added 🐙
10. Pending promises: 1
11. Resolved 🐙
12. All work is done
```


## Custom QueueClass

For implementing more complex scheduling policies, you can provide a QueueClass in the options:

```js
class QueueClass {
	constructor() {
		this._queue = [];
	}
	enqueue(run, options) {
		this._queue.push(run);
	}
	dequeue() {
		return this._queue.shift();
	}
	get size() {
		return this._queue.length;
	}
}
```

`p-queue` will call corresponding methods to put and get operations from this queue.


## Related

- [p-limit](https://github.com/sindresorhus/p-limit) - Run multiple promise-returning & async functions with limited concurrency
- [p-throttle](https://github.com/sindresorhus/p-throttle) - Throttle promise-returning & async functions
- [p-debounce](https://github.com/sindresorhus/p-debounce) - Debounce promise-returning & async functions
- [p-all](https://github.com/sindresorhus/p-all) - Run promise-returning & async functions concurrently with optional limited concurrency
- [More…](https://github.com/sindresorhus/promise-fun)


## License

MIT
