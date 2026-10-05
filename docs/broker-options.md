# Broker options

A durable broker can retain telemetry while storage or analysis is interrupted, absorb temporary processing backlogs, and let independent consumers read the same capture. It also adds deployment, monitoring, retention, and failure-handling work.

Post-mortem analysis requires retained measurements. It does not require a broker: raw records in historical storage can also support reanalysis. A broker is useful when ingestion must continue independently of storage processing or when several consumers need their own progress through the incoming stream.

## Candidates

Selection criteria are replay, Rust integration, resource requirements, and operating effort in the local test environment. Resource use and throughput need measurement with representative batches.

| Option           | Advantages                                                                                                                              | Costs and limits                                                                                                                                                                                                                                                                                                                                |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| NATS JetStream   | Persistent streams, replay, independent consumers, a single-server development setup, and the official Tokio-based `async-nats` client. | Retention, acknowledgement, and disk synchronization need explicit configuration. One server has no node redundancy. [JetStream](https://docs.nats.io/concepts/jetstream), [Rust client](https://github.com/nats-io/nats.rs).                                                                                                                   |
| Redpanda         | Kafka-compatible streaming with an administration Console and access to the Kafka client ecosystem.                                     | Topics, partitions, and consumer offsets remain part of the design. Community edition is source-available under BSL; some features require an enterprise license. [Quickstart](https://docs.redpanda.com/streaming/current/get-started/quick-start/), [licensing](https://docs.redpanda.com/streaming/current/get-started/licensing/overview/). |
| Apache Kafka     | Retained partitioned logs, independent consumer groups, replay, replication, and an extensive connector ecosystem.                      | More configuration and operating concepts than a single storage consumer needs. The `rdkafka` Rust client adds native build dependencies. [Kafka quickstart](https://kafka.apache.org/quickstart/), [Rust client](https://github.com/fede1024/rust-rdkafka).                                                                                    |
| RabbitMQ Streams | Persistent replicated logs with offset-based replay and a Rust stream client.                                                           | Streams differ from ordinary queues and use a separate native protocol. Queue acknowledgements alone do not provide retained replay. [Streams](https://www.rabbitmq.com/docs/streams), [Rust tutorial](https://www.rabbitmq.com/tutorials/tutorial-one-rust-stream).                                                                            |
| Redis Streams    | Stream reads, consumer groups, and replay; convenient if Redis is already required elsewhere.                                           | Persistence settings, pending-message recovery, and trimming need care. Redis is not currently a project dependency. [Streaming](https://redis.io/docs/latest/develop/use-cases/streaming/), [persistence](https://redis.io/docs/latest/operate/oss_and_stack/management/persistence/).                                                         |

Apache Iggy is another candidate for exploring Rust infrastructure. It provides persistent streaming, a Rust SDK, and clustering. Its smaller ecosystem presents additional integration risk for the project, and Kafka compatibility is still under development. [Apache Iggy](https://iggy.apache.org/)

## Selection

NATS JetStream is the first candidate for a small pipeline with bounded replay. Kafka becomes a stronger candidate when independent analysis consumers, partitioned processing, and replicated failure experiments are project requirements. Redpanda provides an alternative Kafka-compatible deployment. No broker has been selected or installed.

For JetStream, file-backed storage, a durable pull consumer, and limits retention would fit replay. Work-queue retention removes acknowledged messages. Publication acknowledgement is not necessarily an immediate disk flush, so synchronization settings and failure assumptions still need validation. [Retention](https://docs.nats.io/learn/jetstream/retention-policies), [node loss](https://docs.nats.io/learn/jetstream/surviving-node-loss).

## Kafka deployment

A local Kafka setup can start with one Compose service, a persistent volume, and one topic such as `telemetry.raw` with one partition and one replica. KRaft allows a development process to serve as both broker and controller without ZooKeeper. [Docker setup](https://kafka.apache.org/43/getting-started/docker/), [KRaft](https://kafka.apache.org/43/operations/kraft/).

Only the Rust backend produces and consumes Kafka records. Host applications and container applications need reachable advertised broker addresses. Vagrant collectors use OTLP/gRPC to reach the ingestion server. Topic initialization, health checks, retention, and disk limits belong in the environment configuration. [Advertised listeners](https://kafka.apache.org/43/configuration/broker-configs/#advertised.listeners).

Replication tests can use three combined broker/controller processes, three topic replicas, `acks=all`, and `min.insync.replicas=2`. Separate controller and broker roles are recommended for critical deployments. Three containers on one laptop exercise individual process failures but share the same host failure domain. [KRaft deployment](https://kafka.apache.org/43/operations/kraft/), [replication settings](https://kafka.apache.org/43/configuration/broker-configs/#min.insync.replicas).

## Design justification

Distributed executions can be expensive or difficult to reproduce. Retaining raw telemetry independently of analysis preserves evidence through processing failures and allows corrected analysis to reuse a capture. A broker also gives future consumers their own progress without changing the collector protocol.

These requirements justify evaluating a durable broker. Kafka's additional complexity is justified when its partitioning, independent consumers, and replicated operation are exercised. If one recoverable storage worker meets the requirements, a smaller broker or direct durable storage remains sufficient.

The [reliability scenarios](ingestion-and-reliability.md#validation-scenarios) provide concrete checks for recovery, replay, duplicates, and overload.
