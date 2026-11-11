use clap::Parser;
use recount_telemetry_schema::ddl::{Batching, FLUSH_MS, Schema};
use recount_telemetry_validation::transport::{
    ConsumerBudget, MAX_BROKER_BYTES, MAX_OUTPUT_ROWS, NORMALIZED_BROKER_BYTES, OUTPUT_ROWS,
};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    env, fs, io,
    path::{Path, PathBuf},
};

type Result<T> = std::result::Result<T, Box<dyn std::error::Error>>;
const PROTO: &str = include_str!("../../telemetry-schema/proto/recount.proto");
const GENERATOR: &str = include_str!("../../telemetry-schema/build.rs");
const DDL: &str = include_str!("../../../infra/clickhouse/schema.sql.in");
const RENDERER: &str = include_str!("../../telemetry-schema/src/ddl.rs");
const SCHEMA_LIBRARY: &str = include_str!("../../telemetry-schema/src/lib.rs");
const COLUMNS: &str = recount_telemetry_schema::ANALYTICAL_COLUMNS;
const TRANSPORT: &str = include_str!("../src/transport.rs");

#[derive(Parser)]
#[command(
    name = "recount-schema-export",
    version,
    about = "Prepare a trusted current ClickHouse schema bundle"
)]
struct Options {
    #[arg(long)]
    output: PathBuf,
    #[arg(long = "source-root", default_value = ".")]
    source: PathBuf,
    #[arg(long, default_value = "kafka:9092")]
    bootstrap: String,
    #[arg(long = "normalized-topic", env = "RECOUNT_NORMALIZED_TOPIC", default_value = recount_telemetry_schema::NORMALIZED_TOPIC)]
    topic: String,
    #[arg(long = "consumer-group", default_value = recount_telemetry_schema::CLICKHOUSE_GROUP)]
    group: String,
    /// Native insert partition ceiling; Kafka records always carry exactly one point.
    #[arg(long = "output-rows", env = "RECOUNT_NORMALIZER_OUTPUT_ROWS", default_value_t = OUTPUT_ROWS, value_parser = clap::value_parser!(u32).range(1..=MAX_OUTPUT_ROWS as i64))]
    rows: u32,
    /// Declared normalized topic capacity, used to derive native consumer buffers.
    #[arg(long, env = "RECOUNT_NORMALIZED_BROKER_MAX_BYTES", default_value_t = NORMALIZED_BROKER_BYTES, value_parser = clap::value_parser!(u32).range(1000..=MAX_BROKER_BYTES as i64))]
    normalized_broker_max_bytes: u32,
    /// Protocol-wide response ceiling, including metadata. Omitted: max(6 MiB, fetch + 512).
    #[arg(long, env = "RECOUNT_KAFKA_RECEIVE_BYTES", value_parser = clap::value_parser!(u32).range(1000..=i32::MAX as i64))]
    kafka_receive_bytes: Option<u32>,
    #[arg(long = "poll-ms", default_value_t = 100, value_parser = clap::value_parser!(u32).range(1..=i32::MAX as i64))]
    poll: u32,
    #[arg(long = "flush-ms", default_value_t = FLUSH_MS, value_parser = clap::value_parser!(u32).range(1..=i32::MAX as i64))]
    flush: u32,
}

fn invalid(message: &str) -> io::Error {
    io::Error::other(message)
}

