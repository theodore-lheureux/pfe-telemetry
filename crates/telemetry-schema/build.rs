use prost::Message;
use prost_types::{
    DescriptorProto, FieldDescriptorProto, FileDescriptorSet,
    field_descriptor_proto::{Label, Type},
};
use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
};

const SERIES_FIELDS: &[&str] = &[
    "project_id",
    "source_id",
    "resource_id",
    "resource_kind",
    "host_id",
    "device_id",
    "metric_name",
    "unit",
    "metric_kind",
    "resource_present",
    "scope_present",
    "scope_name",
    "scope_version",
    "resource_schema_url",
    "scope_schema_url",
    "resource_attributes",
    "scope_attributes",
    "point_attributes",
    "metric_metadata",
    "temporality",
    "monotonic",
    "description",
    "resource_dropped_attributes_count",
    "scope_dropped_attributes_count",
    "resource_entity_refs",
    "series_id",
    "logical_series_id",
    "first_seen_unix_nano",
    "last_seen_unix_nano",
];

fn write_projection(out: &Path, name: &str, fields: &[(&str, String)]) -> std::io::Result<()> {
    let mut columns = Vec::new();
    for (key, ty) in fields {
        columns.push(format!("    {key} {ty}"));
    }
    fs::write(out.join(format!("{name}-columns.sql")), columns.join(",\n"))?;
    fs::write(
        out.join(format!("{name}-names.sql")),
        fields
            .iter()
            .map(|(key, _)| *key)
            .collect::<Vec<_>>()
            .join(", "),
    )
}

fn sql_type(
    owner: &str,
    field: &FieldDescriptorProto,
    messages: &BTreeMap<String, DescriptorProto>,
) -> String {
    if owner == ".recount.telemetry.AnalyticalPoint"
        && matches!(field.name(), "sample_id" | "stream_id")
    {
        assert_eq!(
            field.r#type(),
            Type::Bytes,
            "analytical identity must be bytes"
        );
        assert_ne!(
            field.label(),
            Label::Repeated,
            "analytical identity must be singular"
        );
        assert!(
            !field.proto3_optional.unwrap_or(false),
            "analytical identity is required"
        );
        return "FixedString(32)".into();
    }
    let base = match field.r#type() {
        Type::String => "String".into(),
        Type::Bytes => "String".into(),
        Type::Bool | Type::Enum => "UInt8".into(),
        Type::Uint32 | Type::Fixed32 => "UInt32".into(),
        Type::Uint64 | Type::Fixed64 => "UInt64".into(),
        Type::Int32 | Type::Sint32 | Type::Sfixed32 => "Int32".into(),
        Type::Int64 | Type::Sint64 | Type::Sfixed64 => "Int64".into(),
        Type::Double => "Float64".into(),
        Type::Message => format!(
            "Tuple({})",
            messages[field.type_name()]
                .field
                .iter()
                .map(|f| format!("{} {}", f.name(), sql_type(field.type_name(), f, messages)))
                .collect::<Vec<_>>()
                .join(", ")
        ),
        other => panic!("unsupported analytical SQL type {other:?}"),
    };
    if field.label() == Label::Repeated {
        format!("Array({base})")
    } else if field.proto3_optional.unwrap_or(false) {
        format!("Nullable({base})")
    } else {
        base
    }
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    println!("cargo::rerun-if-changed=proto/recount.proto");
    println!("cargo::rerun-if-changed=proto/executions.proto");
    let out = PathBuf::from(std::env::var("OUT_DIR")?);
    let mut prost = prost_build::Config::new();
    prost
        .file_descriptor_set_path(out.join("recount.descriptor"))
        .protoc_executable(protoc_bin_vendored::protoc_bin_path()?);
    tonic_prost_build::configure().compile_with_config(
        prost,
        &["proto/recount.proto", "proto/executions.proto"],
        &["proto"],
    )?;
    let descriptor =
        FileDescriptorSet::decode(fs::read(out.join("recount.descriptor"))?.as_slice())?;
    let messages: BTreeMap<_, _> = descriptor
        .file
        .iter()
        .flat_map(|file| {
            file.message_type
                .iter()
                .map(|m| (format!(".{}.{}", file.package(), m.name()), m.clone()))
        })
        .collect();
    for (message, file) in [
        (
            ".recount.telemetry.AnalyticalPoint",
            "analytical-columns.sql",
        ),
        (
            ".recount.telemetry.AnalyticalParticipant",
            "participant-columns.sql",
        ),
    ] {
        let columns = messages[message]
            .field
            .iter()
            .map(|f| (f.name(), sql_type(message, f, &messages)))
            .collect::<Vec<_>>();
        write_projection(&out, file.trim_end_matches("-columns.sql"), &columns)?;
        if file == "analytical-columns.sql" {
            let points: Vec<_> = columns
                .iter()
                .filter(|(name, _)| {
                    matches!(*name, "project_id" | "series_id") || !SERIES_FIELDS.contains(name)
                })
                .cloned()
                .collect();
            let series: Vec<_> = columns
                .into_iter()
                .filter(|(name, _)| SERIES_FIELDS.contains(name))
                .map(|(name, ty)| {
                    (
                        name,
                        match name {
                            "first_seen_unix_nano" => "SimpleAggregateFunction(min, UInt64)".into(),
                            "last_seen_unix_nano" => "SimpleAggregateFunction(max, UInt64)".into(),
                            _ => ty,
                        },
                    )
                })
                .collect();
            write_projection(&out, "point", &points)?;
            write_projection(&out, "series", &series)?;
        }
    }
    Ok(())
}
