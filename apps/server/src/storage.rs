use std::{
    fs::{self, File, OpenOptions},
    io,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};

use opentelemetry_proto::tonic::{
    collector::metrics::v1::ExportMetricsServiceRequest,
    common::v1::{KeyValue, any_value::Value},
    metrics::v1::number_data_point,
};
use parquet::{
    basic::Compression,
    data_type::{BoolType, ByteArray, ByteArrayType, DataType, DoubleType, Int32Type, Int64Type},
    file::{
        metadata::KeyValue as FileKeyValue,
        properties::WriterProperties,
        reader::{FileReader, SerializedFileReader},
        writer::{SerializedFileWriter, SerializedRowGroupWriter},
    },
    schema::parser::parse_message_type,
};
use prost::Message;
use serde_json::{Map, Value as Json};
use uuid::Uuid;

use crate::{Result, envelope::Envelope, metrics};

const MEASUREMENT_SCHEMA: &str = include_str!("../schema/measurements-v1.parquet.schema");

/// Publishes complete measurement files under a single directory writer lock.
pub struct Store {
    directory: PathBuf,
    _lock: File,
    publication: Mutex<()>,
}

impl Store {
    pub fn open(directory: &Path) -> Result<Self> {
        let mut missing = Vec::new();
        let mut ancestor = directory;
        while !ancestor.as_os_str().is_empty() && !ancestor.exists() {
            missing.push(ancestor.to_owned());
            ancestor = ancestor.parent().ok_or("Invalid storage directory")?;
        }
        let mut directories = fs::DirBuilder::new();
        directories.recursive(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            directories.mode(0o700);
        }
        directories.create(directory)?;
        for created in missing {
            File::open(&created)?.sync_all()?;
            if let Some(parent) = created.parent().filter(|v| !v.as_os_str().is_empty()) {
                File::open(parent)?.sync_all()?;
            } else {
                File::open(".")?.sync_all()?;
            }
        }
        let lock = OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(directory.join("writer.lock"))?;
        lock.try_lock()
            .map_err(|_| io::Error::other("Another storage worker owns this directory"))?;
        for entry in fs::read_dir(directory)? {
            let entry = entry?;
            if entry
                .file_name()
                .to_str()
                .is_some_and(|name| name.starts_with(".pending-") && name.ends_with(".tmp"))
                && entry.file_type()?.is_file()
            {
                fs::remove_file(entry.path())?;
            }
        }
        File::open(directory)?.sync_all()?;
        Ok(Self {
            directory: directory.into(),
            _lock: lock,
            publication: Mutex::new(()),
        })
    }

    pub fn publish(&self, envelope: &Envelope) -> Result<bool> {
        let _guard = self
            .publication
            .lock()
            .map_err(|_| io::Error::other("Storage worker panicked"))?;
        if envelope.format_version != 1
            || envelope.payload_kind != "otlp.metrics"
            || !crate::auth::identifier(&envelope.project_id)
            || !crate::auth::identifier(&envelope.source_id)
            || !Uuid::parse_str(&envelope.record_id)
                .is_ok_and(|v| v.get_version_num() == 7 && v.to_string() == envelope.record_id)
        {
            return Err(
                "Unsupported or invalid ingestion envelope; progress was not committed".into(),
            );
        }
        let key = envelope.storage_key();
        let digest = envelope.content_digest();
        let final_path = self.directory.join(format!("{key}.parquet"));
        if final_path.exists() {
            let file = File::open(&final_path)?;
            let reader = SerializedFileReader::new(file.try_clone()?)?;
            let metadata = reader.metadata().file_metadata();
            let value = |name: &str| {
                metadata
                    .key_value_metadata()
                    .into_iter()
                    .flatten()
                    .find(|kv| kv.key == name)
                    .and_then(|kv| kv.value.as_deref())
            };
            if value("pfe.schema_version") != Some("1")
                || value("pfe.content_sha256") != Some(digest.as_str())
                || value("pfe.storage_key") != Some(key.as_str())
            {
                return Err(
                    "Conflicting or damaged stored batch; existing measurements were preserved"
                        .into(),
                );
            }
            // The previous attempt may have died between rename and directory sync.
            file.sync_all()?;
            File::open(&self.directory)?.sync_all()?;
            return Ok(false);
        }
        let request = ExportMetricsServiceRequest::decode(envelope.payload.as_slice())?;
        let temporary = self
            .directory
            .join(format!(".pending-{}.tmp", Uuid::now_v7()));
        let result = (|| {
            let mut file = OpenOptions::new()
                .create_new(true)
                .write(true)
                .open(&temporary)?;
            write(&mut file, envelope, &request, &key, &digest)?;
            file.sync_all()?;
            fs::rename(&temporary, &final_path)?;
            File::open(&self.directory)?.sync_all()?;
            Ok(true)
        })();
        if temporary.exists() {
            let _ = fs::remove_file(temporary);
        }
        result
    }
}

