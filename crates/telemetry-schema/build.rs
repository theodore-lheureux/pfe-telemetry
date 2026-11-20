use prost::Message;
use prost_types::{
    DescriptorProto, EnumDescriptorProto, FieldDescriptorProto, FileDescriptorSet,
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

const STATISTICS: [&str; 9] = [
    "count",
    "sum",
    "min",
    "max",
    "scale",
    "zero_count",
    "zero_threshold",
    "positive_offset",
    "negative_offset",
];
const VALUE_KIND: &str = "Enum8('ABSENT' = 0, 'INTEGER' = 1, 'DOUBLE' = 2)";
const MONOTONIC: &str = "Enum8('FALSE' = 0, 'TRUE' = 1, 'UNKNOWN' = 2)";

// Widening a Protobuf field must not silently change any analytical table.
fn check_analytical_field(owner: &str, field: &FieldDescriptorProto) {
    let expected = match (owner.rsplit('.').next().unwrap(), field.name()) {
        (
            "AnalyticalPoint",
            "project_id"
            | "source_id"
            | "resource_id"
            | "host_id"
            | "device_id"
            | "metric_name"
            | "unit"
            | "scope_name"
            | "scope_version"
            | "resource_schema_url"
            | "scope_schema_url"
            | "description",
        )
        | ("AttributeNode", "path" | "string_value") => Type::String,
        (
            "AnalyticalPoint",
            "sample_id"
            | "stream_id"
            | "delivery_evidence"
            | "original_position"
            | "lineage"
            | "exemplars"
            | "resource_entity_refs",
        )
        | ("AttributeNode", "bytes_value") => Type::Bytes,
        ("AnalyticalPoint", "resource_kind" | "metric_kind" | "temporality")
        | ("AttributeNode", "kind") => Type::Enum,
        (
            "AnalyticalPoint",
            "resource_present" | "scope_present" | "monotonic" | "stream_evidence",
        )
        | ("AttributeNode", "bool_value") => Type::Bool,
        (
            "AnalyticalPoint",
            "event_day"
            | "raw_partition"
            | "flags"
            | "resource_dropped_attributes_count"
            | "scope_dropped_attributes_count",
        )
        | ("ContinuityNode", "ordinal") => Type::Uint32,
        (
            "AnalyticalPoint",
            "time_unix_nano"
            | "start_time_unix_nano"
            | "received_unix_nano"
            | "raw_offset"
            | "min_event_unix_nano"
            | "max_event_unix_nano"
            | "series_id"
            | "logical_series_id"
            | "first_seen_unix_nano"
            | "last_seen_unix_nano"
            | "count"
            | "zero_count"
            | "bucket_counts"
            | "positive_counts"
            | "negative_counts",
        ) => Type::Fixed64,
        ("AnalyticalPoint", "scale" | "positive_offset" | "negative_offset") => Type::Sint32,
        ("AnalyticalPoint" | "AttributeNode", "int_value") => Type::Sint64,
        (
            "AnalyticalPoint",
            "double_value" | "sum" | "min" | "max" | "zero_threshold" | "explicit_bounds"
            | "quantiles" | "quantile_values",
        )
        | ("AttributeNode", "double_value") => Type::Double,
        (
            "AnalyticalPoint",
            "resource_attributes"
            | "scope_attributes"
            | "point_attributes"
            | "metric_metadata"
            | "resource_continuity"
            | "point_continuity",
        )
        | ("ContinuityNode", "node") => Type::Message,
        _ => panic!("choose a SQL representation for {owner}.{}", field.name()),
    };
    assert_eq!(field.r#type(), expected, "{owner}.{}", field.name());
}

fn plain(ty: &str) -> String {
    ty.strip_prefix("Nullable(")
        .and_then(|t| t.strip_suffix(')'))
        .unwrap()
        .to_owned()
}

fn point_projection(name: &str) -> String {
    if matches!(name, "int_value" | "double_value") || STATISTICS.contains(&name) {
        format!("ifNull(src.{name}, 0) AS {name}")
    } else if name == "value_kind" {
        "toInt8(multiIf(isNotNull(src.int_value), 1, isNotNull(src.double_value), 2, 0)) AS value_kind".into()
    } else if name == "statistics_present" {
        format!(
            "toUInt16({}) AS statistics_present",
            STATISTICS
                .iter()
                .enumerate()
                .map(|(i, name)| { format!("if(isNotNull(src.{name}), {}, 0)", 1 << i) })
                .collect::<Vec<_>>()
                .join(" + ")
        )
    } else {
        name.into()
    }
}

fn series_projection(name: &str) -> String {
    match name {
        "host_id" => format!("ifNull(src.{name}, '') AS {name}"),
        "monotonic" => "toInt8(ifNull(src.monotonic, 2)) AS monotonic".into(),
        _ => name.into(),
    }
}

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
    enums: Option<&BTreeMap<String, EnumDescriptorProto>>,
) -> String {
    if enums.is_some() {
        check_analytical_field(owner, field);
    }
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
        Type::Enum if enums.is_some() => {
            let values = &enums.unwrap()[field.type_name()].value;
            format!(
                "Enum8({})",
                values
                    .iter()
                    .map(|entry| {
                        assert!(i8::try_from(entry.number()).is_ok());
                        format!("'{}' = {}", entry.name(), entry.number())
                    })
                    .collect::<Vec<_>>()
                    .join(", ")
            )
        }
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
                .map(|f| format!(
                    "{} {}",
                    f.name(),
                    sql_type(field.type_name(), f, messages, enums)
                ))
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
    let enums: BTreeMap<_, _> = descriptor
        .file
        .iter()
        .flat_map(|file| {
            file.enum_type
                .iter()
                .map(|e| (format!(".{}.{}", file.package(), e.name()), e.clone()))
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
            .map(|f| (f.name(), sql_type(message, f, &messages, None)))
            .collect::<Vec<_>>();
        write_projection(&out, file.trim_end_matches("-columns.sql"), &columns)?;
        if file == "analytical-columns.sql" {
            let typed: Vec<_> = messages[message]
                .field
                .iter()
                .map(|f| (f.name(), sql_type(message, f, &messages, Some(&enums))))
                .collect();
            let delivery: Vec<_> = typed
                .iter()
                .filter(|(name, _)| {
                    matches!(
                        *name,
                        "project_id"
                            | "source_id"
                            | "received_unix_nano"
                            | "raw_partition"
                            | "raw_offset"
                            | "min_event_unix_nano"
                            | "max_event_unix_nano"
                            | "delivery_evidence"
                    )
                })
                .cloned()
                .collect();
            write_projection(&out, "delivery", &delivery)?;
            let streams = typed
                .iter()
                .filter(|(name, _)| {
                    matches!(
                        *name,
                        "project_id" | "stream_id" | "resource_continuity" | "point_continuity"
                    )
                })
                .cloned()
                .collect::<Vec<_>>();
            write_projection(&out, "stream", &streams)?;
            let kafka: Vec<_> = typed
                .iter()
                .filter(|(name, _)| !matches!(*name, "sample_id" | "device_id" | "lineage"))
                .cloned()
                .collect();
            write_projection(&out, "kafka", &kafka)?;
            let mut points: Vec<_> = typed
                .iter()
                .filter(|(name, _)| {
                    !matches!(
                        *name,
                        "sample_id"
                            | "lineage"
                            | "device_id"
                            | "delivery_evidence"
                            | "received_unix_nano"
                            | "min_event_unix_nano"
                            | "max_event_unix_nano"
                            | "stream_evidence"
                            | "resource_continuity"
                            | "point_continuity"
                    )
                })
                .filter(|(name, _)| {
                    matches!(*name, "project_id" | "series_id" | "metric_name")
                        || !SERIES_FIELDS.contains(name)
                })
                .map(|(name, ty)| {
                    (
                        *name,
                        if matches!(*name, "int_value" | "double_value")
                            || STATISTICS.contains(name)
                        {
                            plain(ty)
                        } else {
                            ty.clone()
                        },
                    )
                })
                .collect();
            points.extend([
                ("value_kind", VALUE_KIND.into()),
                ("statistics_present", "UInt16".into()),
            ]);
            let mut changes = Vec::new();
            for (name, ty) in &mut points {
                if matches!(*name, "time_unix_nano" | "raw_offset") {
                    ty.push_str(" CODEC(DoubleDelta, LZ4)");
                    changes.push(format!("    MODIFY COLUMN {name} {ty}"));
                }
            }
            fs::write(
                out.join("point-timestamp-codecs.sql"),
                format!(
                    "ALTER TABLE telemetry.metric_points\n{};\n",
                    changes.join(",\n")
                ),
            )?;
            let series: Vec<_> = typed
                .into_iter()
                .filter(|(name, _)| SERIES_FIELDS.contains(name))
                .map(|(name, ty)| {
                    (
                        name,
                        match name {
                            "first_seen_unix_nano" => "SimpleAggregateFunction(min, UInt64)".into(),
                            "last_seen_unix_nano" => "SimpleAggregateFunction(max, UInt64)".into(),
                            "monotonic" => MONOTONIC.into(),
                            "host_id" => plain(&ty),
                            _ => ty,
                        },
                    )
                })
                .collect();
            write_projection(&out, "point", &points)?;
            write_projection(&out, "series", &series)?;
            // Qualify the source to prevent aliases replacing the nullable inputs
            // inside the expressions which compute presence.
            for (name, fields, projection) in [
                ("point", &points, point_projection as fn(&str) -> String),
                ("series", &series, series_projection as fn(&str) -> String),
            ] {
                let select = fields
                    .iter()
                    .map(|(key, _)| projection(key))
                    .collect::<Vec<_>>()
                    .join(", ");
                fs::write(out.join(format!("{name}-select.sql")), select)?;
            }
        }
    }
    fs::write(
        out.join("attach-series.rs"),
        format!(
            "{{ {} }}",
            SERIES_FIELDS
                .iter()
                .filter(|name| !matches!(**name, "project_id" | "series_id" | "metric_name"))
                .map(|name| {
                    let field = messages[".recount.telemetry.AnalyticalPoint"]
                        .field
                        .iter()
                        .find(|field| field.name() == *name)
                        .unwrap();
                    let clone = if field.label() == Label::Repeated
                        || matches!(field.r#type(), Type::String | Type::Bytes | Type::Message)
                    {
                        ".clone()"
                    } else {
                        ""
                    };
                    format!("frame.{name} = series.{name}{clone};")
                })
                .collect::<Vec<_>>()
                .join("\n")
        ),
    )?;
    Ok(())
}
