import type { LiveEvent } from "./contracts";

export interface ShardTransport {
	end(shard: number): Promise<string>;
	start(
		shard: number,
		from: string,
		signal: AbortSignal,
		receive: (offset: string, event: LiveEvent) => void,
		failed: () => void,
	): { ready: Promise<void>; close(): Promise<void> };
}
type Listener = {
	projectId: string;
	from: bigint;
	receive(event: LiveEvent): void;
	failed(): void;
};
type Shard = {
	listeners: Set<Listener>;
	connection: ReturnType<ShardTransport["start"]>;
	lifetime: AbortController;
	closing?: Promise<void>;
};

export class LiveHub {
	private shards = new Map<number, Shard>();
	private stopped = false;
	constructor(private readonly transport: ShardTransport) {}
	async subscribe(
		shardId: number,
		projectId: string,
		signal: AbortSignal,
		receive: Listener["receive"],
		failed: () => void,
	) {
		if (this.stopped || signal.aborted)
			throw new Error("Live subscription cancelled");
		const from = BigInt(await this.transport.end(shardId));
		let shard = this.shards.get(shardId);
		while (shard?.closing) {
			await shard.closing;
			shard = this.shards.get(shardId);
		}
		if (this.stopped || signal.aborted)
			throw new Error("Live subscription cancelled");
		if (!shard) {
			const listeners = new Set<Listener>();
			const lifetime = new AbortController();
			const connection = this.transport.start(
				shardId,
				from.toString(),
				lifetime.signal,
				(offset, event) => {
					for (const listener of listeners)
						if (
							listener.projectId === event.projectId &&
							BigInt(offset) >= listener.from
						)
							listener.receive(event);
				},
				() => {
					for (const listener of [...listeners]) listener.failed();
				},
			);
			shard = { listeners, connection, lifetime };
			this.shards.set(shardId, shard);
		}
		const owned = shard;
		const listener = { projectId, from, receive, failed };
		owned.listeners.add(listener);
		const unsubscribe = () => {
			signal.removeEventListener("abort", unsubscribe);
			owned.listeners.delete(listener);
			if (!owned.listeners.size) void this.retire(shardId, owned);
		};
		signal.addEventListener("abort", unsubscribe, { once: true });
		try {
			await owned.connection.ready;
			if (signal.aborted || this.stopped)
				throw new Error("Live subscription cancelled");
			return unsubscribe;
		} catch (error) {
			unsubscribe();
			throw error;
		}
	}
	private retire(id: number, shard: Shard) {
		shard.closing ??= (async () => {
			shard.lifetime.abort();
			await shard.connection.close();
			if (this.shards.get(id) === shard) this.shards.delete(id);
		})();
		void shard.closing.catch(() => {});
		return shard.closing;
	}
	async close() {
		this.stopped = true;
		for (const shard of this.shards.values())
			for (const listener of [...shard.listeners]) listener.failed();
		await Promise.all(
			[...this.shards].map(([id, shard]) => this.retire(id, shard)),
		);
	}
}
