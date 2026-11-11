use crate::authority::identifier;
use recount_telemetry_schema::{
    common::{KeyValue, any_value::Value},
    identity::{TypedHash, hex},
    point::string_attribute,
};

pub const ADAPTER: &str = "linux";
pub const HOST_ID: &str = "host.id";
pub const BOOT_ID: &str = "recount.host.boot_id";
pub const SCOPE: &str = "recount.collection.scope";
pub const EPOCH_ID: &str = "recount.collection.epoch_id";
pub const INTERVAL_NS: &str = "recount.collection.interval_ns";
pub const VISIBILITY: &str = "recount.collection.visibility";
pub const PID: &str = "process.pid";
pub const PARENT_PID: &str = "process.parent_pid";
pub const NAMESPACE_ID: &str = "recount.process.namespace_id";
pub const START_TICKS: &str = "recount.process.start_time_ticks";
pub const INCARNATION_ID: &str = "recount.process.incarnation_id";
pub const CLOCK_TICKS: &str = "recount.linux.clock_ticks_per_second";

#[derive(Clone, Copy)]
pub enum IdentifierKind {
    Machine,
    Boot,
}

pub fn parse_identifier(value: &str, kind: IdentifierKind) -> Option<&str> {
    let value = value.trim();
    let expected_len = match kind {
        IdentifierKind::Machine => 32,
        IdentifierKind::Boot => 36,
    };
    (value.len() == expected_len
        && value.bytes().enumerate().all(|(index, byte)| {
            if matches!(kind, IdentifierKind::Boot) && matches!(index, 8 | 13 | 18 | 23) {
                byte == b'-'
            } else if matches!(kind, IdentifierKind::Boot) {
                byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)
            } else {
                byte.is_ascii_hexdigit()
            }
        }))
    .then_some(value)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Scope {
    Node,
    Process,
    Collector,
}

impl Scope {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Node => "node",
            Self::Process => "process",
            Self::Collector => "collector",
        }
    }
}

pub struct ProcessIdentity<'a> {
    pub boot: &'a str,
    pub namespace: &'a str,
    pub pid: u64,
    pub start_ticks: u64,
}

impl ProcessIdentity<'_> {
    pub fn incarnation(&self) -> String {
        let mut hash = TypedHash::new("recount.linux-process");
        hash.field(self.boot.as_bytes());
        hash.field(self.namespace.as_bytes());
        hash.u64(self.pid);
        hash.u64(self.start_ticks);
        hex(&hash.finish())
    }
}

pub struct ResourceIdentity<'a> {
    pub host: &'a str,
    pub scope: Scope,
    pub process: Option<ProcessIdentity<'a>>,
}

