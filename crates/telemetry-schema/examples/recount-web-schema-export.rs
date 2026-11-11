use std::{env, fs, path::PathBuf};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let output = PathBuf::from(env::args_os().nth(1).ok_or("output directory required")?);
    fs::create_dir_all(&output)?;
    fs::write(
        output.join("recount.pb"),
        include_bytes!(concat!(env!("OUT_DIR"), "/recount.descriptor")),
    )?;
    fs::write(output.join("otlp.pb"), opentelemetry_proto::DESCRIPTORS)?;
    Ok(())
}
