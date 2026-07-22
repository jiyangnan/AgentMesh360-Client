use std::fmt;

use thiserror::Error;
use uuid::Uuid;
use zeroize::Zeroizing;

const HANDLE_PREFIX: &str = "credential://vault/h_";
#[cfg(target_os = "macos")]
const KEYCHAIN_SERVICE: &str = "com.agentmesh360.client.provider";

pub struct SecretValue(Zeroizing<String>);

impl SecretValue {
    pub fn new(value: String) -> Result<Self, CredentialVaultError> {
        let value = Zeroizing::new(value);
        let character_count = value.chars().count();
        if value.trim() != value.as_str() || !(8..=8192).contains(&character_count) {
            return Err(CredentialVaultError::InvalidSecret);
        }
        if value.as_bytes().contains(&0) {
            return Err(CredentialVaultError::InvalidSecret);
        }
        Ok(Self(value))
    }

    pub fn as_bytes(&self) -> &[u8] {
        self.0.as_bytes()
    }

    pub fn last_four(&self) -> String {
        let mut chars: Vec<char> = self.0.chars().rev().take(4).collect();
        chars.reverse();
        chars.into_iter().collect()
    }

    #[cfg(test)]
    pub(crate) fn expose_for_test(&self) -> &str {
        self.0.as_str()
    }
}

impl fmt::Debug for SecretValue {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("SecretValue([REDACTED])")
    }
}

#[derive(Clone, PartialEq, Eq)]
pub struct CredentialRef(String);

impl fmt::Debug for CredentialRef {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("CredentialRef([REDACTED])")
    }
}

impl CredentialRef {
    pub fn generate() -> Self {
        Self(format!("{HANDLE_PREFIX}{}", Uuid::new_v4().simple()))
    }