#[derive(Clone)]
enum Cell {
    Text(String),
    Bytes(Vec<u8>),
    Int(i64),
    Double(f64),
    Bool(bool),
    Null,
}

fn text(value: impl Into<String>) -> Cell {
    Cell::Text(value.into())
}
fn optional(value: Option<&str>) -> Cell {
    value.map_or(Cell::Null, text)
}

fn rows(
    envelope: &Envelope,
    request: &ExportMetricsServiceRequest,
    mut consume: impl FnMut(Vec<Cell>) -> Result<()>,
) -> Result<usize> {
    let mut count = 0;
    for (ri, resource) in request.resource_metrics.iter().enumerate() {
        let attrs = resource
            .resource
            .as_ref()
            .map_or(&[][..], |v| v.attributes.as_slice());
        let resource_json = attributes_json(attrs)?;
        let resource_proto = resource
            .resource
            .as_ref()
            .map_or_else(Vec::new, Message::encode_to_vec);
        for (si, scope) in resource.scope_metrics.iter().enumerate() {
            let scope_name = scope.scope.as_ref().map_or("", |v| v.name.as_str());
            let scope_version = scope.scope.as_ref().map_or("", |v| v.version.as_str());
            let scope_json = attributes_json(
                scope
                    .scope
                    .as_ref()
                    .map_or(&[][..], |v| v.attributes.as_slice()),
            )?;
            let scope_proto = scope
                .scope
                .as_ref()
                .map_or_else(Vec::new, Message::encode_to_vec);
            for (mi, metric) in scope.metrics.iter().enumerate() {
                let (kind, temporality, monotonic) = metrics::kind(metric);
                let metadata_json = attributes_json(&metric.metadata)?;
                for (pi, point) in metrics::points(metric).into_iter().enumerate() {
                    let value = if point.flags() & 1 == 0 {
                        point.value()
                    } else {
                        None
                    };
                    let (integer, double) = match value {
                        Some(number_data_point::Value::AsInt(v)) => (Cell::Int(v), Cell::Null),
                        Some(number_data_point::Value::AsDouble(v)) => {
                            (Cell::Null, Cell::Double(v))
                        }
                        None => (Cell::Null, Cell::Null),
                    };
                    let pid = attrs
                        .iter()
                        .find(|v| v.key == "process.pid")
                        .and_then(|v| v.value.as_ref())
                        .and_then(|v| match v.value {
                            Some(Value::IntValue(v)) => Some(Cell::Int(v)),
                            _ => None,
                        })
                        .unwrap_or(Cell::Null);
                    consume(vec![
                        Cell::Int(1),
                        text(&envelope.project_id),
                        text(&envelope.source_id),
                        text(&envelope.record_id),
                        optional(
                            (!envelope.client_batch_id.is_empty())
                                .then_some(envelope.client_batch_id.as_str()),
                        ),
                        Cell::Int(envelope.received_unix_nano as i64),
                        Cell::Int(envelope.client_created_unix_nano as i64),
                        text(&envelope.profile),
                        Cell::Int(ri as i64),
                        Cell::Int(si as i64),
                        Cell::Int(mi as i64),
                        Cell::Int(pi as i64),
                        optional(metrics::string(attrs, "host.id")),
                        optional(metrics::string(attrs, "pfe.host.boot_id")),
                        optional(metrics::string(attrs, "pfe.collection.scope")),
                        optional(metrics::string(attrs, "pfe.collection.source")),
                        optional(metrics::string(attrs, "pfe.collection.epoch_id")),
                        pid,
                        optional(metrics::string(attrs, "pfe.process.namespace_id")),
                        optional(metrics::string(attrs, "pfe.process.incarnation_id")),
                        text(scope_name),
                        text(scope_version),
                        text(&metric.name),
                        text(&metric.description),
                        text(&metric.unit),
                        text(kind),
                        Cell::Int(temporality as i64),
                        Cell::Bool(monotonic),
                        Cell::Int(point.time() as i64),
                        Cell::Int(point.start() as i64),
                        Cell::Int(point.flags() as i64),
                        integer,
                        double,
                        text(&resource_json),
                        text(&scope_json),
                        text(&metadata_json),
                        text(attributes_json(point.attributes())?),
                        text(&resource.schema_url),
                        text(&scope.schema_url),
                        Cell::Bytes(resource_proto.clone()),
                        Cell::Bytes(scope_proto.clone()),
                        Cell::Bytes(point.encode()),
                    ])?;
                    count += 1;
                }
            }
        }
    }
    Ok(count)
}