fn digest(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn verify_source(root: &Path) -> Result<()> {
    for (name, compiled) in [
        ("crates/telemetry-schema/proto/recount.proto", PROTO),
        ("crates/telemetry-schema/build.rs", GENERATOR),
        ("infra/clickhouse/schema.sql.in", DDL),
        ("crates/telemetry-schema/src/ddl.rs", RENDERER),
        ("crates/telemetry-schema/src/lib.rs", SCHEMA_LIBRARY),
        ("crates/telemetry-validation/src/transport.rs", TRANSPORT),
    ] {
        if fs::read(root.join(name))? != compiled.as_bytes() {
            return Err(invalid(&format!(
                "compiled schema exporter is stale: {name} differs"
            ))
            .into());
        }
    }
    Ok(())
}

fn prepare(options: &Options) -> Result<()> {
    verify_source(&options.source)?;
    let budget = ConsumerBudget::normalized(options.normalized_broker_max_bytes as usize)?;
    let default_receive = budget.receive_bytes;
    let budget = budget.with_receive_limit(options.kafka_receive_bytes.map(|v| v as usize))?;
    let batching = Batching::for_partition_limit(options.rows)?;
    let sql = Schema {
        database: "telemetry",
        bootstrap: &options.bootstrap,
        topic: &options.topic,
        group: &options.group,
        partition_limit: options.rows,
        poll_ms: options.poll,
        flush_ms: options.flush,
        if_not_exists: true,
    }
    .render()?;
    let columns = COLUMNS.trim();
    let expected = columns
        .lines()
        .map(|line| {
            let (name, kind) = line
                .trim()
                .trim_end_matches(',')
                .split_once(' ')
                .expect("generated name/type column");
            format!("{name}\t{kind}\n")
        })
        .collect::<String>();
    let artifacts = BTreeMap::from([
        ("schemas/recount.proto", PROTO.to_owned()),
        ("schema.sql", sql),
        ("analytical-columns.sql", format!("{columns}\n")),
        ("expected-columns.tsv", expected),
        ("output-rows", format!("{}\n", options.rows)),
        ("default-output-rows", format!("{OUTPUT_ROWS}\n")),
        ("kafka-receive-bytes", format!("{}\n", budget.receive_bytes)),
        (
            "default-kafka-receive-bytes",
            format!("{default_receive}\n"),
        ),
        (
            "normalized-broker-max-bytes",
            format!("{}\n", options.normalized_broker_max_bytes),
        ),
        (
            "default-normalized-broker-max-bytes",
            format!("{NORMALIZED_BROKER_BYTES}\n"),
        ),
        (
            "native-transport.xml",
            format!(
                "<clickhouse><kafka><consumer><message_max_bytes>{}</message_max_bytes><fetch_max_bytes>{}</fetch_max_bytes><fetch_message_max_bytes>{}</fetch_message_max_bytes><receive_message_max_bytes>{}</receive_message_max_bytes><queued_max_messages_kbytes>{}</queued_max_messages_kbytes></consumer></kafka></clickhouse>\n",
                budget.partition_bytes,
                budget.fetch_bytes,
                budget.partition_bytes,
                budget.receive_bytes,
                budget.queued_kib
            ),
        ),
        (
            "native-profile.xml",
            format!(
                "<clickhouse><profiles><default><max_partitions_per_insert_block>{}</max_partitions_per_insert_block><throw_on_max_partitions_per_insert_block>1</throw_on_max_partitions_per_insert_block></default></profiles></clickhouse>\n",
                options.rows
            ),
        ),
    ]);
    let hashes: BTreeMap<_, _> = artifacts
        .iter()
        .map(|(name, body)| (*name, digest(body.as_bytes())))
        .collect();
    // A partial or existing bundle requires inspection, never overwrite/repair.
    if let Some(parent) = options
        .output
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
    {
        fs::create_dir_all(parent)?;
    }
    fs::create_dir(&options.output)?;
    fs::create_dir(options.output.join("schemas"))?;
    for (name, body) in artifacts {
        fs::write(options.output.join(name), body)?;
    }
    fs::write(
        options.output.join("SHA256SUMS"),
        hashes
            .iter()
            .map(|(name, hash)| format!("{hash}  {name}\n"))
            .collect::<String>(),
    )?;
    let manifest = serde_json::json!({
        "clickhouse_version": "26.8.34.13", "bootstrap": options.bootstrap,
        "normalized_topic": options.topic, "block_rows": batching.block_rows,
        "poll_messages": batching.poll_messages, "maximum_block_rows": batching.maximum_rows(),
        "output_rows": options.rows,
        "database": "telemetry", "consumer_group": options.group,
        "kafka_format": "ProtobufSingle", "point_rows": 1,
        "normalized_broker_max_bytes": options.normalized_broker_max_bytes,
        "kafka_receive_bytes": budget.receive_bytes,
        "poll_ms": options.poll, "flush_ms": options.flush, "sha256": hashes,
        "exporter_sha256": digest(&fs::read(env::current_exe()?)?),
        "generator_sha256": digest(GENERATOR.as_bytes()),
        "renderer_sha256": digest(RENDERER.as_bytes()),
    });
    fs::write(
        options.output.join("manifest.json"),
        format!("{}\n", serde_json::to_string_pretty(&manifest)?),
    )?;
    Ok(())
}

fn main() -> Result<()> {
    prepare(&Options::parse())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;
    use std::sync::atomic::{AtomicU64, Ordering};
    static NEXT_DIRECTORY: AtomicU64 = AtomicU64::new(0);
    fn directory() -> PathBuf {
        let path = env::temp_dir().join(format!(
            "recount-schema-{}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
            NEXT_DIRECTORY.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&path).unwrap();
        path
    }
    fn write_source(root: &Path) {
        for (name, compiled) in [
            ("crates/telemetry-schema/proto/recount.proto", PROTO),
            ("crates/telemetry-schema/build.rs", GENERATOR),
            ("infra/clickhouse/schema.sql.in", DDL),
            ("crates/telemetry-schema/src/ddl.rs", RENDERER),
            ("crates/telemetry-schema/src/lib.rs", SCHEMA_LIBRARY),
            ("crates/telemetry-validation/src/transport.rs", TRANSPORT),
        ] {
            fs::create_dir_all(root.join(name).parent().unwrap()).unwrap();
            fs::write(root.join(name), compiled).unwrap();
        }
    }
    #[test]
    fn bounds_and_repeated_options_fail() {
        for args in [
            vec!["--output", "x", "--output-rows", "0"],
            vec!["--output", "x", "--output-rows", "16385"],
            vec!["--output", "x", "--output", "y"],
            vec!["--unknown", "x"],
        ] {
            assert!(
                Options::try_parse_from(std::iter::once("recount-schema-export").chain(args))
                    .is_err()
            );
        }
    }

    #[test]
    fn protocol_response_override_is_exported_and_rejected_below_fetch_headroom() {
        let parent = directory();
        write_source(&parent);
        let mut options = Options {
            output: parent.join("custom-receive"),
            source: parent.clone(),
            bootstrap: "kafka:9092".into(),
            topic: "recount.test.normalized".into(),
            group: recount_telemetry_schema::CLICKHOUSE_GROUP.into(),
            rows: OUTPUT_ROWS,
            normalized_broker_max_bytes: 65_537,
            kafka_receive_bytes: Some(12_582_912),
            poll: 100,
            flush: 1000,
        };
        prepare(&options).unwrap();
        assert!(
            fs::read_to_string(options.output.join("native-transport.xml"))
                .unwrap()
                .contains("<receive_message_max_bytes>12582912</receive_message_max_bytes>")
        );
        options.output = parent.join("rejected-receive");
        options.kafka_receive_bytes = Some(66_048);
        assert!(prepare(&options).is_err());
        assert!(!options.output.exists());
        fs::remove_dir_all(parent).unwrap();
    }
    #[test]
    fn bundles_are_deterministic_pinned_and_never_overwritten() {
        let parent = directory();
        let source = parent.join("source");
        write_source(&source);
        let make = |name: &str| Options {
            output: parent.join(name),
            source: source.clone(),
            bootstrap: "kafka:9092".into(),
            topic: "recount.test.normalized".into(),
            group: "recount.test.consumer".into(),
            rows: 64,
            normalized_broker_max_bytes: 3_000_000,
            kafka_receive_bytes: None,
            poll: 100,
            flush: 1000,
        };
        let first = make("first");
        let second = make("second");
        prepare(&first).unwrap();
        prepare(&second).unwrap();
        assert_eq!(
            fs::read(first.output.join("SHA256SUMS")).unwrap(),
            fs::read(second.output.join("SHA256SUMS")).unwrap()
        );
        let before = fs::read(first.output.join("manifest.json")).unwrap();
        assert!(prepare(&first).is_err());
        assert_eq!(
            before,
            fs::read(first.output.join("manifest.json")).unwrap()
        );
        let manifest: serde_json::Value = serde_json::from_slice(&before).unwrap();
        for (name, hash) in manifest["sha256"].as_object().unwrap() {
            assert_eq!(
                hash.as_str().unwrap(),
                digest(&fs::read(first.output.join(name)).unwrap())
            );
        }
        assert_eq!(manifest["output_rows"], 64);
        assert_eq!(manifest["block_rows"], 64);
        assert_eq!(manifest["poll_messages"], 1);
        assert_eq!(manifest["maximum_block_rows"], 64);
        assert_eq!(manifest["consumer_group"], "recount.test.consumer");
        assert_eq!(manifest["point_rows"], 1);
        assert_eq!(manifest["kafka_format"], "ProtobufSingle");
        assert!(
            fs::read_to_string(first.output.join("schema.sql"))
                .unwrap()
                .contains("kafka_format = 'ProtobufSingle'")
        );
        assert_eq!(manifest["normalized_broker_max_bytes"], 3_000_000);
        let transport = fs::read_to_string(first.output.join("native-transport.xml")).unwrap();
        assert!(transport.contains("<fetch_max_bytes>3000000</fetch_max_bytes>"));
        assert!(
            transport.contains("<receive_message_max_bytes>6291456</receive_message_max_bytes>")
        );
        assert_eq!(
            fs::read_to_string(first.output.join("output-rows")).unwrap(),
            "64\n"
        );
        assert!(
            fs::read_to_string(first.output.join("native-profile.xml"))
                .unwrap()
                .contains("<max_partitions_per_insert_block>64</max_partitions_per_insert_block>")
        );
        let empty = make("empty");
        fs::create_dir(&empty.output).unwrap();
        assert!(prepare(&empty).is_err());
        fs::remove_dir_all(parent).unwrap();
    }
    #[test]
    fn stale_sources_are_rejected_before_output_creation() {
        let parent = directory();
        write_source(&parent);
        verify_source(&parent).unwrap();
        let options = Options {
            output: parent.join("not-created"),
            source: parent.clone(),
            bootstrap: "kafka:9092".into(),
            topic: "recount.test.normalized".into(),
            group: recount_telemetry_schema::CLICKHOUSE_GROUP.into(),
            rows: 128,
            normalized_broker_max_bytes: NORMALIZED_BROKER_BYTES,
            kafka_receive_bytes: None,
            poll: 100,
            flush: 1000,
        };
        for name in [
            "crates/telemetry-schema/proto/recount.proto",
            "crates/telemetry-schema/build.rs",
            "infra/clickhouse/schema.sql.in",
            "crates/telemetry-schema/src/ddl.rs",
            "crates/telemetry-validation/src/transport.rs",
        ] {
            let path = parent.join(name);
            let original = fs::read(&path).unwrap();
            fs::write(&path, "stale").unwrap();
            assert!(prepare(&options).unwrap_err().to_string().contains("stale"));
            assert!(!options.output.exists());
            fs::write(path, original).unwrap();
        }
        let changed_group = SCHEMA_LIBRARY.replace(
            &format!(
                "pub const CLICKHOUSE_GROUP: &str = {:?};",
                recount_telemetry_schema::CLICKHOUSE_GROUP
            ),
            "pub const CLICKHOUSE_GROUP: &str = \"changed-group\";",
        );
        assert_ne!(changed_group, SCHEMA_LIBRARY);
        fs::write(
            parent.join("crates/telemetry-schema/src/lib.rs"),
            changed_group,
        )
        .unwrap();
        let error = prepare(&options).unwrap_err().to_string();
        assert!(error.contains("stale") && error.contains("crates/telemetry-schema/src/lib.rs"));
        assert!(!options.output.exists());
        fs::remove_dir_all(parent).unwrap();
    }

    #[test]
    fn offline_bundle_guard_rejects_runtime_mismatches_and_schema_tampering() {
        let parent = directory();
        write_source(&parent);
        for (name, rows, topic_bytes, receive_override) in [
            ("defaults", OUTPUT_ROWS, NORMALIZED_BROKER_BYTES, None),
            ("custom", 64, 3_000_000, None),
            (
                "receive",
                OUTPUT_ROWS,
                NORMALIZED_BROKER_BYTES,
                Some(12_582_912),
            ),
        ] {
            let options = Options {
                output: parent.join(name),
                source: parent.clone(),
                bootstrap: "kafka:9092".into(),
                topic: "recount.test.normalized".into(),
                group: recount_telemetry_schema::CLICKHOUSE_GROUP.into(),
                rows,
                normalized_broker_max_bytes: topic_bytes,
                kafka_receive_bytes: receive_override,
                poll: 100,
                flush: 1000,
            };
            prepare(&options).unwrap();
            let pinned = parent.join(format!("{name}-pinned"));
            fs::copy(options.output.join("SHA256SUMS"), &pinned).unwrap();
            // Exercise the real shell guard with isolated mount paths and only
            // its installed-version probe substituted; no server is started.
            let quote =
                |path: &Path| format!("'{}'", path.to_str().unwrap().replace('\'', "'\\''"));
            let script = include_str!("../../../infra/clickhouse/verify-schema.sh")
                .replace("/etc/recount-schema", &quote(&options.output))
                .replace("/usr/share/recount-schema/SHA256SUMS", &quote(&pinned))
                .replace(
                    "/etc/clickhouse-server/config.d/native-transport.xml",
                    &quote(&options.output.join("native-transport.xml")),
                )
                .replace(
                    "/etc/clickhouse-server/format_schemas/recount.proto",
                    &quote(&options.output.join("schemas/recount.proto")),
                )
                .replace(
                    "clickhouse-client --version",
                    "printf 'ClickHouse client version 26.8.34.13\\n'",
                );
            let check = parent.join(format!("{name}-verify.sh"));
            fs::write(&check, script).unwrap();
            let run = |rows: Option<u32>, bytes: Option<u32>, receive: Option<u32>| {
                let mut command = Command::new("sh");
                command
                    .arg(&check)
                    .env_clear()
                    .env("PATH", env::var_os("PATH").unwrap());
                if let Some(rows) = rows {
                    command.env("RECOUNT_NORMALIZER_OUTPUT_ROWS", rows.to_string());
                }
                if let Some(bytes) = bytes {
                    command.env("RECOUNT_NORMALIZED_BROKER_MAX_BYTES", bytes.to_string());
                }
                if let Some(receive) = receive {
                    command.env("RECOUNT_KAFKA_RECEIVE_BYTES", receive.to_string());
                }
                command.output().unwrap().status.success()
            };
            assert_eq!(run(None, None, None), name == "defaults");
            assert!(run(Some(rows), Some(topic_bytes), receive_override));
            assert!(!run(Some(rows + 1), Some(topic_bytes), receive_override));
            assert!(!run(Some(rows), Some(topic_bytes + 1), receive_override));
            assert!(!run(Some(rows), Some(topic_bytes), Some(13_000_000)));
            let schema = options.output.join("schema.sql");
            let original = fs::read_to_string(&schema).unwrap();
            let changed_group = original.replace(
                &format!(
                    "kafka_group_name = '{}'",
                    recount_telemetry_schema::CLICKHOUSE_GROUP
                ),
                "kafka_group_name = 'changed-group'",
            );
            assert_ne!(changed_group, original);
            fs::write(&schema, changed_group).unwrap();
            assert!(!run(Some(rows), Some(topic_bytes), receive_override));
            fs::write(&schema, original).unwrap();
            assert!(run(Some(rows), Some(topic_bytes), receive_override));
            fs::write(&schema, "synthetic schema mismatch\n").unwrap();
            assert!(!run(Some(rows), Some(topic_bytes), receive_override));
        }
        fs::remove_dir_all(parent).unwrap();
    }
}
