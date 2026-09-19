/**
An error thrown when a task does not settle before its timeout elapses.
*/
export default class TimeoutError extends Error {
	constructor(message = 'Task timed out') {
		super(message);
		this.name = 'TimeoutError';
	}
}