pub fn resource_identity(attrs: &[KeyValue]) -> Result<ResourceIdentity<'_>, crate::Issue> {
    let invalid = || {
        crate::Issue::new(
            crate::Category::Invalid,
            "resource.attributes",
            "Missing or invalid Linux resource identity",
        )
    };
    let required = |key| {
        string_attribute(attrs, key)
            .filter(|v| identifier(v))
            .ok_or_else(invalid)
    };
    let host = required(HOST_ID)?;
    let boot = required(BOOT_ID)?;
    if parse_identifier(boot, IdentifierKind::Boot) != Some(boot) {
        return Err(invalid());
    }
    let scope = match required(SCOPE)? {
        "node" => Scope::Node,
        "process" => Scope::Process,
        "collector" => Scope::Collector,
        _ => {
            return Err(crate::Issue::new(
                crate::Category::Unsupported,
                SCOPE,
                "Unsupported Linux collection scope",
            ));
        }
    };
    required(EPOCH_ID)?;
    let process = if scope == Scope::Process {
        let pid = attrs
            .iter()
            .find(|a| a.key == PID)
            .and_then(|a| a.value.as_ref())
            .and_then(|v| match v.value {
                Some(Value::IntValue(v)) if v > 0 => Some(v as u64),
                _ => None,
            })
            .ok_or_else(invalid)?;
        Some(ProcessIdentity {
            boot,
            namespace: required(NAMESPACE_ID)?,
            pid,
            start_ticks: required(START_TICKS)?.parse().map_err(|_| invalid())?,
        })
    } else {
        None
    };
    Ok(ResourceIdentity {
        host,
        scope,
        process,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use recount_telemetry_schema::common::AnyValue;

    fn attribute(key: &str, value: Value) -> KeyValue {
        KeyValue {
            key: key.into(),
            value: Some(AnyValue { value: Some(value) }),
            ..Default::default()
        }
    }

    fn process() -> Vec<KeyValue> {
        let mut attrs = [
            (HOST_ID, "host"),
            (BOOT_ID, "01234567-89ab-cdef-0123-456789abcdef"),
            (SCOPE, "process"),
            (EPOCH_ID, "epoch"),
            (NAMESPACE_ID, "namespace"),
            (START_TICKS, "100"),
        ]
        .into_iter()
        .map(|(key, value)| attribute(key, Value::StringValue(value.into())))
        .collect::<Vec<_>>();
        attrs.push(attribute(PID, Value::IntValue(42)));
        attrs
    }

    #[test]
    fn identifiers_require_linux_formats_but_acquisition_may_trim_newlines() {
        let machine = "0123456789abcdef0123456789abcdef";
        let boot = "01234567-89ab-cdef-0123-456789abcdef";
        assert_eq!(
            parse_identifier(&format!("{machine}\n"), IdentifierKind::Machine),
            Some(machine)
        );
        assert_eq!(
            parse_identifier(&format!("{boot}\n"), IdentifierKind::Boot),
            Some(boot)
        );
        for invalid in [
            machine,
            "012345678-9ab-cdef-0123-456789abcdef",
            "01234567-89AB-cdef-0123-456789abcdef",
        ] {
            assert!(parse_identifier(invalid, IdentifierKind::Boot).is_none());
        }
        for invalid in [
            boot,
            "--------------------------------",
            "g123456789abcdef0123456789abcdef",
        ] {
            assert!(parse_identifier(invalid, IdentifierKind::Machine).is_none());
        }
    }

    #[test]
    fn process_incarnation_uses_pid_ticks_boot_and_namespace_not_attribute_order() {
        let mut attrs = process();
        let original = resource_identity(&attrs)
            .unwrap()
            .process
            .unwrap()
            .incarnation();
        attrs.reverse();
        assert_eq!(
            resource_identity(&attrs)
                .unwrap()
                .process
                .unwrap()
                .incarnation(),
            original
        );
        for (key, value) in [
            (PID, Value::IntValue(43)),
            (START_TICKS, Value::StringValue("101".into())),
            (
                BOOT_ID,
                Value::StringValue("11234567-89ab-cdef-0123-456789abcdef".into()),
            ),
            (NAMESPACE_ID, Value::StringValue("other".into())),
        ] {
            let mut changed = attrs.clone();
            *changed.iter_mut().find(|a| a.key == key).unwrap() = attribute(key, value);
            assert_ne!(
                resource_identity(&changed)
                    .unwrap()
                    .process
                    .unwrap()
                    .incarnation(),
                original
            );
        }
    }

    #[test]
    fn required_identity_fails_closed_without_imposing_process_fields_on_node() {
        for key in [
            HOST_ID,
            BOOT_ID,
            EPOCH_ID,
            SCOPE,
            PID,
            START_TICKS,
            NAMESPACE_ID,
        ] {
            let mut attrs = process();
            attrs.retain(|a| a.key != key);
            assert!(resource_identity(&attrs).is_err(), "{key}");
        }
        for (key, value) in [
            (HOST_ID, Value::StringValue("bad\nhost".into())),
            (PID, Value::IntValue(0)),
            (PID, Value::StringValue("42".into())),
            (
                START_TICKS,
                Value::StringValue("18446744073709551616".into()),
            ),
            (
                BOOT_ID,
                Value::StringValue("01234567-89ab-cdef-0123-456789abcdef\n".into()),
            ),
            (NAMESPACE_ID, Value::StringValue("bad\nnamespace".into())),
        ] {
            let mut attrs = process();
            *attrs.iter_mut().find(|a| a.key == key).unwrap() = attribute(key, value);
            assert!(resource_identity(&attrs).is_err(), "{key}");
        }
        let mut attrs = process();
        attrs.retain(|a| ![PID, START_TICKS, NAMESPACE_ID].contains(&a.key.as_str()));
        *attrs.iter_mut().find(|a| a.key == SCOPE).unwrap() =
            attribute(SCOPE, Value::StringValue("node".into()));
        assert!(resource_identity(&attrs).unwrap().process.is_none());
    }
}
