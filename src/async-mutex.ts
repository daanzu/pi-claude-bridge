/** A small FIFO async mutex with abortable waiters. */
export class AsyncMutex {
	private locked = false;
	private readonly waiters: Array<{
		resolve: (acquired: boolean) => void;
		signal?: AbortSignal;
		onAbort?: () => void;
	}> = [];

	async run<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
		const acquired = await this.acquire(signal);
		if (!acquired) throw abortError();
		try {
			if (signal?.aborted) throw abortError();
			return await operation();
		} finally {
			this.release();
		}
	}

	private acquire(signal?: AbortSignal): Promise<boolean> {
		if (signal?.aborted) return Promise.resolve(false);
		if (!this.locked) {
			this.locked = true;
			return Promise.resolve(true);
		}

		return new Promise<boolean>((resolve) => {
			const waiter: (typeof this.waiters)[number] = { resolve, signal };
			if (signal) {
				waiter.onAbort = () => {
					const index = this.waiters.indexOf(waiter);
					if (index === -1) return;
					this.waiters.splice(index, 1);
					resolve(false);
				};
				signal.addEventListener("abort", waiter.onAbort, { once: true });
			}
			this.waiters.push(waiter);
		});
	}

	private release(): void {
		for (;;) {
			const waiter = this.waiters.shift();
			if (!waiter) {
				this.locked = false;
				return;
			}
			if (waiter.onAbort) waiter.signal?.removeEventListener("abort", waiter.onAbort);
			if (waiter.signal?.aborted) {
				waiter.resolve(false);
				continue;
			}
			waiter.resolve(true);
			return;
		}
	}
}

function abortError(): Error {
	const error = new Error("Operation aborted");
	error.name = "AbortError";
	return error;
}
