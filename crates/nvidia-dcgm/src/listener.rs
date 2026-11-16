use std::{fs, io, path::Path};

/// The procfs TCP UID is the kernel's socket owner, not a process name or PID
/// supplied by the peer. Include wildcard/IPv6 listeners and SO_REUSEPORT peers:
/// one root-owned entry must not conceal an unprivileged eligible listener.
pub(crate) fn root_owned() -> bool {
    checked(Path::new("/proc/self/net")).unwrap_or(false)
}

fn checked(net: &Path) -> io::Result<bool> {
    let tcp = fs::read_to_string(net.join("tcp"))?;
    let tcp6 = match fs::read_to_string(net.join("tcp6")) {
        Ok(table) => table,
        // IPv6 can be disabled in the kernel.
        Err(error) if error.kind() == io::ErrorKind::NotFound => String::new(),
        Err(error) => return Err(error),
    };
    Ok(trusted(&tcp, &tcp6))
}

fn trusted(tcp: &str, tcp6: &str) -> bool {
    owners(tcp, false)
        .zip(owners(tcp6, true))
        .is_some_and(|(v4, v6)| {
            (!v4.is_empty() || !v6.is_empty()) && v4.iter().chain(&v6).all(|uid| *uid == 0)
        })
}

fn owners(table: &str, ipv6: bool) -> Option<Vec<u32>> {
    let mut owners = vec![];
    for line in table.lines().skip(1) {
        let fields: Vec<_> = line.split_whitespace().collect();
        let address = *fields.get(1)?;
        let state = *fields.get(3)?;
        if state != "0A" {
            continue;
        }
        let (ip, port) = address.split_once(':')?;
        if port != "15B3" {
            continue;
        }
        if ip.len() != if ipv6 { 32 } else { 8 } || !ip.bytes().all(|b| b.is_ascii_hexdigit()) {
            return None;
        }
        let eligible = if ipv6 {
            // procfs prints each 32-bit address word in native byte order.
            ip == "00000000000000000000000000000000" || ip == mapped_loopback()
        } else {
            ip == "00000000" || ip == loopback()
        };
        if eligible {
            let uid = fields.get(7)?.parse().ok()?;
            let inode: u64 = fields.get(9)?.parse().ok()?;
            if inode == 0 {
                return None;
            }
            owners.push(uid);
        }
    }
    Some(owners)
}

fn loopback() -> &'static str {
    if cfg!(target_endian = "little") {
        "0100007F"
    } else {
        "7F000001"
    }
}

fn mapped_loopback() -> &'static str {
    if cfg!(target_endian = "little") {
        "0000000000000000FFFF00000100007F"
    } else {
        "00000000000000000000FFFF7F000001"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(address: &str, uid: &str, inode: &str) -> String {
        format!("header\n0: {address}:15B3 00000000:0000 0A 0:0 0:0 0 {uid} 0 {inode}\n")
    }

    #[test]
    fn ownership_comes_from_kernel_uid_not_port_or_presence() {
        assert!(trusted(&row(loopback(), "0", "42"), ""));
        assert!(!trusted(&row(loopback(), "1000", "42"), ""));
        assert!(!trusted("header\n", ""));
        assert_eq!(owners(&row(loopback(), "0", "42"), false), Some(vec![0]));
        assert_eq!(
            owners(&row(loopback(), "1000", "42"), false),
            Some(vec![1000])
        );
        assert_eq!(owners("header\n", false), Some(vec![]));
        for (uid, inode) in [("?", "42"), ("0", "?"), ("0", "0")] {
            assert_eq!(owners(&row(loopback(), uid, inode), false), None);
            assert!(!trusted(&row(loopback(), uid, inode), ""));
        }
        assert_eq!(owners("header\nmalformed\n", false), None);
    }

    #[test]
    fn wildcard_ipv6_and_reuseport_owners_are_not_ignored() {
        assert_eq!(
            owners(&row("00000000", "1000", "42"), false),
            Some(vec![1000])
        );
        for ip in ["00000000000000000000000000000000", mapped_loopback()] {
            assert_eq!(owners(&row(ip, "1000", "42"), true), Some(vec![1000]));
            assert!(!trusted(
                &row(loopback(), "0", "41"),
                &row(ip, "1000", "42")
            ));
        }
        let table = row(loopback(), "0", "42")
            + &row(loopback(), "1000", "43")
                .lines()
                .skip(1)
                .collect::<Vec<_>>()
                .join("\n");
        assert_eq!(owners(&table, false), Some(vec![0, 1000]));
        assert!(!trusted(&table, ""));
        let elsewhere = row("0200007F", "1000", "42");
        assert_eq!(owners(&elsewhere, false), Some(vec![]));
        assert_eq!(
            owners(&row(loopback(), "0", "42").replace(" 0A ", " 01 "), false),
            Some(vec![])
        );
    }

    #[test]
    fn unreadable_procfs_falls_back_to_embedded() {
        assert!(checked(Path::new("/proc/self/net/no-such-directory")).is_err());
    }
}
