#[cfg(target_os = "linux")]
fn main() -> Result<(), Box<dyn std::error::Error>> {
    use std::{thread, time::Duration};
    let mut session = recount_nvidia_dcgm::Session::open(Duration::from_secs(1))?;
    for _ in 0..5 {
        thread::sleep(Duration::from_secs(1));
        let snapshot = session.sample()?;
        println!("discovery={:?}", snapshot.discovery);
        for device in snapshot.devices {
            println!(
                "device={} parent={:?} multiplexing_possible={}",
                device.uuid, device.parent_uuid, device.multiplexed
            );
            for reading in device.readings {
                println!(
                    "field={} time_ns={} value={:?}",
                    reading.field as u16, reading.time_ns, reading.value
                );
            }
        }
    }
    Ok(())
}

#[cfg(not(target_os = "linux"))]
fn main() {
    eprintln!("DCGM acquisition requires Linux");
    std::process::exit(1);
}
