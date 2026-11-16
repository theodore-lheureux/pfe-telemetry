use super::{Api, raw::Entity};
use crate::{Error, status};
use std::{
    ffi::CString,
    sync::atomic::{AtomicU64, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};

static NEXT_NAME: AtomicU64 = AtomicU64::new(1);

pub(crate) struct Watch {
    pub group: usize,
    pub fields: Option<usize>,
    owns_group: bool,
}

impl Api {
    pub fn watch_entity(
        &self,
        handle: usize,
        entity: Entity,
        fields: &[u16],
        interval_us: i64,
        existing_group: Option<usize>,
    ) -> Result<Watch, Error> {
        if fields.is_empty() || fields.len() > 128 || interval_us < 1_000_000 {
            return Err(Error::Invalid);
        }
        let mut watch = Watch {
            group: existing_group.unwrap_or(0),
            fields: None,
            owns_group: existing_group.is_none(),
        };
        let mut field_ids = fields.to_vec();
        let name = CString::new(format!(
            "recount-{}-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map_err(|_| Error::Unavailable)?
                .as_nanos(),
            NEXT_NAME.fetch_add(1, Ordering::Relaxed)
        ))
        .map_err(|_| Error::Invalid)?;
        // SAFETY: fixed names, bounded initialized inputs and correct uintptr_t
        // outputs. Only this connection's groups are created or removed.
        unsafe {
            if watch.owns_group {
                status((self.group_create)(
                    handle,
                    1,
                    name.as_ptr(),
                    &mut watch.group,
                ))?;
            }
            let result = (|| {
                if watch.owns_group {
                    status((self.group_add)(
                        handle,
                        watch.group,
                        entity.group,
                        entity.id,
                    ))?;
                }
                let mut field_group = 0;
                status((self.fields_create)(
                    handle,
                    field_ids.len() as i32,
                    field_ids.as_mut_ptr(),
                    name.as_ptr(),
                    &mut field_group,
                ))?;
                watch.fields = Some(field_group);
                status((self.watch)(
                    handle,
                    watch.group,
                    field_group,
                    interval_us,
                    interval_us as f64 / 1_000_000.0 * 3.0,
                    3,
                ))
            })();
            if let Err(error) = result {
                self.remove_watch(handle, &watch);
                return Err(error);
            }
        }
        Ok(watch)
    }

    pub fn remove_watch(&self, handle: usize, watch: &Watch) {
        // SAFETY: handles belong to this session, cleanup precedes unload.
        unsafe {
            if let Some(fields) = watch.fields {
                (self.unwatch)(handle, watch.group, fields);
                (self.fields_destroy)(handle, fields);
            }
            if watch.owns_group {
                (self.group_destroy)(handle, watch.group);
            }
        }
    }
}
