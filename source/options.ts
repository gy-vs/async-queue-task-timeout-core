import {Queue} from './queue';

export interface QueueAddOptions {
	/**
	Per-task timeout in milliseconds. When the timeout elapses before the task settles, the promise returned by `.add()` is rejected with a `TimeoutError`, the concurrency slot is released and the queue moves on to the next task.

	The timer starts when the task begins executing; time spent waiting in the queue does not count towards the timeout.

	Set to `Infinity` to disable the timeout for the task. When `undefined`, the queue-level `timeout` option applies.
	*/
	readonly timeout?: number;

	readonly [key: string]: unknown;
}

export interface Options<QueueType extends Queue<QueueOptions>, QueueOptions extends QueueAddOptions> {
	/**
	Concurrency limit.

	Minimum: `1`.

	@default Infinity
	*/
	readonly concurrency?: number;

	/**
	Whether queue tasks within concurrency limit, are auto-executed as soon as they're added.

	@default true
	*/
	readonly autoStart?: boolean;

	/**
	Class with a `enqueue` and `dequeue` method, and a `size` getter. See the [Custom QueueClass](https://github.com/sindresorhus/p-queue#custom-queueclass) section.
	*/
	readonly queueClass?: new () => QueueType;

	/**
	The max number of runs in the given interval of time.

	Minimum: `1`.

	@default Infinity
	*/
	readonly intervalCap?: number;

	/**
	The length of time in milliseconds before the interval count resets. Must be finite.

	Minimum: `0`.

	@default 0
	*/
	readonly interval?: number;

	/**
	Whether the task must finish in the given interval or will be carried over into the next interval count.

	@default false
	*/
	readonly carryoverConcurrencyCount?: boolean;

	/**
	Default per-task timeout in milliseconds. Can be overridden for individual tasks via the `timeout` option of `.add()`.

	The timer starts when a task begins executing; time spent waiting in the queue does not count towards the timeout.

	Minimum: `0`. May be `Infinity` to disable the timeout.

	@default undefined
	*/
	readonly timeout?: number;
}

export interface DefaultAddOptions extends QueueAddOptions {
	/**
	Priority of operation. Operations with greater priority will be scheduled first.

	@default 0
	*/
	readonly priority?: number;
}
