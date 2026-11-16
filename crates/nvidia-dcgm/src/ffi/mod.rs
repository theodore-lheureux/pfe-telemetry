#[cfg(test)]
mod fake;
pub(crate) mod raw;
mod watch;
pub(crate) use watch::Watch;

use std::{
    collections::BTreeSet,
    ffi::{c_char, c_int},
    sync::atomic::{AtomicBool, Ordering},
};

use libloading::Library;
use raw::{Connect, Entity, MetricGroups, MigHierarchy, RawValue};

use crate::{Error, status};

pub(crate) type Capabilities = Vec<(u16, u16, Vec<u16>)>;
static SHUTDOWN_FAILED: AtomicBool = AtomicBool::new(false);

macro_rules! api {
    ($($member:ident: $name:literal ($($arg:ty),*) ),* $(,)?) => {
        pub(crate) struct Api {
            _library: Option<Library>,
            $(pub $member: unsafe extern "C" fn($($arg),*) -> c_int,)*
        }
        impl Api {
            pub fn load() -> Result<Self, Error> {
                if SHUTDOWN_FAILED.load(Ordering::Acquire) { return Err(Error::Unavailable); }
                // SAFETY: only the installed DCGM 4 ABI is supported. Privileged
                // deployments must control the system dynamic-loader paths.
                let library = unsafe { Library::new("libdcgm.so.4") }
                    .map_err(|_| Error::Absent)?;
                $(// SAFETY: signatures match the pinned public DCGM 4 header;
                  // the library owner outlives every copied function pointer.
                  let $member = unsafe {
                      *library.get::<unsafe extern "C" fn($($arg),*) -> c_int>(
                          concat!($name, "\0").as_bytes()
                      ).map_err(|_| Error::Unsupported)?
                  };
                )*
                Ok(Self { _library: Some(library), $($member,)* })
            }
        }
    };
}

api! {
    init: "dcgmInit" (),
    shutdown: "dcgmShutdown" (),
    start: "dcgmStartEmbedded" (c_int, *mut usize),
    stop: "dcgmStopEmbedded" (usize),
    connect: "dcgmConnect_v2" (*const c_char, *mut Connect, *mut usize),
    disconnect: "dcgmDisconnect" (usize),
    enumerate: "dcgmGetAllDevices" (usize, *mut u32, *mut c_int),
    hierarchy: "dcgmGetGpuInstanceHierarchy" (usize, *mut MigHierarchy),
    profiles: "dcgmProfGetSupportedMetricGroups" (usize, *mut MetricGroups),
    group_create: "dcgmGroupCreate" (usize, c_int, *const c_char, *mut usize),
    group_add: "dcgmGroupAddEntity" (usize, usize, c_int, u32),
    group_destroy: "dcgmGroupDestroy" (usize, usize),
    fields_create: "dcgmFieldGroupCreate" (usize, c_int, *mut u16, *const c_char, *mut usize),
    fields_destroy: "dcgmFieldGroupDestroy" (usize, usize),
    watch: "dcgmWatchFields" (usize, usize, usize, i64, f64, c_int),
    unwatch: "dcgmUnwatchFields" (usize, usize, usize),
    latest: "dcgmEntitiesGetLatestValues" (usize, *mut Entity, u32, *mut u16, u32, u32, *mut RawValue),
}

impl Api {
    pub fn open(&mut self) -> Result<(usize, bool), Error> {
        // SAFETY: all output arguments are initialized and correctly sized.
        unsafe {
            status((self.init)())?;
            let mut handle = 0;
            let mut params = Connect {
                version: 0x0200_0010,
                persist: 0,
                timeout_ms: 500,
                unix_socket: 0,
            };
            if crate::listener::root_owned()
                && (self.connect)(c"127.0.0.1:5555".as_ptr(), &mut params, &mut handle) == 0
            {
                return Ok((handle, false));
            }
            match status((self.start)(1, &mut handle)) {
                Ok(()) => Ok((handle, true)),
                Err(error) => {
                    self.finish_shutdown();
                    Err(error)
                }
            }
        }
    }

    pub fn close(&mut self, handle: usize, embedded: bool) {
        // SAFETY: the unique session owns this initialized connection/engine.
        unsafe {
            if embedded {
                (self.stop)(handle);
            } else {
                (self.disconnect)(handle);
            }
            self.finish_shutdown();
        }
    }

