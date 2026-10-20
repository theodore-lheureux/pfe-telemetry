use std::io;

#[derive(Clone, Copy)]
pub(crate) enum IdentifierKind {
    Machine,
    Boot,
}

pub(crate) fn parse_identifier(value: &str, kind: IdentifierKind) -> io::Result<String> {
    let value = value.trim();
    let expected_len = match kind {
        IdentifierKind::Machine => 32,
        IdentifierKind::Boot => 36,
    };
    let valid = value.len() == expected_len
        && value.bytes().enumerate().all(|(index, byte)| {
            if matches!(kind, IdentifierKind::Boot) && matches!(index, 8 | 13 | 18 | 23) {
                byte == b'-'
            } else if matches!(kind, IdentifierKind::Boot) {
                byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)
            } else {
                byte.is_ascii_hexdigit()
            }
        });
    if !valid {
        return Err(io::Error::other(
            "Missing or invalid Linux machine/boot identifier",
        ));
    }
    Ok(value.into())
}

pub(crate) fn same_incarnation(pid: i32, ticks: u64, current_pid: i32, current_ticks: u64) -> bool {
    pid > 0 && pid == current_pid && ticks == current_ticks
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identifiers_require_their_linux_formats() {
        let machine = "0123456789abcdef0123456789abcdef";
        let boot = "01234567-89ab-cdef-0123-456789abcdef";
        assert_eq!(
            parse_identifier(&format!("{machine}\n"), IdentifierKind::Machine).unwrap(),
            machine
        );
        assert_eq!(parse_identifier(boot, IdentifierKind::Boot).unwrap(), boot);
        assert!(parse_identifier(boot, IdentifierKind::Machine).is_err());
        assert!(parse_identifier(machine, IdentifierKind::Boot).is_err());
        assert!(
            parse_identifier("012345678-9ab-cdef-0123-456789abcdef", IdentifierKind::Boot).is_err()
        );
        assert!(
            parse_identifier("--------------------------------", IdentifierKind::Machine).is_err()
        );
        assert!(
            parse_identifier("g123456789abcdef0123456789abcdef", IdentifierKind::Machine).is_err()
        );
    }

    #[test]
    fn incarnation_requires_both_pid_and_start_ticks() {
        assert!(same_incarnation(42, 100, 42, 100));
        assert!(!same_incarnation(42, 100, 42, 101));
        assert!(!same_incarnation(42, 100, 43, 100));
        assert!(!same_incarnation(0, 100, 0, 100));
    }
}
