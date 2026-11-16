use super::Session;
use crate::Error;
use std::{collections::BTreeMap, time::Instant};

impl Session {
    pub(super) fn discover(&mut self, interval: i64) -> Result<(), Error> {
        let physical = self.api.devices(self.handle)?;
        let mut parents = BTreeMap::new();
        let mut candidates = vec![];
        let mut identity_error = None;
        for entity in &physical {
            let uuid = match self.uuid(*entity) {
                Ok(uuid) => uuid,
                Err(error) => {
                    identity_error = Some(error);
                    continue;
                }
            };
            parents.insert(uuid.clone(), entity.id);
            candidates.push((*entity, uuid, None, entity.id));
        }
        if candidates.is_empty() && !physical.is_empty() {
            return Err(identity_error.unwrap_or(Error::Unavailable));
        }
        let instances = if physical.is_empty() {
            Ok(vec![])
        } else {
            self.api.instances(self.handle)
        };
        if let Ok(instances) = &instances {
            for (entity, parent) in instances {
                let Some(gpu_id) = parents.get(parent) else {
                    identity_error = Some(Error::Unavailable);
                    continue;
                };
                let uuid = match self.uuid(*entity) {
                    Ok(uuid) => uuid,
                    Err(error) => {
                        identity_error = Some(error);
                        continue;
                    }
                };
                candidates.push((*entity, uuid, Some(parent.clone()), *gpu_id));
            }
        }
        if let Err(error) = instances
            && error != Error::Unsupported
        {
            identity_error = Some(error);
        }
        let mut previous = std::mem::take(&mut self.devices);
        for (entity, uuid, parent, gpu) in candidates {
            if let Some(index) = previous
                .iter()
                .position(|old| old.entity == entity && old.uuid == uuid && old.parent == parent)
            {
                let old = previous.swap_remove(index);
                if old
                    .failures
                    .values()
                    .all(|error| *error == Error::Unsupported)
                {
                    self.devices.push(old);
                    continue;
                }
                for watch in old.watches.into_iter().rev() {
                    self.api.remove_watch(self.handle, &watch);
                }
            }
            let capabilities = self.api.capabilities(self.handle, gpu);
            self.observe(entity, uuid, parent, capabilities, interval);
        }
        for old in previous {
            for watch in old.watches.into_iter().rev() {
                self.api.remove_watch(self.handle, &watch);
            }
        }
        self.inventory_at = Instant::now();
        self.inventory_error = identity_error;
        Ok(())
    }
}
