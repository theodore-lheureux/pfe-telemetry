use std::{collections::BTreeMap, fs, net::IpAddr};

use nix::{ifaddrs::getifaddrs, net::if_::InterfaceFlags};
use prost::Message;
use recount_telemetry_validation::delivery::{
    CollectorConnection, MAX_ADDRESSES, MAX_CONNECTION_BYTES, MAX_INTERFACES, NetworkInterface,
};

pub(crate) fn refresh(value: &mut CollectorConnection, observed: u64) {
    value.inventory_observed_unix_nano = observed;
    value.hostname = read_label("/proc/sys/kernel/hostname");
    value.kernel_release = read_label("/proc/sys/kernel/osrelease");
    value.architecture = std::env::consts::ARCH.into();
    value.interfaces.clear();
    value.local_interface_names.clear();
    value.inventory_truncated = false;
    let Ok(addresses) = getifaddrs() else {
        value.inventory_status = "unavailable".into();
        return;
    };
    value.inventory_status = "complete".into();
    let mut interfaces = BTreeMap::<String, NetworkInterface>::new();
    for address in addresses {
        let name = address.interface_name;
        if name.is_empty() || name.len() > 128 || name.chars().any(char::is_control) {
            value.inventory_status = "partial".into();
            continue;
        }
        if !interfaces.contains_key(&name) && interfaces.len() >= MAX_INTERFACES {
            value.inventory_truncated = true;
            continue;
        }
        let interface = interfaces
            .entry(name.clone())
            .or_insert_with(|| NetworkInterface {
                name,
                up: address.flags.contains(InterfaceFlags::IFF_UP),
                loopback: address.flags.contains(InterfaceFlags::IFF_LOOPBACK),
                ..Default::default()
            });
        if let Some(address) = address.address {
            let ip = address
                .as_sockaddr_in()
                .map(|a| IpAddr::V4(a.ip()))
                .or_else(|| address.as_sockaddr_in6().map(|a| IpAddr::V6(a.ip())));
            if let Some(ip) = ip {
                if interface.addresses.len() < MAX_ADDRESSES {
                    interface.addresses.push(ip.to_string());
                } else {
                    value.inventory_truncated = true;
                }
            }
            if !interface.loopback
                && let Some(link) = address.as_link_addr()
                && link.halen() == 6
                && let Some(mac) = link.addr().filter(|a| *a != [0; 6])
            {
                interface.mac_address = Some(
                    mac.iter()
                        .map(|b| format!("{b:02x}"))
                        .collect::<Vec<_>>()
                        .join(":"),
                );
            }
        }
    }
    for mut interface in interfaces.into_values() {
        interface.addresses.sort();
        interface.addresses.dedup();
        value.interfaces.push(interface);
    }
    bound_inventory(value);
}

fn read_label(path: &str) -> Option<String> {
    fs::read_to_string(path).ok().and_then(|s| {
        let s = s.trim();
        (!s.is_empty() && s.len() <= 128 && !s.chars().any(char::is_control)).then(|| s.into())
    })
}

fn bound_inventory(value: &mut CollectorConnection) {
    let local = value
        .local_address
        .parse::<std::net::SocketAddr>()
        .ok()
        .map(|a| a.ip());
    let matches = |i: &NetworkInterface| {
        i.addresses
            .iter()
            .any(|a| a.parse::<IpAddr>().ok() == local)
    };
    // Preserve the socket's assigned interface before unrelated inventory when capped.
    value
        .interfaces
        .sort_by_key(|i| (!matches(i), i.name.clone()));
    value.local_interface_names = value
        .interfaces
        .iter()
        .filter(|i| matches(i))
        .map(|i| i.name.clone())
        .collect();
    while value.encoded_len() > MAX_CONNECTION_BYTES && !value.interfaces.is_empty() {
        value.inventory_truncated = true;
        let removed = value.interfaces.pop().unwrap();
        value
            .local_interface_names
            .retain(|name| *name != removed.name);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use recount_telemetry_validation::delivery::validate_connection;

    fn connection() -> CollectorConnection {
        CollectorConnection {
            connection_id: "connection-one".into(),
            connected_unix_nano: 1,
            local_address: "127.0.0.1:42000".into(),
            peer_address: "127.0.0.1:4317".into(),
            ..Default::default()
        }
    }

    #[test]
    fn linux_inventory_matches_the_real_local_address_without_claiming_physical_egress() {
        let mut value = connection();
        refresh(&mut value, 2);
        validate_connection(&value).unwrap();
        assert!(value.local_interface_names.contains(&"lo".into()));
        assert!(
            value
                .interfaces
                .iter()
                .find(|i| i.name == "lo")
                .unwrap()
                .mac_address
                .is_none()
        );
        assert!(value.hostname.is_some() && value.kernel_release.is_some());
    }

    #[test]
    fn inventory_byte_cap_preserves_matching_interface_and_marks_truncation() {
        let mut value = connection();
        value.inventory_observed_unix_nano = 2;
        value.architecture = "aarch64".into();
        value.inventory_status = "complete".into();
        value.interfaces = (0..MAX_INTERFACES)
            .map(|i| NetworkInterface {
                name: format!("interface-{i:02}"),
                addresses: (0..MAX_ADDRESSES)
                    .map(|j| format!("2001:db8:{i:x}::{j:x}"))
                    .collect(),
                ..Default::default()
            })
            .collect();
        value
            .interfaces
            .last_mut()
            .unwrap()
            .addresses
            .push("127.0.0.1".into());
        value.interfaces.last_mut().unwrap().addresses.remove(0);
        bound_inventory(&mut value);
        assert!(value.inventory_truncated);
        assert_eq!(value.local_interface_names, ["interface-31"]);
        validate_connection(&value).unwrap();
    }
}
