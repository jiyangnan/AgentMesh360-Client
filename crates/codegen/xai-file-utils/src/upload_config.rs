//! Upload destination config and archive-restore metadata shared by the
//! always-on upload queue and session restore paths.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

/// Method for uploading to object storage.
#[derive(Clone)]
pub enum UploadMethod {
    Direct {
        service_account_key: Option<String>,
    },
    Proxy {
        proxy_base_url: String,
        user_token: String,
        deployment_key: Option<String>,
        alpha_test_key: Option<String>,
    },
    S3 {
        bucket: String,
        region: String,
        credentials_file: Option<String>,
        credentials_content: Option<String>,
        endpoint_url: Option<String>,
    },
}

impl std::fmt::Debug for UploadMethod {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Direct {
                service_account_key,
            } => f
                .debug_struct("Direct")
                .field("credential_present", &service_account_key.is_some())
                .finish(),
            Self::Proxy {
                proxy_base_url,
                user_token,
                deployment_key,
                alpha_test_key,
            } => f
                .debug_struct("Proxy")
                .field("proxy_configured", &!proxy_base_url.trim().is_empty())
                .field("user_credential_present", &!user_token.trim().is_empty())
                .field("deployment_credential_present", &deployment_key.is_some())
                .field("alpha_test_credential_present", &alpha_test_key.is_some())
                .finish(),
            Self::S3 {
                bucket,
                region,
                credentials_file,
                credentials_content,
                endpoint_url,
            } => f
                .debug_struct("S3")
                .field("bucket_configured", &!bucket.trim().is_empty())
                .field("region_configured", &!region.trim().is_empty())
                .field("credentials_file_configured", &credentials_file.is_some())
                .field("credential_present", &credentials_content.is_some())
                .field("endpoint_configured", &endpoint_url.is_some())
                .finish(),
        }
    }
}

/// Configuration for object-storage export.
#[derive(Clone)]
pub struct TraceExportConfig {
    pub bucket_url: Option<String>,
    pub service_account_key: Option<String>,
    pub upload_method: UploadMethod,
    pub prefix_dir: Option<String>,
    pub gcs_prefix: Option<String>,
    pub absolute_paths: bool,
    pub archive_name_override: Option<String>,
}

impl std::fmt::Debug for TraceExportConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("TraceExportConfig")
            .field("bucket_configured", &self.bucket_url.is_some())
            .field(
                "service_account_credential_present",
                &self.service_account_key.is_some(),
            )
            .field("upload_method", &self.upload_method)
            .field("prefix_dir_configured", &self.prefix_dir.is_some())
            .field("gcs_prefix_configured", &self.gcs_prefix.is_some())
            .field("absolute_paths", &self.absolute_paths)
            .field(
                "archive_name_override_configured",
                &self.archive_name_override.is_some(),
            )
            .finish()
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BlobCompression {
    #[default]
    None,
    Zstd,
}

pub const SKIP_DIR_NAMES: &[&str] = &[
    "node_modules",
    "__pycache__",
    ".venv",
    "venv",
    "env",
    ".env",
    "target",
    "dist",
    "build",
    "out",
    ".next",
    ".nuxt",
    ".output",
    ".cache",
    ".parcel-cache",
    ".turbo",
    "vendor",
    "bower_components",
    ".tox",
    ".nox",
    ".eggs",
    ".idea",
    ".vscode",
    ".gradle",
    ".dart_tool",
    "coverage",
    ".nyc_output",
    "htmlcov",
    ".pytest_cache",
    ".mypy_cache",
    ".ruff_cache",
];

pub fn skip_dir_set() -> &'static std::collections::HashSet<&'static str> {
    use std::collections::HashSet;
    use std::sync::LazyLock;
    static SET: LazyLock<HashSet<&str>> =
        LazyLock::new(|| SKIP_DIR_NAMES.iter().copied().collect());
    &SET
}

pub const SKIP_FILE_PATTERNS: &[&str] = &[
    "*.egg-info",
    "*.pyc",
    "*.pyo",
    "*.o",
    "*.so",
    "*.dylib",
    "*.class",
    "*.jar",
    ".DS_Store",
    "Thumbs.db",
    "*.swp",
    "*.swo",
    "*~",
    "*.iml",
];

pub fn default_untracked_exclude_globs() -> Vec<String> {
    let mut globs: Vec<String> = SKIP_DIR_NAMES.iter().map(|d| format!("{d}/")).collect();
    globs.extend(SKIP_FILE_PATTERNS.iter().map(|p| p.to_string()));
    globs
}

pub fn default_excludes_as_gitignore() -> String {
    default_untracked_exclude_globs().join("\n")
}

pub const ARCHIVE_SCHEMA_VERSION: &str = "v2";
pub const ARCHIVE_SCHEMA_VERSION_V3: &str = "v3";
pub const DEDUP_GCS_PREFIX: &str = "repo_changes_dedup";
pub const DEDUP_PATCH_SUBDIR: &str = "patches";
pub const DEDUP_BLOB_SUBDIR: &str = "blobs";

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PatchReference {
    #[serde(rename = "type")]
    pub ref_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    pub sha256: String,
    pub size_bytes: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileReference {
    #[serde(rename = "type")]
    pub ref_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    pub sha256: String,
    pub size_bytes: u64,
    pub truncated: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExcludedContent {
    pub path: String,
    pub reason: String,
    pub size_bytes: u64,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DedupMetadata {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub base_archive_url: Option<String>,
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    pub patch_references: HashMap<String, PatchReference>,
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    pub file_references: HashMap<String, FileReference>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub excluded: Vec<ExcludedContent>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn upload_config_debug_never_renders_credentials_or_secret_urls() {
        let sentinel = "AM360_UPLOAD_SENTINEL_4c8a1e09d75fb263";
        let methods = [
            UploadMethod::Direct {
                service_account_key: Some(sentinel.to_owned()),
            },
            UploadMethod::Proxy {
                proxy_base_url: format!("https://{sentinel}@proxy.example/?k={sentinel}"),
                user_token: sentinel.to_owned(),
                deployment_key: Some(sentinel.to_owned()),
                alpha_test_key: Some(sentinel.to_owned()),
            },
            UploadMethod::S3 {
                bucket: sentinel.to_owned(),
                region: sentinel.to_owned(),
                credentials_file: Some(format!("/tmp/{sentinel}")),
                credentials_content: Some(sentinel.to_owned()),
                endpoint_url: Some(format!("https://{sentinel}@s3.example/?k={sentinel}")),
            },
        ];
        let trace = TraceExportConfig {
            bucket_url: Some(format!("gs://{sentinel}")),
            service_account_key: Some(sentinel.to_owned()),
            upload_method: methods[1].clone(),
            prefix_dir: Some(sentinel.to_owned()),
            gcs_prefix: Some(sentinel.to_owned()),
            absolute_paths: false,
            archive_name_override: Some(sentinel.to_owned()),
        };

        let rendered = format!("{methods:?} {trace:?}");
        for forbidden in [
            sentinel,
            "AM360_UPLOAD_SENTINEL",
            "4c8a1e09",
            "d75fb263",
            "proxy.example",
            "s3.example",
        ] {
            assert!(
                !rendered.contains(forbidden),
                "upload config Debug leaked credential material: {rendered}"
            );
        }
        assert!(rendered.contains("credential_present: true"));
        assert!(rendered.contains("proxy_configured: true"));
    }
}
