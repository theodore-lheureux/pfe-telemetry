//! A test-owned single-node Kafka broker whose client listener is reached
//! through Toxiproxy, so tests can drop broker responses or restart the broker
//! without touching a shared allocation. Observers use the direct listener.

use rdkafka::{
    ClientConfig,
    consumer::{BaseConsumer, Consumer},
};
use std::{
    net::TcpListener,
    process::{Child, Command, Stdio},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

/// Removes the named container, even if setup failed partway.
struct Container(String);
impl Drop for Container {
    fn drop(&mut self) {
        let _ = Command::new("docker")
            .args(["rm", "--force", "--volumes", &self.0])
            .output();
    }
}

struct Toxiproxy(Child);
impl Drop for Toxiproxy {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

pub struct Broker {
    container: Container,
    _toxiproxy: Toxiproxy,
    api: String,
    /// Bootstrap for components under test; every connection passes the proxy.
    pub proxied: String,
    /// Bootstrap for observers; it bypasses the proxy.
    pub direct: String,
}

fn setting(name: &str) -> String {
    std::env::var(name).unwrap_or_else(|_| panic!("missing explicit integration setting: {name}"))
}

fn free_port() -> u16 {
    TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port()
}

impl Broker {
    pub fn start() -> Self {
        assert_eq!(setting("RECOUNT_KAFKA_FAULT_TEST_ALLOW_CONTAINER"), "1");
        let image = setting("RECOUNT_KAFKA_FAULT_TEST_IMAGE");
        let [upstream, direct, proxied, api] = [(); 4].map(|()| free_port());
        let container = Container(format!(
            "recount-kafka-fault-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let environment = [
            ("KAFKA_NODE_ID", "1".to_owned()),
            ("KAFKA_PROCESS_ROLES", "broker,controller".into()),
            (
                "KAFKA_LISTENERS",
                format!("PROXIED://:{upstream},DIRECT://:{direct},CONTROLLER://:9093"),
            ),
            (
                "KAFKA_ADVERTISED_LISTENERS",
                format!("PROXIED://127.0.0.1:{proxied},DIRECT://127.0.0.1:{direct}"),
            ),
            ("KAFKA_CONTROLLER_LISTENER_NAMES", "CONTROLLER".into()),
            (
                "KAFKA_LISTENER_SECURITY_PROTOCOL_MAP",
                "CONTROLLER:PLAINTEXT,PROXIED:PLAINTEXT,DIRECT:PLAINTEXT".into(),
            ),
            ("KAFKA_CONTROLLER_QUORUM_VOTERS", "1@localhost:9093".into()),
            ("KAFKA_INTER_BROKER_LISTENER_NAME", "DIRECT".into()),
            ("KAFKA_OFFSETS_TOPIC_REPLICATION_FACTOR", "1".into()),
            ("KAFKA_OFFSETS_TOPIC_NUM_PARTITIONS", "1".into()),
            ("KAFKA_TRANSACTION_STATE_LOG_REPLICATION_FACTOR", "1".into()),
            ("KAFKA_TRANSACTION_STATE_LOG_MIN_ISR", "1".into()),
            ("KAFKA_UNCLEAN_LEADER_ELECTION_ENABLE", "false".into()),
            ("KAFKA_AUTO_CREATE_TOPICS_ENABLE", "false".into()),
            ("KAFKA_GROUP_INITIAL_REBALANCE_DELAY_MS", "0".into()),
            ("KAFKA_MESSAGE_MAX_BYTES", "6291456".into()),
            ("KAFKA_REPLICA_FETCH_MAX_BYTES", "6291456".into()),
            ("KAFKA_HEAP_OPTS", "-Xms384m -Xmx384m".into()),
        ];
        let mut run = Command::new("docker");
        run.args([
            "run",
            "--detach",
            "--name",
            &container.0,
            "--label",
            "recount.test=kafka-fault",
            "--memory",
            "1g",
            "--publish",
            &format!("127.0.0.1:{upstream}:{upstream}"),
            "--publish",
            &format!("127.0.0.1:{direct}:{direct}"),
        ]);
        for (key, value) in environment {
            run.args(["--env", key]).env(key, value);
        }
        let output = run.arg(&image).output().unwrap();
        assert!(
            output.status.success(),
            "disposable broker did not start: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        let toxiproxy = Toxiproxy(
            Command::new(setting("RECOUNT_KAFKA_FAULT_TEST_TOXIPROXY"))
                .args(["-host", "127.0.0.1", "-port", &api.to_string()])
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .unwrap(),
        );
        let broker = Self {
            container,
            _toxiproxy: toxiproxy,
            api: format!("http://127.0.0.1:{api}"),
            proxied: format!("127.0.0.1:{proxied}"),
            direct: format!("127.0.0.1:{direct}"),
        };
        eprintln!(
            "disposable_broker container={} proxied={} direct={}",
            broker.container.0, broker.proxied, broker.direct
        );
        let deadline = Instant::now() + Duration::from_secs(10);
        while !broker.toxiproxy_call("GET", "/version", None) {
            assert!(Instant::now() < deadline, "Toxiproxy did not start");
            std::thread::sleep(Duration::from_millis(100));
        }
        assert!(broker.toxiproxy_call(
            "POST",
            "/proxies",
            Some(&format!(
                r#"{{"name":"kafka","listen":"{}","upstream":"127.0.0.1:{upstream}"}}"#,
                broker.proxied
            )),
        ));
        broker.wait_ready();
        broker
    }

    fn toxiproxy_call(&self, method: &str, path: &str, body: Option<&str>) -> bool {
        let mut command = Command::new("curl");
        command
            .args(["--silent", "--fail", "--max-time", "3", "--request", method])
            .arg(format!("{}{path}", self.api))
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        if let Some(body) = body {
            command.args(["--header", "Content-Type: application/json", "--data", body]);
        }
        command.status().is_ok_and(|status| status.success())
    }

    /// Drop every broker-to-client byte while client requests still reach Kafka.
    pub fn drop_responses(&self) {
        assert!(self.toxiproxy_call(
            "POST",
            "/proxies/kafka/toxics",
            Some(r#"{"name":"responses","type":"timeout","stream":"downstream","attributes":{"timeout":0}}"#),
        ));
    }

    pub fn restore_responses(&self) {
        assert!(self.toxiproxy_call("DELETE", "/proxies/kafka/toxics/responses", None));
    }

    /// Stop the broker without a clean shutdown; its container filesystem keeps the log.
    pub fn kill(&self) {
        self.docker(&["kill", "--signal", "KILL", &self.container.0]);
    }

    pub fn restart(&self) {
        self.docker(&["start", &self.container.0]);
        self.wait_ready();
    }

    fn docker(&self, arguments: &[&str]) {
        let output = Command::new("docker").args(arguments).output().unwrap();
        assert!(
            output.status.success(),
            "docker {arguments:?}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }

    fn wait_ready(&self) {
        let deadline = Instant::now() + Duration::from_secs(90);
        for bootstrap in [&self.direct, &self.proxied] {
            let client: BaseConsumer = ClientConfig::new()
                .set("bootstrap.servers", bootstrap)
                .set("log_level", "0")
                .create()
                .unwrap();
            while !client
                .fetch_metadata(None, Duration::from_secs(2))
                .is_ok_and(|metadata| !metadata.brokers().is_empty())
            {
                assert!(Instant::now() < deadline, "disposable broker not ready");
                std::thread::sleep(Duration::from_millis(250));
            }
        }
    }
}
