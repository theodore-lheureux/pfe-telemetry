use prost::Message;
use prost_types::{
    DescriptorProto, FieldDescriptorProto, FileDescriptorSet,
    field_descriptor_proto::{Label, Type},
};
use std::{collections::BTreeMap, fs, path::PathBuf};

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
    let out = PathBuf::from(std::env::var("OUT_DIR")?);
    prost_build::Config::new()
        .file_descriptor_set_path(out.join("recount.descriptor"))
        .protoc_executable(protoc_bin_vendored::protoc_bin_path()?)
        .compile_protos(&["proto/recount.proto"], &["proto"])?;
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
    let columns = messages[".recount.telemetry.AnalyticalPoint"]
        .field
        .iter()
        .map(|f| {
            format!(
                "    {} {}",
                f.name(),
                sql_type(".recount.telemetry.AnalyticalPoint", f, &messages)
            )
        })
        .collect::<Vec<_>>()
        .join(",\n");
    fs::write(out.join("analytical-columns.sql"), columns)?;
    Ok(())
}
