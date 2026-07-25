use agent_client_protocol as acp;
use anyhow::Result;
use serde::{Deserialize, Serialize};

use super::access::ClientAccess;
use super::agent_packages::validate_package_id_input;
use super::package_delivery::PackageDeliveryService;
use super::package_installer::{PackageStatusIssue, classify_package_error};
use super::package_registry_fetcher::PackageRegistryFetcher;

pub const REMOTE_REFRESH_METHOD: &str = "x.agentmesh360/agent-packages/remote-refresh";
pub const REMOTE_CATALOG_METHOD: &str = "x.agentmesh360/agent-packages/remote-catalog";
pub const DOWNLOAD_METHOD: &str = "x.agentmesh360/agent-packages/download";
pub const APPROVE_METHOD: &str = "x.agentmesh360/agent-packages/approve";
pub const ROLLBACK_METHOD: &str = "x.agentmesh360/agent-packages/rollback";
pub const RECONCILE_METHOD: &str = "x.agentmesh360/agent-packages/reconcile";

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct EmptyRequest {}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PackageIdRequest {
    package_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ApprovalRequest {
    approval_id: String,
}

#[derive(Clone, Copy)]
enum PackageOperation {
    Download,
    Approve,
    Rollback,
    Reconcile,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PackageOperationError {
    code: String,
    message: String,
}

pub(super) fn handles(method: &str) -> bool {
    matches!(
        method,
        REMOTE_CATALOG_METHOD
            | REMOTE_REFRESH_METHOD
            | DOWNLOAD_METHOD
            | APPROVE_METHOD
            | ROLLBACK_METHOD
            | RECONCILE_METHOD
    )
}

pub(super) async fn handle(
    delivery: &PackageDeliveryService,
    registry_fetcher: &PackageRegistryFetcher,
    access: &ClientAccess,
    args: &acp::ExtRequest,
) -> crate::extensions::ExtResult {
    access.require()?;
    match args.method.as_ref() {
        REMOTE_CATALOG_METHOD => {
            let _: EmptyRequest = crate::extensions::parse_params(args)?;
            crate::extensions::to_ext_response(Ok::<_, anyhow::Error>(
                registry_fetcher.discover(access),
            ))
        }
        REMOTE_REFRESH_METHOD => {
            let _: EmptyRequest = crate::extensions::parse_params(args)?;
            let status = registry_fetcher.refresh(access).await;
            package_response(Ok(status), PackageOperation::Reconcile)
        }
        DOWNLOAD_METHOD => {
            let request: PackageIdRequest = crate::extensions::parse_params(args)?;
            let package_id = checked_package_id(request.package_id)?;
            let result = delivery
                .download_or_request_approval(&package_id, access)
                .await;
            package_response(result, PackageOperation::Download)
        }
        APPROVE_METHOD => {
            let request: ApprovalRequest = crate::extensions::parse_params(args)?;
            package_response(
                delivery.approve_and_install(&request.approval_id, access),
                PackageOperation::Approve,
            )
        }
        ROLLBACK_METHOD => {
            let request: PackageIdRequest = crate::extensions::parse_params(args)?;
            let package_id = checked_package_id(request.package_id)?;
            package_response(
                delivery.rollback(&package_id, access),
                PackageOperation::Rollback,
            )
        }
        RECONCILE_METHOD => {
            let request: PackageIdRequest = crate::extensions::parse_params(args)?;
            let package_id = checked_package_id(request.package_id)?;
            package_response(
                delivery.reconcile_runtime_catalog(&package_id, access),
                PackageOperation::Reconcile,
            )
        }
        _ => Err(acp::Error::method_not_found()),
    }
}

fn checked_package_id(package_id: String) -> Result<String, acp::Error> {
    validate_package_id_input(&package_id)
        .map(|_| package_id)
        .map_err(|_| acp::Error::invalid_params().data("invalid Agent Package identifier"))
}

fn package_response<T: Serialize>(
    result: Result<T>,
    operation: PackageOperation,
) -> crate::extensions::ExtResult {
    match result {
        Ok(value) => crate::extensions::to_ext_response(Ok(value)),
        Err(error) => {
            let issue = operation_issue(operation, &error);
            tracing::warn!(
                operation = operation_name(operation),
                issue_code = %issue.code,
                "Agent Package management operation failed"
            );
            let response = crate::session::ExtMethodResult::<T> {
                result: None,
                error: Some(
                    serde_json::to_value(PackageOperationError {
                        code: issue.code,
                        message: issue.summary,
                    })
                    .expect("PackageOperationError is serializable"),
                ),
            };
            response
                .to_ext_response()
                .map_err(|error| acp::Error::internal_error().data(error.to_string()))
        }
    }
}

fn operation_issue(operation: PackageOperation, error: &anyhow::Error) -> PackageStatusIssue {
    if matches!(operation, PackageOperation::Download) {
        return PackageStatusIssue {
            code: "package_delivery_failed".into(),
            summary: "The Agent Package could not be downloaded and verified.".into(),
        };
    }
    let classified = classify_package_error(error);
    if classified.code != "package_validation_failed" {
        return classified;
    }
    let (code, summary) = match operation {
        PackageOperation::Download => unreachable!("download handled above"),
        PackageOperation::Approve => (
            "package_approval_unavailable",
            "The Agent Package approval is unavailable.",
        ),
        PackageOperation::Rollback => (
            "package_rollback_unavailable",
            "The Agent Package could not be rolled back.",
        ),
        PackageOperation::Reconcile => (
            "package_reconciliation_unavailable",
            "The Agent Package runtime state could not be reconciled.",
        ),
    };
    PackageStatusIssue {
        code: code.into(),
        summary: summary.into(),
    }
}

fn operation_name(operation: PackageOperation) -> &'static str {
    match operation {
        PackageOperation::Download => "download",
        PackageOperation::Approve => "approve",
        PackageOperation::Rollback => "rollback",
        PackageOperation::Reconcile => "reconcile",
    }
}
