// Test-only declarations derived from NVIDIA DCGM v4.7.0 test/internal headers.
// Copyright (c) 2025-2026 NVIDIA CORPORATION. Apache-2.0; see NOTICE.
use super::{Api, raw::Entity};
use crate::{Error, Field, Value, decode, status};
use std::{
    path::Path,
    process::Command,
    time::{SystemTime, UNIX_EPOCH},
};

#[repr(C)]
#[derive(Clone, Copy, Default)]
struct HierarchyEntry {
    entity: Entity,
    parent: Entity,
    profile: i32,
}
#[repr(C)]
struct FakeEntities {
    version: u32,
    count: u32,
    entries: [HierarchyEntry; 448],
}
#[repr(C, align(8))]
struct Injection {
    version: u32,
    field: u16,
    tag: u16,
    status: i32,
    padding: u32,
    time_us: i64,
    bytes: [u8; 4096],
}
const _: () = {
    assert!(size_of::<FakeEntities>() == 8968);
    assert!(size_of::<Injection>() == 4120);
    assert!(std::mem::offset_of!(Injection, bytes) == 24);
};

struct Embedded {
    api: Api,
    handle: usize,
}
impl Drop for Embedded {
    fn drop(&mut self) {
        self.api.close(self.handle, true);
    }
}

#[test]
fn child() {
    if std::env::var_os("RECOUNT_DCGM_REAL_FAKE_CHILD").is_none() {
        return;
    }
    assert!(
        !Path::new("/dev/nvidiactl").exists(),
        "Use a driver-free test environment"
    );
    assert!(!Path::new("/proc/driver/nvidia/version").exists());
    // SAFETY: an explicit opt-in test checks absence only; no symbols are called.
    assert!(
        unsafe { libloading::Library::new("libnvidia-ml.so.1") }.is_err(),
        "This test specifically verifies DCGM without NVML"
    );
    let api = Api::load().expect("Provide the real DCGM 4 runtime through the system loader");
    let mut handle = 0;
    // SAFETY: exact public signatures and initialized handle output. MANUAL mode
    // prevents background polling from replacing deliberately injected samples.
    unsafe {
        status((api.init)()).unwrap();
    }
    // SAFETY: initialized process-owned engine and correctly sized output.
    let started = unsafe { (api.start)(2, &mut handle) };
    let engine = Embedded { api, handle };
    status(started).unwrap();
    assert!(engine.api.devices(handle).unwrap().is_empty());
    type Create = unsafe extern "C" fn(usize, *mut FakeEntities) -> i32;
    type Inject = unsafe extern "C" fn(usize, u32, *mut Injection) -> i32;
    let library = engine.api._library.as_ref().unwrap();
    // SAFETY: the optional test API's exact pinned signatures; library owner is
    // kept alive until the embedded engine shuts down. These APIs never ship.
    let create = unsafe {
        *library
            .get::<Create>(c"dcgmCreateFakeEntities".to_bytes_with_nul())
            .unwrap()
    };
    let inject = unsafe {
        *library
            .get::<Inject>(c"dcgmInjectFieldValue".to_bytes_with_nul())
            .unwrap()
    };
    let mut fake = Box::new(FakeEntities {
        version: 0x0200_2308,
        count: 1,
        entries: [HierarchyEntry::default(); 448],
    });
    fake.entries[0].entity.group = 1;
    // SAFETY: full initialized v2 buffer with one requested GPU; output is bounded
    // by the fixed array, and no caller/server-selected endpoint is involved.
    status(unsafe { create(handle, &mut *fake) }).unwrap();
    assert_eq!(fake.count, 1);
    let entity = fake.entries[0].entity;
    assert_eq!(entity.group, 1);
    let time_us = i64::try_from(
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_micros(),
    )
    .unwrap();
    for (field, value) in [
        (Field::SmActivity, 0.25),
        (Field::SmOccupancy, 0.5),
        (Field::Tensor, 0.0),
        (Field::Fp32, 0.75),
        (Field::Fp64, decode::DOUBLE_BLANK + 2.0),
    ] {
        let mut input = Injection {
            version: 0x0100_1018,
            field: field as u16,
            tag: b'd' as u16,
            status: 0,
            padding: 0,
            time_us,
            bytes: [0; 4096],
        };
        input.bytes[..8].copy_from_slice(&value.to_ne_bytes());
        // SAFETY: exact initialized field-value v1 output stride and scalar tag.
        status(unsafe { inject(handle, entity.id, &mut input) }).unwrap();
        let returned = engine
            .api
            .values(handle, entity, &[field as u16], false)
            .unwrap();
        let raw = &returned[0];
        let reading = decode::reading(field, raw.timestamp_us, raw.status, raw.tag, &raw.bytes);
        assert_eq!(reading.time_ns, time_us as u64 * 1000);
        let expected = if field == Field::Fp64 {
            Err(Error::Unsupported)
        } else {
            Ok(Value::Double(value))
        };
        assert_eq!(reading.value, expected);
    }
    println!(
        "Real DCGM embedded fake GPU: injected SM/pipe ratios, valid zero and finite blank verified without driver/NVML"
    );
}

#[test]
#[ignore = "opt-in: real DCGM 4 runtime, no NVIDIA driver/NVML; creates only owned embedded fake entities"]
fn real_dcgm_fake_entities() {
    let output = Command::new(std::env::current_exe().unwrap())
        .args(["ffi::fake::child", "--exact", "--nocapture"])
        .env("RECOUNT_DCGM_REAL_FAKE_CHILD", "1")
        .env_remove("RECOUNT_DCGM_FIXTURE_MODE")
        .env_remove("RECOUNT_DCGM_FIXTURE_LOG")
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "stdout: {}\nstderr: {}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    print!("{}", String::from_utf8_lossy(&output.stdout));
}
