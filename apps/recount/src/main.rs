#[cfg(unix)]
mod launch;

#[cfg(unix)]
fn main() {
    launch::main();
}

#[cfg(not(unix))]
fn main() {
    eprintln!("recount run requires Unix exec");
    std::process::exit(1);
}
