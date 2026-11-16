use crate::{Error, Field, Session, Value};
use std::{
    fs,
    process::Command,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

#[test]
fn runtime_child() {
    let Ok(mode) = std::env::var("RECOUNT_DCGM_FIXTURE_MODE") else {
        return;
    };
    let opened = Session::open(Duration::from_millis(100));
    if mode == "bad-pair" {
        assert!(matches!(opened, Err(Error::Invalid)));
        return;
    }
    let mut session = opened.unwrap();
    assert!(matches!(
        Session::open(Duration::from_secs(1)),
        Err(Error::Unavailable)
    ));
    let snapshot = session.sample().unwrap();
    if mode == "zero-devices" {
        assert!(snapshot.devices.is_empty());
        assert_eq!(snapshot.discovery, Ok(()));
        return;
    }
    assert_eq!(
        snapshot.discovery,
        if mode == "partial" {
            Err(Error::PermissionDenied)
        } else {
            Ok(())
        }
    );
    let devices = snapshot.devices;
    assert_eq!(devices.len(), 1);
    assert_eq!(devices[0].uuid, "GPU-01234567-89ab-cdef-0123-456789abcdef");
    assert!(devices[0].multiplexed);
    if mode == "a10" {
        let tensor = devices[0]
            .readings
            .iter()
            .find(|reading| reading.field == Field::Tensor)
            .unwrap();
        assert_eq!(tensor.value, Ok(Value::Double(0.927)));
        let fp64 = devices[0]
            .readings
            .iter()
            .find(|reading| reading.field == Field::Fp64)
            .unwrap();
        assert_eq!(fp64.value, Err(Error::Unsupported));
        assert_eq!(fp64.time_ns, 0);
        let fp32 = devices[0]
            .readings
            .iter()
            .find(|reading| reading.field == Field::Fp32)
            .unwrap();
        assert_eq!(fp32.value, Ok(Value::Double(0.0)));
        let nvlink = devices[0]
            .readings
            .iter()
            .find(|reading| reading.field == Field::NvlinkTx)
            .unwrap();
        assert_eq!(nvlink.value, Err(Error::Unavailable));
        return;
    }
    assert_eq!(
        devices[0]
            .readings
            .iter()
            .find(|r| r.field == Field::Tensor)
            .unwrap()
            .value,
        Ok(Value::Double(0.928))
    );
    assert_eq!(
        devices[0]
            .readings
            .iter()
            .find(|r| r.field == Field::Fp64)
            .unwrap()
            .value,
        Err(Error::Unsupported)
    );
    assert_eq!(
        devices[0]
            .readings
            .iter()
            .find(|r| r.field == Field::NvlinkTx)
            .unwrap()
            .value,
        Err(Error::Unsupported)
    );
    if mode == "bad-shutdown" {
        drop(session);
        assert!(matches!(
            Session::open(Duration::from_secs(1)),
            Err(Error::Unavailable)
        ));
    }
}

#[test]
fn runtime_loading_watches_reordered_records_and_owned_cleanup_use_the_real_ffi_path() {
    let dir = std::env::temp_dir().join(format!(
        "recount-dcgm-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    fs::create_dir(&dir).unwrap();
    let source = dir.join("runtime.c");
    fs::write(&source, include_bytes!("../../fixtures/runtime.c")).unwrap();
    fs::write(dir.join("a10.h"), super::a10::shim_header()).unwrap();
    let compiled = Command::new("cc")
        .args(["-shared", "-fPIC", "-Wall", "-Werror"])
        .arg(&source)
        .arg("-o")
        .arg(dir.join("libdcgm.so.4"))
        .output()
        .unwrap();
    assert!(
        compiled.status.success(),
        "{}",
        String::from_utf8_lossy(&compiled.stderr)
    );
    for mode in [
        "normal",
        "bad-pair",
        "zero-handles",
        "bad-shutdown",
        "partial",
        "zero-devices",
        "a10",
    ] {
        let log = dir.join(format!("{mode}.log"));
        let root_listener = crate::listener::root_owned();
        let output = Command::new(std::env::current_exe().unwrap())
            .args(["tests::runtime::runtime_child", "--exact", "--nocapture"])
            .env("LD_LIBRARY_PATH", &dir)
            .env("RECOUNT_DCGM_FIXTURE_MODE", mode)
            .env("RECOUNT_DCGM_FIXTURE_LOG", &log)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stdout)
        );
        let calls = fs::read_to_string(log).unwrap();
        assert_eq!(calls.contains("connect\n"), root_listener);
        if calls.contains("connect\n") {
            assert!(!calls.contains("start\n"));
            assert!(calls.ends_with("disconnect\nshutdown\n"));
        } else {
            assert!(calls.contains("start\n"));
            assert!(calls.ends_with("stop\nshutdown\n"));
        }
        if !matches!(mode, "bad-pair" | "zero-devices") {
            assert_eq!(calls.matches("watch\n").count(), 4); // two watches + two unwatches
            assert_eq!(calls.matches("destroy-group\n").count(), 1);
        }
    }
    fs::remove_dir_all(&dir).unwrap();
}
