use sha2::{Digest, Sha256};
use std::path::Path;

// This name is an OS-wide service and pipe namespace, so it is deliberately
// product-scoped. It must not collide with a concurrently installed Cindy.
const SERVICE_NAME_PREFIX: &str = "LexRemoteDesktop";

pub fn service_name_for_path(path: &Path) -> String {
    format!(
        "{SERVICE_NAME_PREFIX}-{:x}",
        Sha256::digest(path.to_string_lossy().to_lowercase().as_bytes())
    )[..35]
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::service_name_for_path;
    use std::path::Path;

    #[test]
    fn service_names_are_product_scoped() {
        let name = service_name_for_path(Path::new(r"C:\\Program Files\\Lex\\Lex.exe"));
        assert!(name.starts_with("LexRemoteDesktop-"));
        assert_eq!(name.len(), 35);
    }
}