    pub fn parse(value: impl Into<String>) -> Result<Self, CredentialVaultError> {
        let value = value.into();
        let opaque = value
            .strip_prefix(HANDLE_PREFIX)
            .ok_or(CredentialVaultError::InvalidHandle)?;
        Uuid::parse_str(opaque).map_err(|_| CredentialVaultError::InvalidHandle)?;
        Ok(Self(value))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum CredentialVaultError {
    #[error("provider credential is empty or invalid")]
    InvalidSecret,
    #[error("provider credential handle is invalid")]
    InvalidHandle,
    #[error("provider credential was not found")]
    NotFound,
    #[error("provider credential vault is unavailable on this platform")]
    UnsupportedPlatform,
    #[error("provider credential vault is unavailable")]
    Unavailable,
}

pub trait CredentialVault {
    fn put(
        &self,
        credential_ref: &CredentialRef,
        secret: &SecretValue,
    ) -> Result<(), CredentialVaultError>;

    fn get(&self, credential_ref: &CredentialRef) -> Result<SecretValue, CredentialVaultError>;

    fn delete(&self, credential_ref: &CredentialRef) -> Result<(), CredentialVaultError>;
}

#[derive(Clone, Copy, Debug, Default)]
pub struct SystemCredentialVault;

#[cfg(target_os = "macos")]
impl CredentialVault for SystemCredentialVault {
    fn put(
        &self,
        credential_ref: &CredentialRef,
        secret: &SecretValue,
    ) -> Result<(), CredentialVaultError> {
        security_framework::passwords::set_generic_password(
            KEYCHAIN_SERVICE,
            credential_ref.as_str(),
            secret.as_bytes(),
        )
        .map_err(|_| CredentialVaultError::Unavailable)
    }

    fn get(&self, credential_ref: &CredentialRef) -> Result<SecretValue, CredentialVaultError> {
        let secret = Zeroizing::new(
            security_framework::passwords::get_generic_password(
                KEYCHAIN_SERVICE,
                credential_ref.as_str(),
            )
            .map_err(map_keychain_read_error)?,
        );
        let secret = std::str::from_utf8(&secret)
            .map_err(|_| CredentialVaultError::Unavailable)?
            .to_owned();
        SecretValue::new(secret)
    }

    fn delete(&self, credential_ref: &CredentialRef) -> Result<(), CredentialVaultError> {
        match security_framework::passwords::delete_generic_password(
            KEYCHAIN_SERVICE,
            credential_ref.as_str(),
        ) {
            Ok(()) => Ok(()),
            Err(error) if error.code() == -25300 => Ok(()),
            Err(_) => Err(CredentialVaultError::Unavailable),
        }
    }
}

#[cfg(target_os = "macos")]
fn map_keychain_read_error(error: security_framework::base::Error) -> CredentialVaultError {
    if error.code() == -25300 {
        CredentialVaultError::NotFound
    } else {
        CredentialVaultError::Unavailable
    }
}

#[cfg(not(target_os = "macos"))]
impl CredentialVault for SystemCredentialVault {
    fn put(
        &self,
        _credential_ref: &CredentialRef,
        _secret: &SecretValue,
    ) -> Result<(), CredentialVaultError> {
        Err(CredentialVaultError::UnsupportedPlatform)
    }

    fn get(&self, _credential_ref: &CredentialRef) -> Result<SecretValue, CredentialVaultError> {
        Err(CredentialVaultError::UnsupportedPlatform)
    }

    fn delete(&self, _credential_ref: &CredentialRef) -> Result<(), CredentialVaultError> {
        Err(CredentialVaultError::UnsupportedPlatform)
    }
}

#[cfg(test)]
pub struct MemoryCredentialVault {
    secrets: std::cell::RefCell<std::collections::HashMap<String, Zeroizing<Vec<u8>>>>,
}

#[cfg(test)]
impl Default for MemoryCredentialVault {
    fn default() -> Self {
        Self {
            secrets: std::cell::RefCell::new(std::collections::HashMap::new()),
        }
    }
}

#[cfg(test)]
impl MemoryCredentialVault {
    pub(crate) fn len(&self) -> usize {
        self.secrets.borrow().len()
    }
}

#[cfg(test)]
impl CredentialVault for MemoryCredentialVault {
    fn put(
        &self,
        credential_ref: &CredentialRef,
        secret: &SecretValue,
    ) -> Result<(), CredentialVaultError> {
        self.secrets.borrow_mut().insert(
            credential_ref.as_str().to_owned(),
            Zeroizing::new(secret.as_bytes().to_vec()),
        );
        Ok(())
    }

    fn get(&self, credential_ref: &CredentialRef) -> Result<SecretValue, CredentialVaultError> {
        let secrets = self.secrets.borrow();
        let secret = secrets
            .get(credential_ref.as_str())
            .ok_or(CredentialVaultError::NotFound)?;
        let secret = Zeroizing::new(secret.to_vec());
        let secret = std::str::from_utf8(&secret)
            .map_err(|_| CredentialVaultError::Unavailable)?
            .to_owned();
        SecretValue::new(secret)
    }

    fn delete(&self, credential_ref: &CredentialRef) -> Result<(), CredentialVaultError> {
        self.secrets.borrow_mut().remove(credential_ref.as_str());
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn opaque_handles_round_trip_in_the_test_vault() {
        let vault = MemoryCredentialVault::default();
        let credential_ref = CredentialRef::generate();
        let secret = SecretValue::new("sk-example-1234".into()).expect("secret");

        vault.put(&credential_ref, &secret).expect("store secret");
        assert_eq!(
            vault
                .get(&credential_ref)
                .expect("read secret")
                .expose_for_test(),
            "sk-example-1234"
        );
        assert_eq!(secret.last_four(), "1234");
        assert_eq!(format!("{secret:?}"), "SecretValue([REDACTED])");

        vault.delete(&credential_ref).expect("delete secret");
        assert_eq!(
            vault.get(&credential_ref).expect_err("secret is gone"),
            CredentialVaultError::NotFound
        );
    }

    #[test]
    fn rejects_caller_fabricated_handles() {
        assert_eq!(
            CredentialRef::parse("credential://vault/predictable").expect_err("invalid handle"),
            CredentialVaultError::InvalidHandle
        );
    }
}
