use super::*;

#[tokio::test]
async fn shutdown_releases_ownership_even_with_a_fork_style_duplicate_descriptor() {
    let path = std::env::temp_dir().join(format!("recount-ownership-{}", Uuid::new_v4()));
    let spool = Spool::open(&path, "destination", 1024 * 1024, 4)
        .await
        .unwrap();
    let duplicate = spool.lock.as_ref().unwrap().try_clone().unwrap();
    spool.close().await.unwrap();
    let reopened = Spool::open(&path, "destination", 1024 * 1024, 4)
        .await
        .unwrap();
    reopened.close().await.unwrap();
    drop(duplicate);
    fs::remove_dir_all(path).unwrap();
}