pub fn attributes_json(values: &[KeyValue]) -> Result<String> {
    fn json_value(value: &Value) -> Result<Json> {
        Ok(match value {
            Value::StringValue(v) => Json::String(v.clone()),
            Value::IntValue(v) => Json::from(*v),
            Value::DoubleValue(v) => {
                Json::Number(serde_json::Number::from_f64(*v).ok_or("Non-finite attribute")?)
            }
            Value::BoolValue(v) => Json::Bool(*v),
            Value::BytesValue(v) => {
                serde_json::json!({"$bytes_hex": v.iter().map(|b| format!("{b:02x}")).collect::<String>()})
            }
            Value::ArrayValue(v) => Json::Array(
                v.values
                    .iter()
                    .map(|v| {
                        v.value
                            .as_ref()
                            .ok_or("Missing attribute value")
                            .map_err(Into::into)
                            .and_then(json_value)
                    })
                    .collect::<Result<_>>()?,
            ),
            Value::KvlistValue(v) => serde_json::from_str(&attributes_json(&v.values)?)?,
            Value::StringValueStrindex(_) => {
                return Err("Profile dictionary values are not valid metric attributes".into());
            }
        })
    }
    let mut object = Map::new();
    for attribute in values {
        let item = attribute
            .value
            .as_ref()
            .and_then(|v| v.value.as_ref())
            .ok_or("Missing attribute value")?;
        if object
            .insert(attribute.key.clone(), json_value(item)?)
            .is_some()
        {
            return Err("Duplicate attribute key".into());
        }
    }
    Ok(Json::Object(object).to_string())
}

fn column<T: DataType>(
    group: &mut SerializedRowGroupWriter<'_, &mut File>,
    values: Vec<T::T>,
    levels: Option<&[i16]>,
) -> Result<()> {
    let mut column = group
        .next_column()?
        .ok_or("Parquet schema has too few columns")?;
    column.typed::<T>().write_batch(&values, levels, None)?;
    column.close()?;
    Ok(())
}

