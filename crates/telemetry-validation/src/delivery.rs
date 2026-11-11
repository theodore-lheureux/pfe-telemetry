use std::net::{IpAddr, SocketAddr};

use prost::Message;
pub use recount_telemetry_schema::wire::{
    CollectorConnection, DeliveryObservation, NetworkInterface,
};

use crate::{Category, Issue};

pub const HEADER: &str = "recount-delivery-bin";
pub const MAX_CONNECTION_BYTES: usize = 4096;
pub const MAX_INTERFACES: usize = 32;
pub const MAX_ADDRESSES: usize = 32;

fn invalid() -> Issue {
    Issue::new(
        Category::Invalid,
        "delivery",
        "invalid bounded connection diagnostics",
    )
}

fn label(value: &str) -> bool {
    !value.is_empty() && value.len() <= 128 && !value.chars().any(char::is_control)
}

pub fn socket_address(value: &str) -> bool {
    value.len() <= 80 && value.parse::<SocketAddr>().is_ok_and(|a| a.port() > 0)
}

pub fn validate_connection(value: &CollectorConnection) -> Result<(), Issue> {
    if value.encoded_len() > MAX_CONNECTION_BYTES
        || !label(&value.connection_id)
        || value.connected_unix_nano == 0
        || !socket_address(&value.local_address)
        || !socket_address(&value.peer_address)
        || value.inventory_observed_unix_nano == 0
        || !label(&value.architecture)
        || [&value.hostname, &value.kernel_release]
            .into_iter()
            .flatten()
            .any(|s| !label(s))
        || !matches!(
            value.inventory_status.as_str(),
            "complete" | "partial" | "unavailable"
        )
        || value.interfaces.len() > MAX_INTERFACES
        || value.local_interface_names.len() > MAX_INTERFACES
        || value.inventory_status == "unavailable"
            && (!value.interfaces.is_empty() || !value.local_interface_names.is_empty())
    {
        return Err(invalid());
    }
    let mut names = std::collections::BTreeSet::new();
    for interface in &value.interfaces {
        if !label(&interface.name)
            || !names.insert(&interface.name)
            || interface.addresses.len() > MAX_ADDRESSES
            || interface
                .addresses
                .iter()
                .any(|a| a.len() > 45 || a.parse::<IpAddr>().is_err())
            || interface.mac_address.as_ref().is_some_and(|mac| {
                mac.len() != 17
                    || !mac.bytes().enumerate().all(|(i, b)| {
                        if i % 3 == 2 {
                            b == b':'
                        } else {
                            b.is_ascii_hexdigit()
                        }
                    })
            })
        {
            return Err(invalid());
        }
    }
    let local = value
        .local_address
        .parse::<SocketAddr>()
        .map_err(|_| invalid())?
        .ip();
    let mut selected = std::collections::BTreeSet::new();
    for name in &value.local_interface_names {
        if !selected.insert(name)
            || !value.interfaces.iter().any(|i| {
                i.name == *name && i.addresses.iter().any(|a| a.parse::<IpAddr>() == Ok(local))
            })
        {
            return Err(invalid());
        }
    }
    Ok(())
}

pub fn decode_connection(bytes: &[u8]) -> Result<CollectorConnection, Issue> {
    if bytes.len() > MAX_CONNECTION_BYTES {
        return Err(Issue::new(
            Category::Limit,
            "delivery",
            "connection diagnostics byte limit",
        ));
    }
    let value = CollectorConnection::decode(bytes).map_err(|_| invalid())?;
    validate_connection(&value)?;
    Ok(value)
}

pub fn validate_observation(value: &DeliveryObservation) -> Result<(), Issue> {
    if let Some(collector) = &value.collector {
        validate_connection(collector)?;
    }
    if value
        .ingestion_peer_address
        .as_ref()
        .is_some_and(|a| !socket_address(a))
    {
        return Err(invalid());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    pub fn connection() -> CollectorConnection {
        CollectorConnection {
            connection_id: "connection-one".into(),
            connected_unix_nano: 1,
            local_address: "10.0.0.2:42000".into(),
            peer_address: "10.0.0.1:4317".into(),
            inventory_observed_unix_nano: 1,
            architecture: "aarch64".into(),
            inventory_status: "complete".into(),
            interfaces: vec![NetworkInterface {
                name: "eth0".into(),
                addresses: vec!["10.0.0.2".into()],
                mac_address: Some("02:00:00:00:00:01".into()),
                up: true,
                ..Default::default()
            }],
            local_interface_names: vec!["eth0".into()],
            ..Default::default()
        }
    }

    #[test]
    fn connection_diagnostics_are_bounded_and_interface_matches_are_checked() {
        let good = connection();
        assert_eq!(decode_connection(&good.encode_to_vec()).unwrap(), good);
        let mut bad = good.clone();
        bad.interfaces[0].addresses = vec!["192.0.2.1".into()];
        assert!(validate_connection(&bad).is_err());
        bad = good.clone();
        bad.interfaces[0].mac_address = Some("not-a-mac".into());
        assert!(validate_connection(&bad).is_err());
        bad = good.clone();
        bad.inventory_status = "unavailable".into();
        assert!(validate_connection(&bad).is_err());
        assert!(decode_connection(&vec![0; MAX_CONNECTION_BYTES + 1]).is_err());
        assert!(decode_connection(b"not protobuf").is_err());
        assert!(!socket_address("198.51.100.1:0"));
        assert!(socket_address("[fe80::1%2]:4317"));
    }
}
