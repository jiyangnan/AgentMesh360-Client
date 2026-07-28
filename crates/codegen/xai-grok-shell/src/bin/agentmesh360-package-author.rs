use std::path::PathBuf;

use anyhow::Result;
use clap::{Parser, Subcommand};
use xai_grok_shell::agentmesh360::package_authoring::{build_package, finalize_external_signature};
use xai_grok_shell::agentmesh360::package_release_authoring::assemble_offline_release;

#[derive(Debug, Parser)]
#[command(
    name = "agentmesh360-package-author",
    about = "Build deterministic AgentMesh360 Packages without handling private keys"
)]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Debug, Subcommand)]
enum Command {
    /// Build an unsigned Package, signing request, and Host Skill projection.
    Build {
        /// Directory containing agentmesh-agent.toml and agentmesh-authoring.toml.
        #[arg(long)]
        definition: PathBuf,
        /// Root of the Agent Skill source repository.
        #[arg(long)]
        source: PathBuf,
        /// New output directory. Existing directories are never overwritten.
        #[arg(long)]
        output: PathBuf,
        /// Public identifier of the external Ed25519 signing key.
        #[arg(long)]
        key_id: String,
    },
    /// Verify an external signature with its public key and create the envelope.
    Finalize {
        #[arg(long)]
        request: PathBuf,
        /// Exact Package artifact named in the signing request.
        #[arg(long)]
        artifact: PathBuf,
        #[arg(long)]
        signature_result: PathBuf,
        #[arg(long)]
        public_key: PathBuf,
        /// New envelope file. Existing files are never overwritten.
        #[arg(long)]
        output: PathBuf,
    },
    /// Assemble Host bundles, a Release Manifest, and an unpublished Registry record.
    AssembleRelease {
        #[arg(long)]
        request: PathBuf,
        #[arg(long)]
        artifact: PathBuf,
        #[arg(long)]
        signature_result: PathBuf,
        #[arg(long)]
        public_key: PathBuf,
        #[arg(long)]
        host_projection: PathBuf,
        /// New output directory. Existing directories are never overwritten.
        #[arg(long)]
        output: PathBuf,
        /// HTTPS candidate location used only to bind the unpublished Registry record.
        #[arg(long)]
        release_base_url: String,
    },
}

fn main() -> Result<()> {
    let cli = Cli::parse();
    let receipt = match cli.command {
        Command::Build {
            definition,
            source,
            output,
            key_id,
        } => {
            let receipt =
                build_package(&definition, &source, &key_id)?.write_to_new_directory(&output)?;
            serde_json::to_string(&receipt)?
        }
        Command::Finalize {
            request,
            artifact,
            signature_result,
            public_key,
            output,
        } => serde_json::to_string(&finalize_external_signature(
            &request,
            &artifact,
            &signature_result,
            &public_key,
            &output,
        )?)?,
        Command::AssembleRelease {
            request,
            artifact,
            signature_result,
            public_key,
            host_projection,
            output,
            release_base_url,
        } => serde_json::to_string(&assemble_offline_release(
            &request,
            &artifact,
            &signature_result,
            &public_key,
            &host_projection,
            &output,
            &release_base_url,
        )?)?,
    };
    println!("{receipt}");
    Ok(())
}

#[cfg(test)]
mod tests {
    use clap::CommandFactory as _;

    use super::*;

    #[test]
    fn cli_contract_is_valid_and_requires_a_subcommand() {
        Cli::command().debug_assert();
        assert!(Cli::try_parse_from(["agentmesh360-package-author"]).is_err());
        assert!(
            Cli::try_parse_from([
                "agentmesh360-package-author",
                "build",
                "--definition",
                "definition",
                "--source",
                "source",
                "--output",
                "output",
                "--key-id",
                "release-key",
            ])
            .is_ok()
        );
        assert!(
            Cli::try_parse_from([
                "agentmesh360-package-author",
                "assemble-release",
                "--request",
                "request.json",
                "--artifact",
                "package.ampkg.tar.zst",
                "--signature-result",
                "signature.json",
                "--public-key",
                "public-key.json",
                "--host-projection",
                "host-skills.json",
                "--output",
                "release-output",
                "--release-base-url",
                "https://packages.agentmesh360.invalid/e0/package/1.0.0",
            ])
            .is_ok()
        );
        assert!(
            Cli::try_parse_from([
                "agentmesh360-package-author",
                "finalize",
                "--request",
                "request.json",
                "--artifact",
                "package.ampkg.tar.zst",
                "--signature-result",
                "signature.json",
                "--public-key",
                "public-key.json",
                "--output",
                "package.signature.json",
            ])
            .is_ok()
        );
    }
}