fn write(
    file: &mut File,
    envelope: &Envelope,
    request: &ExportMetricsServiceRequest,
    key: &str,
    digest: &str,
) -> Result<()> {
    let schema = Arc::new(parse_message_type(MEASUREMENT_SCHEMA)?);
    let props = WriterProperties::builder()
        .set_compression(Compression::SNAPPY)
        .set_key_value_metadata(Some(
            [
                ("pfe.schema_version", "1"),
                ("pfe.storage_key", key),
                ("pfe.content_sha256", digest),
                ("pfe.record_id", envelope.record_id.as_str()),
            ]
            .into_iter()
            .map(|(key, value)| FileKeyValue::new(key.to_owned(), Some(value.to_owned())))
            .collect(),
        ))
        .build();
    let fields = schema.get_fields().to_vec();
    let mut writer = SerializedFileWriter::new(file, schema, Arc::new(props))?;
    let mut group_rows = Vec::new();
    let mut bytes = 0usize;
    let count = rows(envelope, request, |row| {
        bytes += row
            .iter()
            .map(|cell| match cell {
                Cell::Text(v) => v.len(),
                Cell::Bytes(v) => v.len(),
                _ => 8,
            })
            .sum::<usize>();
        group_rows.push(row);
        if group_rows.len() >= 1024 || bytes >= 8 * 1024 * 1024 {
            write_group(&mut writer, &fields, &group_rows)?;
            group_rows.clear();
            bytes = 0;
        }
        Ok(())
    })?;
    if count == 0 {
        return Err("Empty retained batch; progress was not committed".into());
    }
    if !group_rows.is_empty() {
        write_group(&mut writer, &fields, &group_rows)?;
    }
    writer.close()?;
    Ok(())
}

fn write_group(
    writer: &mut SerializedFileWriter<&mut File>,
    fields: &[Arc<parquet::schema::types::Type>],
    rows: &[Vec<Cell>],
) -> Result<()> {
    let mut group = writer.next_row_group()?;
    for (index, field) in fields.iter().enumerate() {
        let cells = rows.iter().map(|r| &r[index]).collect::<Vec<_>>();
        let optional = field.get_basic_info().repetition() == parquet::basic::Repetition::OPTIONAL;
        let levels = cells
            .iter()
            .map(|v| i16::from(!matches!(v, Cell::Null)))
            .collect::<Vec<_>>();
        let levels = optional.then_some(levels.as_slice());
        match field.get_physical_type() {
            parquet::basic::Type::BYTE_ARRAY => column::<ByteArrayType>(
                &mut group,
                cells
                    .iter()
                    .filter_map(|v| match v {
                        Cell::Text(v) => Some(ByteArray::from(v.as_str())),
                        Cell::Bytes(v) => Some(ByteArray::from(v.clone())),
                        _ => None,
                    })
                    .collect(),
                levels,
            )?,
            parquet::basic::Type::INT64 => column::<Int64Type>(
                &mut group,
                cells
                    .iter()
                    .filter_map(|v| match v {
                        Cell::Int(v) => Some(*v),
                        _ => None,
                    })
                    .collect(),
                levels,
            )?,
            parquet::basic::Type::INT32 => column::<Int32Type>(
                &mut group,
                cells
                    .iter()
                    .filter_map(|v| match v {
                        Cell::Int(v) => Some(*v as i32),
                        _ => None,
                    })
                    .collect(),
                levels,
            )?,
            parquet::basic::Type::DOUBLE => column::<DoubleType>(
                &mut group,
                cells
                    .iter()
                    .filter_map(|v| match v {
                        Cell::Double(v) => Some(*v),
                        _ => None,
                    })
                    .collect(),
                levels,
            )?,
            parquet::basic::Type::BOOLEAN => column::<BoolType>(
                &mut group,
                cells
                    .iter()
                    .filter_map(|v| match v {
                        Cell::Bool(v) => Some(*v),
                        _ => None,
                    })
                    .collect(),
                levels,
            )?,
            _ => return Err("Unsupported storage column".into()),
        }
    }
    if group.next_column()?.is_some() {
        return Err("Parquet schema has extra columns".into());
    }
    group.close()?;
    Ok(())
}
