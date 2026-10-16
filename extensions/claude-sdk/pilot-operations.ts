/** Bounded observation of owned work, not a claim that OS I/O was canceled. */
import { open, unlink, type FileHandle } from "node:fs/promises";

export class PilotOperations {
	private readonly controller = new AbortController();
	private readonly until: number;
	private readonly timer: ReturnType<typeof setTimeout>;
	private readonly pending = new Set<Promise<unknown>>();
	constructor(milliseconds: number, private readonly onDeadline: () => void) {
		this.until = Date.now() + milliseconds;
		this.timer = setTimeout(() => this.expire(), milliseconds);
	}
	get signal(): AbortSignal { return this.controller.signal; }
	get expired(): boolean {
		if (!this.signal.aborted && Date.now() >= this.until) this.expire();
		return this.signal.aborted;
	}
	private expire(): void { if (!this.signal.aborted) { this.onDeadline(); this.cancel(); } }
	cancel(): void { this.controller.abort(); }
	stop(): void { clearTimeout(this.timer); }
	wait<T>(start: () => Promise<T>, startAfterDeadline = false): Promise<T> {
		if (this.expired && !startAfterDeadline) return Promise.reject(new Error("Pilot operation deadline reached"));
		let task: Promise<T>;
		try { task = start(); } catch (error) { return Promise.reject(error); }
		// Retain the actual operation and both settlement handlers after the
		// observer times out. File producers below retain their own cleanup.
		this.pending.add(task);
		void task.then(() => this.pending.delete(task), () => this.pending.delete(task));
		return new Promise<T>((resolve, reject) => {
			const abort = () => reject(new Error("Pilot operation deadline reached"));
			this.signal.addEventListener("abort", abort, { once: true });
			void task.then(value => {
				this.signal.removeEventListener("abort", abort);
				if (this.expired) abort(); else resolve(value);
			}, error => { this.signal.removeEventListener("abort", abort); reject(error); });
			if (this.expired) abort();
		});
	}
}

/** Exclusive creation is the ownership boundary. Never delete an existing file. */
export class OwnedPilotFile {
	private handle: FileHandle | undefined;
	private task: Promise<void> | undefined;
	private removal: Promise<void> | undefined;
	private closing: Promise<void> | undefined;
	private owned = false;
	private pending = false;
	private cleanupFailed = false;
	constructor(private readonly path: string) {}
	write(data: string, operations: PilotOperations): Promise<void> {
		if (this.task) return Promise.reject(new Error("Pilot file already started"));
		this.pending = true;
		this.task = this.produce(data, operations);
		return this.task;
	}
	private async produce(data: string, operations: PilotOperations): Promise<void> {
		const abort = () => {
			// Removal and descriptor close are independent and remain owned if
			// either syscall or the pending write completes after the deadline.
			void this.removeAndClose().catch(() => { this.cleanupFailed = true; });
		};
		try {
			if (operations.expired) throw new Error("Pilot file deadline reached");
			this.handle = await open(this.path, "wx", 0o600);
			this.owned = true;
			operations.signal.addEventListener("abort", abort, { once: true });
			if (operations.expired) throw new Error("Pilot file deadline reached");
			await this.handle.writeFile(data);
		} finally {
			try {
				if (operations.expired) await this.removeAndClose();
				else await this.close();
			} finally {
				operations.signal.removeEventListener("abort", abort);
				this.pending = false;
			}
		}
	}
	private close(): Promise<void> {
		if (!this.handle) return Promise.resolve();
		return this.closing ??= this.handle.close().catch(() => {
			this.cleanupFailed = true;
			throw new Error("Pilot file close failed");
		});
	}
	private remove(): Promise<void> {
		if (!this.owned) return Promise.resolve();
		return this.removal ??= unlink(this.path).then(() => { this.owned = false; }, () => {
			this.cleanupFailed = true;
			throw new Error("Pilot file removal failed");
		});
	}
	private async removeAndClose(): Promise<void> {
		const results = await Promise.allSettled([this.remove(), this.close()]);
		if (results.some(result => result.status === "rejected")) throw new Error("Pilot file cleanup failed");
	}
	async cleanup(): Promise<void> {
		await this.removeAndClose();
		// A failed write is not a failed cleanup; descriptor/removal failures
		// are tracked separately. Waiting here remains bounded by the caller.
		await this.task?.then(() => {}, () => {});
		if (this.pending || this.owned || this.cleanupFailed) throw new Error("Pilot file cleanup unconfirmed");
	}
}
