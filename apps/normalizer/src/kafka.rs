use crate::config::Config;
use rdkafka::{
    ClientConfig,
    admin::{AdminClient, AdminOptions, OwnedResourceSpecifier, ResourceSpecifier},
};
use std::time::Duration;

const RPC_TIMEOUT: Duration = Duration::from_secs(3);

/// Initial topology and transport snapshots; group offsets are resolved by librdkafka.
pub async fn preflight(config: Config) -> Result<(), String> {
    config
        .limits
        .validate()
        .map_err(|error| error.to_string())?;
    config.validate_transport().map_err(str::to_owned)?;
    let declaration = config.clone();
    let admin = tokio::task::spawn_blocking(move || {
        let admin: AdminClient<_> = ClientConfig::new()
            .set("bootstrap.servers", &declaration.bootstrap)
            .set("allow.auto.create.topics", "false")
            .set("socket.timeout.ms", "3000")
            .create()
            .map_err(|error| error.to_string())?;
        // Validate topology while warming this admin client's metadata before DescribeConfigs.
        for (name, count) in [
            (&declaration.raw_topic, declaration.raw_partitions),
            (
                &declaration.normalized_topic,
                declaration.normalized_partitions,
            ),
        ] {
            let metadata = admin
                .inner()
                .fetch_metadata(Some(name), RPC_TIMEOUT)
                .map_err(|error| error.to_string())?;
            let topic = metadata
                .topics()
                .iter()
                .find(|topic| topic.name() == name)
                .ok_or("required topic missing")?;
            if topic.error().is_some()
                || topic
                    .partitions()
                    .iter()
                    .any(|p| p.error().is_some() || p.leader() < 0)
            {
                return Err("required topic unavailable".to_owned());
            }
            let mut ids = topic
                .partitions()
                .iter()
                .map(|p| p.id())
                .collect::<Vec<_>>();
            ids.sort_unstable();
            if ids != (0..count as i32).collect::<Vec<_>>() {
                return Err("topic partition count mismatch".to_owned());
            }
        }
        Ok(admin)
    })
    .await
    .map_err(|_| "startup metadata worker failed")??;
    let results = admin
        .describe_configs(
            &[
                ResourceSpecifier::Topic(&config.raw_topic),
                ResourceSpecifier::Topic(&config.normalized_topic),
            ],
            &AdminOptions::new().request_timeout(Some(RPC_TIMEOUT)),
        )
        .await
        .map_err(|error| error.to_string())?;
    if results.len() != 2 {
        return Err("incomplete topic configuration response".into());
    }
    for result in results {
        let resource = result.map_err(|error| format!("topic configuration: {error:?}"))?;
        let expected = match &resource.specifier {
            OwnedResourceSpecifier::Topic(name) if name == &config.raw_topic => {
                config.raw_broker_max_bytes
            }
            OwnedResourceSpecifier::Topic(name) if name == &config.normalized_topic => {
                config.normalized_broker_max_bytes
            }
            _ => return Err("unexpected topic configuration resource".into()),
        };
        let actual = resource
            .get("max.message.bytes")
            .and_then(|entry| entry.value.as_deref())
            .and_then(|value| value.parse::<usize>().ok());
        if actual != Some(expected) {
            return Err("topic max.message.bytes mismatch".into());
        }
    }
    Ok(())
}
