mod inventory;

use std::{
    collections::{BTreeMap, BTreeSet},
    sync::{Mutex, MutexGuard},
    time::{Duration, Instant},
};

use crate::{
    Device, Error, FIELDS, Field, Reading, Snapshot, decode,
    ffi::{Api, Watch, raw::Entity, text},
};

static OWNER: Mutex<()> = Mutex::new(());

struct Observed {
    entity: Entity,
    uuid: String,
    parent: Option<String>,
    watches: Vec<Watch>,
    failures: BTreeMap<Field, Error>,
    profiling: Result<(), Error>,
    multiplexed: bool,
}

/// One process-owned DCGM session. Keep it on one blocking acquisition worker.
/// A second concurrent owner fails closed rather than shutting down the first.
pub struct Session {
    api: Api,
    handle: usize,
    embedded: bool,
    devices: Vec<Observed>,
    interval_us: i64,
    inventory_at: Instant,
    inventory_error: Option<Error>,
    _owner: MutexGuard<'static, ()>,
}

impl Session {
    /// Load only `libdcgm.so.4`; connect locally or own an embedded AUTO engine.
    /// No library, no driver and no devices remain distinct outcomes.
    pub fn open(interval: Duration) -> Result<Self, Error> {
        let owner = OWNER.try_lock().map_err(|_| Error::Unavailable)?;
        let mut api = Api::load()?;
        let (handle, embedded) = api.open()?;
        let mut session = Self {
            api,
            handle,
            embedded,
            devices: vec![],
            interval_us: 1_000_000,
            inventory_at: Instant::now(),
            inventory_error: None,
            _owner: owner,
        };
        let interval = i64::try_from(interval.as_micros())
            .map_err(|_| Error::OutOfRange)?
            .max(1_000_000);
        session.interval_us = interval;
        session.discover(interval)?;
        Ok(session)
    }

    fn observe(
        &mut self,
        entity: Entity,
        uuid: String,
        parent: Option<String>,
        capabilities: Result<crate::ffi::Capabilities, Error>,
        interval: i64,
    ) {
        let mut failures = BTreeMap::new();
        let mut watches: Vec<Watch> = vec![];
        let mut groups = BTreeMap::<u16, BTreeSet<u16>>::new();
        let supported: BTreeSet<u16> = capabilities
            .as_ref()
            .map(|caps| {
                caps.iter()
                    .flat_map(|(_, _, fields)| fields.iter().copied())
                    .collect()
            })
            .unwrap_or_default();
        let profiling = capabilities.as_ref().map(|_| ()).map_err(|e| *e);
        for profiling_fields in [false, true] {
            let mut fields = vec![];
            for field in FIELDS
                .iter()
                .copied()
                .filter(|f| f.profiling() == profiling_fields)
            {
                let error = if parent.is_some() && !field.instance_scoped() {
                    Some(Error::Unsupported)
                } else if profiling_fields && !supported.contains(&(field as u16)) {
                    Some(profiling.err().unwrap_or(Error::Unsupported))
                } else {
                    None
                };
                if let Some(error) = error {
                    failures.insert(field, error);
                } else {
                    fields.push(field as u16);
                }
            }
            if fields.is_empty() {
                continue;
            }
            if let Err(error) = self
                .api
                .watch_entity(
                    self.handle,
                    entity,
                    &fields,
                    interval,
                    watches.first().map(|w| w.group),
                )
                .map(|watch| watches.push(watch))
            {
                for field in FIELDS.iter().filter(|f| fields.contains(&(**f as u16))) {
                    failures.insert(*field, error);
                }
            }
        }
        if let Ok(caps) = capabilities {
            for (major, minor, fields) in caps {
                if fields.iter().any(|id| {
                    FIELDS.iter().any(|f| *f as u16 == *id)
                        && !failures.keys().any(|f| *f as u16 == *id)
                }) {
                    groups.entry(major).or_default().insert(minor);
                }
            }
        }
        let multiplexed = groups.values().any(|minors| minors.len() > 1);
        self.devices.push(Observed {
            entity,
            uuid,
            parent,
            watches,
            failures,
            profiling,
            multiplexed,
        });
    }

    fn uuid(&self, entity: Entity) -> Result<String, Error> {
        let values = self.api.values(self.handle, entity, &[54], true)?;
        let value = values.first().ok_or(Error::Invalid)?;
        crate::status(value.status)?;
        if value.tag != u16::from(b's') {
            return Err(Error::Invalid);
        }
        text(&value.bytes[..256])
    }

    /// Read the current cache without forcing updates. First/paused/missing
    /// samples remain errors; callers deduplicate each native field timestamp.
    pub fn sample(&mut self) -> Result<Snapshot, Error> {
        if self.inventory_at.elapsed() >= Duration::from_secs(30) {
            self.discover(self.interval_us)?;
        }
        let mut devices = vec![];
        for device in &self.devices {
            let identity_error = match self.uuid(device.entity) {
                Ok(uuid) if uuid == device.uuid => None,
                Ok(_) => Some(Error::Disappeared),
                Err(error) => Some(error),
            };
            let fields: Vec<u16> = FIELDS
                .iter()
                .filter(|f| !device.failures.contains_key(f))
                .map(|f| *f as u16)
                .collect();
            let mut values = if let Some(error) = identity_error {
                Err(error)
            } else if fields.is_empty() {
                Ok(vec![])
            } else {
                self.api.values(self.handle, device.entity, &fields, false)
            };
            if values.is_ok() {
                match self.uuid(device.entity) {
                    Ok(uuid) if uuid == device.uuid => {}
                    Ok(_) => values = Err(Error::Disappeared),
                    Err(error) => values = Err(error),
                }
            }
            if matches!(&values, Err(Error::Disconnected)) {
                return Err(Error::Disconnected);
            }
            let mut readings = Vec::with_capacity(FIELDS.len());
            for field in FIELDS {
                let reading = match device.failures.get(field) {
                    Some(error) => Reading {
                        field: *field,
                        time_ns: 0,
                        value: Err(*error),
                    },
                    None => match &values {
                        Ok(values) => match values.iter().find(|v| v.field == *field as u16) {
                            Some(value) => decode::reading(
                                *field,
                                value.timestamp_us,
                                value.status,
                                value.tag,
                                &value.bytes,
                            ),
                            None => Reading {
                                field: *field,
                                time_ns: 0,
                                value: Err(Error::Unavailable),
                            },
                        },
                        Err(error) => Reading {
                            field: *field,
                            time_ns: 0,
                            value: Err(*error),
                        },
                    },
                };
                readings.push(reading);
            }
            devices.push(Device {
                uuid: device.uuid.clone(),
                parent_uuid: device.parent.clone(),
                readings,
                profiling: device.profiling,
                multiplexed: device.multiplexed,
            });
        }
        Ok(Snapshot {
            devices,
            discovery: self.inventory_error.map_or(Ok(()), Err),
        })
    }
}

impl Drop for Session {
    fn drop(&mut self) {
        for device in &self.devices {
            for watch in device.watches.iter().rev() {
                self.api.remove_watch(self.handle, watch);
            }
        }
        self.api.close(self.handle, self.embedded);
    }
}