    fn finish_shutdown(&mut self) {
        // SAFETY: initialization succeeded, and all owned handles were released
        // or failed cleanup. Failed shutdown cannot justify unloading live code.
        let result = unsafe { (self.shutdown)() };
        if result != 0 && result != -10 {
            SHUTDOWN_FAILED.store(true, Ordering::Release);
            if let Some(library) = self._library.take() {
                std::mem::forget(library);
            }
        }
    }

    pub fn devices(&self, handle: usize) -> Result<Vec<Entity>, Error> {
        let mut ids = [0; 32];
        let mut count = 0;
        // SAFETY: the public API promises at most DCGM_MAX_NUM_DEVICES outputs.
        status(unsafe { (self.enumerate)(handle, ids.as_mut_ptr(), &mut count) })?;
        let count = usize::try_from(count)
            .ok()
            .filter(|n| *n <= ids.len())
            .ok_or(Error::Invalid)?;
        Ok(ids[..count]
            .iter()
            .map(|id| Entity { group: 1, id: *id })
            .collect())
    }

    pub fn instances(&self, handle: usize) -> Result<Vec<(Entity, String)>, Error> {
        let entry = raw::MigEntry {
            entity: Entity::default(),
            parent: Entity::default(),
            uuid: [0; 128],
            nvml_index: 0,
            instance: 0,
            compute_instance: 0,
            profile: 0,
            slices: 0,
        };
        let mut hierarchy = Box::new(MigHierarchy {
            version: 0x0201_1f08,
            count: 0,
            entries: std::array::from_fn(|_| entry.clone()),
        });
        // SAFETY: exact initialized v2 hierarchy buffer, including all 448 entries.
        status(unsafe { (self.hierarchy)(handle, &mut *hierarchy) })?;
        if hierarchy.version != 0x0201_1f08 || hierarchy.count > 448 {
            return Err(Error::Invalid);
        }
        hierarchy.entries[..hierarchy.count as usize]
            .iter()
            .filter(|entry| entry.entity.group == 5)
            .map(|entry| Ok((entry.entity, text(&entry.uuid)?)))
            .collect()
    }

    pub fn capabilities(&self, handle: usize, gpu: u32) -> Result<Capabilities, Error> {
        let empty = raw::MetricGroup {
            major: 0,
            minor: 0,
            count: 0,
            fields: [0; 64],
        };
        let mut groups = MetricGroups {
            version: 0x0300_0560,
            unused: 0,
            gpu_id: gpu,
            count: 0,
            groups: [empty; 10],
        };
        // SAFETY: exact v3 input/output layout; versions 1/2 are not guessed.
        status(unsafe { (self.profiles)(handle, &mut groups) })?;
        if groups.version != 0x0300_0560 || groups.count > 10 {
            return Err(Error::Invalid);
        }
        groups.groups[..groups.count as usize]
            .iter()
            .map(|group| {
                if group.count > 64 {
                    return Err(Error::Invalid);
                }
                Ok((
                    group.major,
                    group.minor,
                    group.fields[..group.count as usize].to_vec(),
                ))
            })
            .collect()
    }

    pub fn values(
        &self,
        handle: usize,
        entity: Entity,
        fields: &[u16],
        live: bool,
    ) -> Result<Vec<RawValue>, Error> {
        if fields.is_empty() || fields.len() > 64 || (live && fields.iter().any(|id| *id >= 1000)) {
            return Err(Error::Invalid);
        }
        let mut ids = fields.to_vec();
        let mut entity_arg = entity;
        let mut values = vec![RawValue::default(); ids.len()];
        // SAFETY: one entity times field count exactly matches output capacity.
        // No callbacks or borrowed native pointers survive the synchronous call.
        status(unsafe {
            (self.latest)(
                handle,
                &mut entity_arg,
                1,
                ids.as_mut_ptr(),
                ids.len() as u32,
                u32::from(live),
                values.as_mut_ptr(),
            )
        })?;
        let mut seen = BTreeSet::new();
        for value in &values {
            if value.version != 0x0200_1020
                || value.group != entity.group
                || value.id != entity.id
                || !fields.contains(&value.field)
                || !seen.insert(value.field)
            {
                return Err(Error::Invalid);
            }
        }
        Ok(values)
    }
}

pub(crate) fn text(bytes: &[u8]) -> Result<String, Error> {
    let end = bytes.iter().position(|b| *b == 0).ok_or(Error::Invalid)?;
    let text = std::str::from_utf8(&bytes[..end]).map_err(|_| Error::Invalid)?;
    if text.is_empty() || text.contains("<<<") || text.chars().any(char::is_control) {
        return Err(Error::Invalid);
    }
    Ok(text.to_owned())
}
