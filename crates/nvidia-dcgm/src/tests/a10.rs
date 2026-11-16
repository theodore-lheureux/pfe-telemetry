use super::a10_fixture;
use crate::{FIELDS, Field, Value, decode};
use std::fmt::Write;

#[test]
fn recorded_a10_values_decode_without_adding_an_unoffered_fp64_field() {
    let offered: Vec<_> = a10_fixture::groups()
        .into_iter()
        .flat_map(|(_, _, fields)| fields)
        .collect();
    assert_eq!(offered.len(), 11);
    assert!(!offered.contains(&(Field::Fp64 as u16)));
    for (index, sample) in a10_fixture::samples().iter().enumerate() {
        assert!(sample.source_line > 0);
        assert_eq!(
            sample.value(203),
            if sample.phase == "idle" { "0" } else { "100" }
        );
        let time_us = 1_000_000 + index as i64 * 1_000_000;
        assert!(!sample.fields.iter().any(|(id, _)| *id == 1006));
        for (id, text) in &sample.fields {
            let field = *FIELDS.iter().find(|field| **field as u16 == *id).unwrap();
            let (tag, bytes, expected) = if field.double() {
                let value: f64 = text.parse().unwrap();
                (b'd', value.to_ne_bytes(), Value::Double(value))
            } else {
                let value: i64 = text.parse().unwrap();
                (b'i', value.to_ne_bytes(), Value::Integer(value))
            };
            let reading = decode::reading(field, time_us, 0, u16::from(tag), &bytes);
            assert_eq!(reading.time_ns, time_us as u64 * 1000);
            assert_eq!(
                reading.value,
                Ok(expected),
                "{} source line {} field {id}",
                sample.phase,
                sample.source_line
            );
        }
    }
}

/// Generated only for the synthetic ABI shim, not compiled into the collector.
pub(super) fn shim_header() -> String {
    let mut header =
        String::from("/* A10 CLI values; ABI status/time wrappers are synthetic. */\n");
    header.push_str("static int a10_groups(Groups *groups) {\n");
    let groups = a10_fixture::groups();
    writeln!(header, "groups->count = {};", groups.len()).unwrap();
    for (index, (major, minor, fields)) in groups.into_iter().enumerate() {
        let ids = fields
            .iter()
            .map(u16::to_string)
            .collect::<Vec<_>>()
            .join(",");
        writeln!(
            header,
            "groups->groups[{index}] = (Group){{{major},{minor},{},{{{ids}}}}};",
            fields.len()
        )
        .unwrap();
    }
    header.push_str("return 0;\n}\nstatic int a10_value(unsigned short field, Value *value) {\nswitch (field) {\n");
    let sample = a10_fixture::samples()
        .into_iter()
        .find(|sample| sample.phase == "tensor")
        .unwrap();
    assert_eq!(sample.source_line, 20);
    for (id, text) in sample.fields {
        let field = *FIELDS.iter().find(|field| **field as u16 == id).unwrap();
        let (tag, member) = if field.double() {
            ('d', 'd')
        } else {
            ('i', 'i')
        };
        writeln!(
            header,
            "case {id}: value->tag = '{tag}'; value->value.{member} = {text}; return 1;"
        )
        .unwrap();
    }
    header.push_str("default: return 0;\n}\n}\n");
    header
}
